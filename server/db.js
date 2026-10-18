// 저장소. DATABASE_URL이 있으면 Postgres(Supabase), 없으면 로컬 JSON 파일을 쓴다.
// 두 저장소는 똑같은 함수들을 제공하므로, 나머지 코드는 어느 쪽인지 몰라도 된다.
const fs = require('fs');
const path = require('path');

const CHARACTER_COLUMNS = [
  'user_id', 'name', 'gender', 'element', 'class', 'god', 'level', 'exp', 'gold',
  'str', 'mag', 'vit', 'agi', 'luk', 'stat_points', 'hp', 'mp', 'location_id',
];

// 게임 진행 중 바뀌는 캐릭터 컬럼. updateCharacter는 이 컬럼만 고친다.
const MUTABLE_COLUMNS = [
  'level', 'exp', 'gold', 'str', 'mag', 'vit', 'agi', 'luk', 'stat_points', 'hp', 'mp', 'location_id', 'starter_equipment',
];

const pickMutable = (fields) => Object.entries(fields).filter(([k]) => MUTABLE_COLUMNS.includes(k));

// 같은 코드의 아이템을 묶어 [{ code, count }]로 만든다.
function countItems(codes) {
  const counts = new Map();
  for (const code of codes) counts.set(code, (counts.get(code) || 0) + 1);
  return [...counts].map(([code, count]) => ({ code, count }));
}

// 새 아이템은 코드 문자열이나 { code, grade, options, slot, equipped } 둘 다 받는다.
const normalizeItem = (x) => (typeof x === 'string' ? { code: x } : x);

// 아이템 한 줄을 화면/게임 코드에서 쓰는 모양으로.
const itemRow = (r) => ({
  id: Number(r.id),
  code: r.item_code,
  grade: r.grade || null,
  options: r.options || {},
  equipped: Boolean(r.is_equipped),
  slot: r.slot || null,
});

function createPostgresStore(connectionString) {
  const { Pool } = require('pg');
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);
  const pool = new Pool({
    connectionString,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 5,
  });
  // pg는 BIGINT를 문자열로 돌려주므로 id를 숫자로 맞춘다.
  const withNumberIds = (row) => row && { ...row, id: Number(row.id), user_id: row.user_id && Number(row.user_id) };
  const isUniqueViolation = (err) => err.code === '23505';

  return {
    kind: 'postgres',
    async init() {
      const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
      await pool.query(sql);
    },
    async createUser(nickname, passwordHash) {
      try {
        const { rows } = await pool.query(
          'INSERT INTO users (nickname, password_hash) VALUES ($1, $2) RETURNING *',
          [nickname, passwordHash],
        );
        return withNumberIds(rows[0]);
      } catch (err) {
        if (isUniqueViolation(err)) return null;
        throw err;
      }
    },
    async getUserByNickname(nickname) {
      const { rows } = await pool.query('SELECT * FROM users WHERE lower(nickname) = lower($1)', [nickname]);
      return withNumberIds(rows[0]);
    },
    async getUserById(id) {
      const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
      return withNumberIds(rows[0]);
    },
    async listCharacters(userId) {
      const { rows } = await pool.query('SELECT * FROM characters WHERE user_id = $1 ORDER BY id', [userId]);
      return rows.map(withNumberIds);
    },
    async getCharacter(id) {
      const { rows } = await pool.query('SELECT * FROM characters WHERE id = $1', [id]);
      return withNumberIds(rows[0]);
    },
    async createCharacter(userId, character) {
      const values = CHARACTER_COLUMNS.map((c) => (c === 'user_id' ? userId : character[c]));
      const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
      try {
        const { rows } = await pool.query(
          `INSERT INTO characters (${CHARACTER_COLUMNS.join(', ')}) VALUES (${placeholders}) RETURNING *`,
          values,
        );
        return withNumberIds(rows[0]);
      } catch (err) {
        if (isUniqueViolation(err)) return null;
        throw err;
      }
    },
    async deleteCharacter(userId, id) {
      const { rowCount } = await pool.query('DELETE FROM characters WHERE id = $1 AND user_id = $2', [id, userId]);
      return rowCount > 0;
    },
    async updateLocation(id, locationId) {
      await pool.query('UPDATE characters SET location_id = $1 WHERE id = $2', [locationId, id]);
    },
    async updateCharacter(id, fields) {
      const entries = pickMutable(fields);
      if (!entries.length) return;
      const sets = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ');
      await pool.query(`UPDATE characters SET ${sets} WHERE id = $1`, [id, ...entries.map(([, v]) => v)]);
    },
    async addItems(ownerId, list, client = pool) {
      if (!list.length) return;
      const values = [];
      const tuples = list.map(normalizeItem).map((it) => {
        values.push(ownerId, it.code, it.grade || null, JSON.stringify(it.options || {}), it.slot || null, Boolean(it.equipped));
        const n = values.length;
        return `($${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}::jsonb, $${n - 1}, $${n})`;
      });
      await client.query(
        `INSERT INTO items (owner_id, item_code, grade, options, slot, is_equipped) VALUES ${tuples.join(', ')}`,
        values,
      );
    },
    async listItems(ownerId) {
      const { rows } = await pool.query('SELECT item_code FROM items WHERE owner_id = $1 AND NOT is_equipped ORDER BY id', [ownerId]);
      return countItems(rows.map((r) => r.item_code));
    },
    async listItemRows(ownerId) {
      const { rows } = await pool.query('SELECT * FROM items WHERE owner_id = $1 ORDER BY id', [ownerId]);
      return rows.map(itemRow);
    },
    // 골드 변경 + 아이템 삭제 + 아이템 추가를 한 번에(트랜잭션) 처리한다.
    // 지울 아이템이 내 것이 아니거나 장착 중이면 아무것도 바꾸지 않고 false.
    async applyChange(ownerId, { gold, removeIds = [], add = [] }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (removeIds.length) {
          const { rowCount } = await client.query(
            'DELETE FROM items WHERE owner_id = $1 AND id = ANY($2::bigint[]) AND NOT is_equipped',
            [ownerId, removeIds],
          );
          if (rowCount !== new Set(removeIds).size) {
            await client.query('ROLLBACK');
            return false;
          }
        }
        await this.addItems(ownerId, add, client);
        if (gold !== undefined) await client.query('UPDATE characters SET gold = $1 WHERE id = $2', [gold, ownerId]);
        await client.query('COMMIT');
        return true;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    // 장착: 같은 칸의 다른 장비를 빼고 이 장비를 낀다. 해제: equip=false.
    async setEquipped(ownerId, itemId, equip) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query('SELECT slot FROM items WHERE id = $1 AND owner_id = $2 FOR UPDATE', [itemId, ownerId]);
        if (!rows.length || !rows[0].slot) {
          await client.query('ROLLBACK');
          return false;
        }
        if (equip) {
          await client.query('UPDATE items SET is_equipped = false WHERE owner_id = $1 AND slot = $2 AND is_equipped', [ownerId, rows[0].slot]);
        }
        await client.query('UPDATE items SET is_equipped = $3 WHERE id = $1 AND owner_id = $2', [itemId, ownerId, equip]);
        await client.query('COMMIT');
        return true;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    // 아이템 하나를 없앤다. 실제로 하나 지웠을 때만 true (두 번 눌러도 하나만 쓰인다).
    async consumeItem(ownerId, code) {
      const { rowCount } = await pool.query(
        `DELETE FROM items WHERE id = (
           SELECT id FROM items WHERE owner_id = $1 AND item_code = $2 AND NOT is_equipped LIMIT 1 FOR UPDATE SKIP LOCKED
         )`,
        [ownerId, code],
      );
      return rowCount > 0;
    },
    async close() {
      await pool.end();
    },
  };
}

// 로컬 테스트용. 데이터가 파일 하나에 저장된다 (Render에서는 재시작 시 사라지므로 쓰지 말 것).
function createFileStore(filePath) {
  let data = { nextUserId: 1, nextCharacterId: 1, nextItemId: 1, users: [], characters: [], items: [] };
  const save = () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  };
  const lower = (s) => s.toLowerCase();
  const copy = (row) => row && { ...row };

  return {
    kind: 'file',
    filePath,
    async init() {
      if (fs.existsSync(filePath)) data = { ...data, ...JSON.parse(fs.readFileSync(filePath, 'utf8')) };
    },
    async createUser(nickname, passwordHash) {
      if (data.users.some((u) => lower(u.nickname) === lower(nickname))) return null;
      const user = { id: data.nextUserId++, nickname, password_hash: passwordHash, created_at: new Date().toISOString() };
      data.users.push(user);
      save();
      return copy(user);
    },
    async getUserByNickname(nickname) {
      return copy(data.users.find((u) => lower(u.nickname) === lower(nickname)));
    },
    async getUserById(id) {
      return copy(data.users.find((u) => u.id === id));
    },
    async listCharacters(userId) {
      return data.characters.filter((c) => c.user_id === userId).map(copy);
    },
    async getCharacter(id) {
      return copy(data.characters.find((c) => c.id === id));
    },
    async createCharacter(userId, character) {
      if (data.characters.some((c) => lower(c.name) === lower(character.name))) return null;
      const row = {
        id: data.nextCharacterId++,
        ...Object.fromEntries(CHARACTER_COLUMNS.map((c) => [c, c === 'user_id' ? userId : character[c]])),
        profile_text: '',
        avatar_url: null,
        starter_equipment: false,
        created_at: new Date().toISOString(),
      };
      data.characters.push(row);
      save();
      return copy(row);
    },
    async deleteCharacter(userId, id) {
      const before = data.characters.length;
      data.characters = data.characters.filter((c) => !(c.id === id && c.user_id === userId));
      if (data.characters.length === before) return false;
      data.items = data.items.filter((i) => i.owner_id !== id);
      save();
      return true;
    },
    async updateLocation(id, locationId) {
      const row = data.characters.find((c) => c.id === id);
      if (row) {
        row.location_id = locationId;
        save();
      }
    },
    async updateCharacter(id, fields) {
      const row = data.characters.find((c) => c.id === id);
      if (!row) return;
      for (const [k, v] of pickMutable(fields)) row[k] = v;
      save();
    },
    async addItems(ownerId, list, { skipSave = false } = {}) {
      if (!list.length) return;
      for (const it of list.map(normalizeItem)) {
        data.items.push({
          id: data.nextItemId++,
          owner_id: ownerId,
          item_code: it.code,
          grade: it.grade || null,
          options: it.options || {},
          enhance: 0,
          is_equipped: Boolean(it.equipped),
          slot: it.slot || null,
        });
      }
      if (!skipSave) save();
    },
    async listItems(ownerId) {
      return countItems(data.items.filter((i) => i.owner_id === ownerId && !i.is_equipped).map((i) => i.item_code));
    },
    async listItemRows(ownerId) {
      return data.items.filter((i) => i.owner_id === ownerId).map(itemRow);
    },
    async applyChange(ownerId, { gold, removeIds = [], add = [] }) {
      const ids = new Set(removeIds);
      const removable = data.items.filter((i) => ids.has(i.id) && i.owner_id === ownerId && !i.is_equipped);
      if (removable.length !== ids.size) return false;
      data.items = data.items.filter((i) => !removable.includes(i));
      await this.addItems(ownerId, add, { skipSave: true });
      if (gold !== undefined) {
        const row = data.characters.find((c) => c.id === ownerId);
        if (row) row.gold = gold;
      }
      save();
      return true;
    },
    async setEquipped(ownerId, itemId, equip) {
      const item = data.items.find((i) => i.id === itemId && i.owner_id === ownerId);
      if (!item || !item.slot) return false;
      if (equip) for (const i of data.items) if (i.owner_id === ownerId && i.slot === item.slot) i.is_equipped = false;
      item.is_equipped = equip;
      save();
      return true;
    },
    async consumeItem(ownerId, code) {
      const index = data.items.findIndex((i) => i.owner_id === ownerId && i.item_code === code && !i.is_equipped);
      if (index === -1) return false;
      data.items.splice(index, 1);
      save();
      return true;
    },
    async close() {},
  };
}

function createStore() {
  if (process.env.DATABASE_URL) return createPostgresStore(process.env.DATABASE_URL);
  return createFileStore(process.env.LOCAL_DB_FILE || path.join(__dirname, '..', 'data', 'local-db.json'));
}

module.exports = { createStore };
