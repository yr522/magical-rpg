// 4단계 일부: 기본 장비 · 인벤토리(장착/해제/사용/분해/버리기) · 상점(구매/판매) · 장비 드롭.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: connect } = require('socket.io-client');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magical-rpg-items-'));
process.env.LOCAL_DB_FILE = path.join(tmpDir, 'db.json');
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
else delete process.env.DATABASE_URL;

const { createGameServer } = require('../server/index');
const { createStore } = require('../server/db');
const game = require('../server/game');

let server;
let store;
let url;
const clients = [];

before(async () => {
  game.validateMap();
  store = createStore();
  await store.init();
  server = createGameServer({ store });
  url = `http://localhost:${await server.listen(0)}`;
});

after(async () => {
  for (const c of clients) c.close();
  await server.close();
  await store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function client() {
  const socket = connect(url, { transports: ['websocket'], reconnection: false });
  clients.push(socket);
  socket.call = (event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));
  return new Promise((resolve) => socket.on('connect', () => resolve(socket)));
}

let counter = 0;
async function player() {
  counter += 1;
  const s = await client();
  await s.call('auth:register', { nickname: `상인${counter}`, password: 'pass1234' });
  const created = await s.call('char:create', { name: `손님${counter}`, gender: 'boy', element: 'water', classId: 'guardian', godId: 'god_vit' });
  assert.ok(created.ok, created.error);
  s.character = created.character;
  await s.call('char:select', { id: created.character.id });
  return s;
}

const equipmentNamed = (inv, name) => inv.equipment.find((e) => e.name === name);
const stackOf = (inv, code) => inv.stacks.find((x) => x.code === code);

test('새 캐릭터는 기본 장비 3개를 끼고 시작한다', async () => {
  const s = await player();
  const inv = await s.call('inventory:list');
  assert.deepStrictEqual(inv.equipment.map((e) => [e.name, e.equipped, e.gradeName]), [
    ['견습 마법봉', true, '일반'],
    ['견습 리본', true, '일반'],
    ['견습 브로치', true, '일반'],
  ]);
  assert.strictEqual(stackOf(inv, 'heal_candy').count, 3);
  assert.strictEqual(inv.character.equipment.outfit.name, '견습 리본');
});

test('예전에 만든 캐릭터도 접속하면 기본 장비를 한 번만 받는다', async () => {
  const s = await client();
  const reg = await s.call('auth:register', { nickname: '옛날사람', password: 'pass1234' });
  const user = await store.getUserByNickname('옛날사람');
  const { character } = game.buildNewCharacter({ name: '옛캐릭', gender: 'girl', element: 'ice', classId: 'attacker', godId: 'god_str' });
  const row = await store.createCharacter(user.id, character); // 3단계 이전 방식 (장비 없음)
  assert.ok(reg.ok);
  await s.call('char:select', { id: row.id });
  let inv = await s.call('inventory:list');
  assert.strictEqual(inv.equipment.length, 3);
  await s.call('char:leave');
  await s.call('char:select', { id: row.id });
  inv = await s.call('inventory:list');
  assert.strictEqual(inv.equipment.length, 3, '두 번 받으면 안 됨');
});

test('상점: 상점 구역에서만, 살 때는 비싸게 팔 때는 싸게', async () => {
  const s = await player();
  assert.match((await s.call('shop:view')).error, /상점이 없습니다/);
  await s.call('move', { to: 'hq_shop' });
  const shop = await s.call('shop:view');
  assert.strictEqual(shop.name, '본부 상점');
  const candy = shop.goods.find((g) => g.code === 'heal_candy');
  assert.strictEqual(candy.price, 20);
  assert.strictEqual(stackOf(shop, 'heal_candy').sellPrice, 8, '판매가는 40%');

  let res = await s.call('shop:buy', { code: 'heal_candy', count: 2 });
  assert.ok(res.ok, res.error);
  assert.strictEqual(res.character.gold, 60);
  assert.strictEqual(stackOf(res, 'heal_candy').count, 5);
  assert.match((await s.call('shop:buy', { code: 'star_rod' })).error, /골드가 부족/);
  assert.match((await s.call('shop:buy', { code: 'thorn_wand' })).error, /팔지 않는/);
  assert.ok((await s.call('shop:buy', { code: 'heal_candy', count: 0 })).error);

  res = await s.call('shop:sell', { code: 'heal_candy' });
  assert.strictEqual(res.character.gold, 68);
  assert.strictEqual(stackOf(res, 'heal_candy').count, 4);

  // 장착 중인 장비는 못 판다 → 벗고 판다
  const wand = equipmentNamed(res, '견습 마법봉');
  assert.match((await s.call('shop:sell', { id: wand.id })).error, /먼저 벗어야/);
  res = await s.call('inventory:unequip', { id: wand.id });
  assert.strictEqual(res.character.equipment.weapon, null);
  assert.strictEqual(res.character.stats.str, res.character.baseStats.str);
  res = await s.call('shop:sell', { id: wand.id });
  assert.strictEqual(res.character.gold, 68 + 12); // 30 × 0.4

  // 저장 확인
  const saved = await store.getCharacter(s.character.id);
  assert.strictEqual(saved.gold, 80);
});

test('빠르게 여러 번 눌러도 한 번만 팔린다', async () => {
  const s = await player();
  await s.call('move', { to: 'hq_shop' });
  const results = await Promise.all(Array.from({ length: 5 }, () => s.call('shop:sell', { code: 'heal_candy' })));
  assert.strictEqual(results.filter((r) => r.ok).length, 3, '사탕은 3개뿐');
  const inv = await s.call('inventory:list');
  assert.strictEqual(inv.character.gold, 100 + 8 * 3);
  assert.strictEqual(stackOf(inv, 'heal_candy'), undefined);
});

test('장착 교체 · 사용 · 분해 · 버리기', async () => {
  const s = await player();
  await s.call('move', { to: 'hq_shop' });
  let res = await s.call('shop:buy', { code: 'apprentice_wand' });
  const spare = res.equipment.find((e) => e.name === '견습 마법봉' && !e.equipped);
  const worn = res.equipment.find((e) => e.name === '견습 마법봉' && e.equipped);

  // 같은 칸에 끼면 원래 장비는 벗겨진다
  res = await s.call('inventory:equip', { id: spare.id });
  assert.strictEqual(res.equipment.find((e) => e.id === spare.id).equipped, true);
  assert.strictEqual(res.equipment.find((e) => e.id === worn.id).equipped, false);
  assert.strictEqual(res.equipment.filter((e) => e.equipped && e.slot === 'weapon').length, 1);

  // 분해: 일반 등급은 균열 파편 1개
  res = await s.call('inventory:disassemble', { id: worn.id });
  assert.ok(res.ok, res.error);
  assert.match(res.message, /균열 파편 1개/);
  assert.strictEqual(stackOf(res, 'rift_shard').count, 1);
  assert.ok(!res.equipment.some((e) => e.id === worn.id));
  assert.match((await s.call('inventory:disassemble', { code: 'heal_candy' })).error, /장비만/);

  // 버리기
  const brooch = equipmentNamed(res, '견습 브로치');
  assert.match((await s.call('inventory:discard', { id: brooch.id })).error, /먼저 벗어야/);
  await s.call('inventory:unequip', { id: brooch.id });
  res = await s.call('inventory:discard', { id: brooch.id });
  assert.ok(!equipmentNamed(res, '견습 브로치'));
  res = await s.call('inventory:discard', { code: 'rift_shard' });
  assert.strictEqual(stackOf(res, 'rift_shard'), undefined);

  // 사용: HP가 가득 차 있으면 안 쓴다
  assert.match((await s.call('inventory:use', { code: 'heal_candy' })).error, /가득/);
  assert.match((await s.call('inventory:use', { code: 'rift_core' })).error, /사용할 수 없는/);

  // 다른 사람 아이템은 건드릴 수 없다
  const other = await player();
  const otherInv = await other.call('inventory:list');
  assert.ok((await s.call('inventory:equip', { id: otherInv.equipment[0].id })).error);
  assert.ok((await s.call('inventory:discard', { id: otherInv.equipment[0].id })).error);
});

test('장비 드롭: 등급은 허용된 등급 중에서, 고급은 옵션 1개', () => {
  const drops = game.monsters.get('vine_devourer').drops;
  assert.deepStrictEqual(game.rollDrops(drops, () => 0.99), []);
  const all = game.rollDrops(drops, () => 0.01);
  const equipment = all.filter((d) => d.grade);
  assert.strictEqual(equipment.length, 4);
  assert.ok(equipment.every((d) => d.grade === 'common' && Object.keys(d.options).length === 0));

  // 등급 굴림 0.8 → 55:28 중 고급
  const seq = [0.8, 0.0];
  const inst = game.rollEquipment('thorn_wand', ['common', 'uncommon'], () => seq.shift() ?? 0);
  assert.strictEqual(inst.grade, 'uncommon');
  assert.deepStrictEqual(inst.options, { str: 1 });
  const view = game.itemView(inst, game.shops.get('hq_shop'));
  assert.strictEqual(view.stats.mag, 5); // 4 × 1.2 = 4.8 → 5
  assert.strictEqual(view.stats.str, 1); // 추가 옵션
  // 고급 장비는 같은 일반 장비보다 비싸게 팔린다
  const common = game.itemView({ code: 'thorn_wand', grade: 'common', options: {} }, game.shops.get('hq_shop'));
  assert.ok(view.sellPrice > common.sellPrice);
});

test('장비가 전투 스탯에 들어간다', async () => {
  const s = await player();
  const inv = await s.call('inventory:list');
  const ribbon = equipmentNamed(inv, '견습 리본');
  const before = inv.character.derived.maxHp;
  const res = await s.call('inventory:unequip', { id: ribbon.id });
  assert.strictEqual(res.character.derived.maxHp, before - 10);
  assert.ok(res.character.hp <= res.character.derived.maxHp, 'HP가 최대치를 넘지 않음');
});

test('장신구는 장신구 2 칸에도 끼고, 가방이 100칸을 넘으면 살 수 없다', async () => {
  const s = await player();
  assert.ok((await s.call('move', { to: 'hq_shop' })).ok);
  assert.ok((await s.call('shop:buy', { code: 'wind_bell' })).ok);
  let inv = await s.call('inventory:list');
  const bell = inv.equipment.find((e) => e.code === 'wind_bell');
  assert.ok((await s.call('inventory:equip', { id: bell.id })).ok);
  inv = await s.call('inventory:list');
  // 장신구 칸은 견습 브로치가 쓰고 있으니 비어 있는 장신구 2 칸으로 들어간다.
  assert.strictEqual(inv.character.equipment.accessory.name, '견습 브로치');
  assert.strictEqual(inv.character.equipment.accessory2.name, '바람 방울');
  assert.strictEqual(inv.bag.size, 100);

  // 같은 장비도 한 칸씩 → 가방을 100칸까지 채우면 더 못 산다.
  const used = inv.bag.used;
  await store.addItems(s.character.id, Array.from({ length: 100 - used }, () => ({ code: 'steel_baton', grade: 'common', options: {}, slot: 'weapon' })));
  inv = await s.call('inventory:list');
  assert.strictEqual(inv.bag.used, 100);
  const full = await s.call('shop:buy', { code: 'steel_baton' });
  assert.match(full.error, /가방이 가득/);
  // 이미 가방에 있는 사탕은 같은 칸에 겹치므로 칸이 늘지 않는다.
  const rows = await store.listItemRows(s.character.id);
  assert.strictEqual(game.bagCellsAfter(rows, ['heal_candy']), 100);
  assert.strictEqual(game.bagCellsAfter(rows, ['mana_jelly']), 101);
});
