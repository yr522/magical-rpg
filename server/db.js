// 저장소. DATABASE_URL이 있으면 Postgres(Supabase), 없으면 로컬 JSON 파일을 쓴다.
// 두 저장소는 똑같은 함수들을 제공하므로, 나머지 코드는 어느 쪽인지 몰라도 된다.
const fs = require('fs');
const path = require('path');

const CHARACTER_COLUMNS = [
  'user_id', 'name', 'gender', 'element', 'class', 'god', 'level', 'exp', 'gold',
  'str', 'mag', 'vit', 'agi', 'luk', 'stat_points', 'hp', 'mp', 'location_id',
];

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
    async close() {
      await pool.end();
    },
  };
}

// 로컬 테스트용. 데이터가 파일 하나에 저장된다 (Render에서는 재시작 시 사라지므로 쓰지 말 것).
function createFileStore(filePath) {
  let data = { nextUserId: 1, nextCharacterId: 1, users: [], characters: [] };
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
      if (fs.existsSync(filePath)) data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
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
    async close() {},
  };
}

function createStore() {
  if (process.env.DATABASE_URL) return createPostgresStore(process.env.DATABASE_URL);
  return createFileStore(process.env.LOCAL_DB_FILE || path.join(__dirname, '..', 'data', 'local-db.json'));
}

module.exports = { createStore };
