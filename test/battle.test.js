// 3단계: 토벌 이벤트 입장 · 턴제 전투 · 보상 · 레벨업 · 전멸.
// 난수를 0.5로 고정해 결과가 매번 같게 만든다 (회피·치명타 없음, 데미지 난수 ×1.0, 도주 성공).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: connect } = require('socket.io-client');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magical-rpg-battle-'));
process.env.LOCAL_DB_FILE = path.join(tmpDir, 'db.json');
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
else delete process.env.DATABASE_URL;

const { createGameServer } = require('../server/index');
const { createStore } = require('../server/db');
const { calcDamage } = require('../server/battle');
const game = require('../server/game');

const TURN_MS = 400;
let server;
let store;
let url;
const clients = [];

before(async () => {
  game.validateMap();
  store = createStore();
  await store.init();
  server = createGameServer({ requireInvite: false, store, graceMs: 300, battleOptions: { rng: () => 0.5, turnMs: TURN_MS, monsterDelayMs: 0 } });
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
  socket.latest = null;
  socket.ended = null;
  socket.on('battle:state', (v) => { socket.latest = v; });
  socket.on('battle:end', (v) => { socket.ended = v; });
  return new Promise((resolve) => socket.on('connect', () => resolve(socket)));
}

// 조건이 맞는 상태가 올 때까지 기다린다 (이미 맞으면 바로).
function until(socket, check, ms = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const value = check(socket);
      if (value) return resolve(value);
      if (Date.now() - start > ms) return reject(new Error('시간 초과'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

const myTurn = (s) => s.latest?.turn?.kind === 'player' && s.latest.turn.id === s.latest.me?.id && s.latest;

let counter = 0;
async function player(classId = 'attacker', godId = 'god_mag') {
  counter += 1;
  const s = await client();
  assert.ok((await s.call('auth:register', { nickname: `전투${counter}`, password: 'pass1234' })).ok);
  const created = await s.call('char:create', { name: `계약자${counter}`, gender: 'girl', element: 'light', classId, godId });
  assert.ok(created.ok, created.error);
  s.character = created.character;
  await s.call('char:select', { id: created.character.id });
  return s;
}

async function walkToRift(s) {
  for (const to of ['park_gate', 'park_trail', 'park_forest', 'park_core']) {
    const res = await s.call('move', { to });
    assert.ok(res.ok, res.error);
  }
}

test('데미지 공식: 최소 1, 면역은 0, 속성 배율 적용', () => {
  const rng = () => 0.5;
  assert.strictEqual(calcDamage({ atk: 15, coef: 1, def: 6, mult: 1, rng }), 12);
  assert.strictEqual(calcDamage({ atk: 15, coef: 1, def: 6, mult: 1.5, rng }), 18);
  assert.strictEqual(calcDamage({ atk: 1, coef: 1, def: 100, mult: 1, rng }), 1);
  assert.strictEqual(calcDamage({ atk: 50, coef: 1, def: 0, mult: 0, rng }), 0);
});

test('토벌 목록과 입장 조건', async () => {
  const s = await player();
  const list = await s.call('raid:list');
  assert.strictEqual(list.events.length, 1);
  assert.strictEqual(list.events[0].remaining, '무기한');
  assert.match((await s.call('raid:enter', { eventId: 'test_vine' })).error, /균열의 중심/);
  await walkToRift(s);
  const here = await s.call('raid:list');
  assert.strictEqual(here.events[0].here, true);
});

test('공격 · 스킬 · 쿨다운 · 아이템 · 승리 보상 · 레벨업', async () => {
  const s = await player();
  await walkToRift(s);
  assert.ok((await s.call('raid:enter', { eventId: 'test_vine' })).ok);
  assert.match((await s.call('move', { to: 'park_forest' })).error, /전투 중/);

  // AGI 5 > 몬스터 4 이므로 내가 먼저. 기본 장비(견습 마법봉 STR+1 MAG+1) 포함.
  // 기본 공격 = (STR8×2+1 − 방어6×0.5) = 14
  let v = await until(s, myTurn);
  assert.strictEqual(v.monster.hp, 160);
  assert.ok((await s.call('battle:action', { action: 'attack' })).ok);
  v = await until(s, (x) => myTurn(x) && x.latest.round === 2 && x.latest);
  assert.strictEqual(v.monster.hp, 146);
  assert.ok(v.party[0].hp < v.party[0].maxHp, '몬스터에게 맞았어야 함');

  // 별빛 일격: (MAG11×2+1)×1.6 − 3 = 33.8 → 34, MP 8 소모, 다음 차례엔 쿨다운
  assert.ok((await s.call('battle:action', { action: 'skill', skill: 'star_strike' })).ok);
  v = await until(s, (x) => myTurn(x) && x.latest.round === 3 && x.latest);
  assert.strictEqual(v.monster.hp, 112);
  assert.strictEqual(v.party[0].mp, v.party[0].maxMp - 8);
  assert.match((await s.call('battle:action', { action: 'skill', skill: 'star_strike' })).error, /아직/);
  assert.match((await s.call('battle:action', { action: 'skill', skill: 'rift_break' })).error, /쓸 수 없는/);

  // 회복 사탕 (시작 아이템 3개)
  assert.strictEqual(v.me.items.find((i) => i.id === 'heal_candy').count, 3);
  const hpBefore = v.party[0].hp;
  assert.ok((await s.call('battle:action', { action: 'item', item: 'heal_candy' })).ok);
  v = await until(s, (x) => myTurn(x) && x.latest.round === 4 && x.latest);
  assert.strictEqual(v.me.items.find((i) => i.id === 'heal_candy').count, 2);
  assert.ok(v.party[0].hp > hpBefore - 30, 'HP가 회복됐어야 함');

  // 끝날 때까지: 위험하면 사탕, 별빛 일격이 되면 쓰고, 아니면 공격.
  while (!s.ended) {
    const turn = await until(s, (x) => x.ended || myTurn(x), 5000);
    if (s.ended) break;
    const me = turn.party[0];
    const candy = turn.me.items.find((i) => i.id === 'heal_candy');
    const star = turn.me.skills.find((sk) => sk.id === 'star_strike');
    if (me.hp < 35 && candy) await s.call('battle:action', { action: 'item', item: 'heal_candy' });
    else if (star.usable) await s.call('battle:action', { action: 'skill', skill: 'star_strike' });
    else await s.call('battle:action', { action: 'attack' });
    s.latest = null;
  }
  const end = s.ended;
  assert.strictEqual(end.result, 'victory');
  assert.strictEqual(end.exp, 60);
  assert.strictEqual(end.gold, 40);
  assert.strictEqual(end.levelUp, 1);
  assert.deepStrictEqual(end.items.map((i) => i.name), ['균열 파편']); // 난수 0.5 → 확률 60%짜리만 나온다
  assert.strictEqual(end.character.level, 2);
  assert.strictEqual(end.character.exp, 10);
  assert.strictEqual(end.character.statPoints, 3);
  assert.strictEqual(end.character.hp, end.character.derived.maxHp, '레벨업 시 HP 전체 회복');
  assert.strictEqual(end.character.gold, 140);
  assert.ok(!server.battles.has('test_vine'), '전투가 끝나면 비워져야 함');

  // 저장 확인
  const saved = await store.getCharacter(s.character.id);
  assert.strictEqual(saved.level, 2);
  assert.strictEqual(saved.gold, 140);
  const inv = await s.call('inventory:list');
  assert.ok(inv.stacks.some((i) => i.code === 'rift_shard'));

  // 스탯 분배
  const alloc = await s.call('stat:allocate', { stat: 'vit' });
  assert.strictEqual(alloc.character.baseStats.vit, 6);
  assert.strictEqual(alloc.character.stats.vit, 7); // 견습 리본 VIT+1 포함
  assert.strictEqual(alloc.character.statPoints, 2);
  assert.strictEqual(alloc.character.hp, alloc.character.derived.maxHp);
  assert.ok((await s.call('stat:allocate', { stat: 'hp' })).error);

  // 상시 이벤트라 다시 입장할 수 있다.
  assert.ok((await s.call('raid:enter', { eventId: 'test_vine' })).ok);
  await until(s, myTurn);
  await s.call('battle:action', { action: 'flee' });
  await until(s, (x) => x.ended?.result === 'fled' && x.ended);
});

test('시간 초과면 자동 공격, 계속 방어만 하다 전멸하면 본부로 귀환 + 골드 10% 손실', async () => {
  const s = await player('attacker', 'god_str');
  await walkToRift(s);
  await s.call('raid:enter', { eventId: 'test_vine' });
  const logs = [];
  s.on('battle:log', ({ text }) => logs.push(text));
  await until(s, myTurn);
  await until(s, () => logs.some((t) => t.includes('시간 초과')), TURN_MS * 3);

  while (!s.ended) {
    await until(s, (x) => x.ended || myTurn(x), 5000);
    if (!s.ended) await s.call('battle:action', { action: 'defend' });
    s.latest = null;
  }
  assert.strictEqual(s.ended.result, 'defeat');
  assert.strictEqual(s.ended.goldLost, 10);
  assert.strictEqual(s.ended.character.gold, 90);
  assert.strictEqual(s.ended.zone.id, 'hq_plaza');
  assert.strictEqual(s.ended.character.hp, s.ended.character.derived.maxHp);
  const saved = await store.getCharacter(s.character.id);
  assert.strictEqual(saved.location_id, 'hq_plaza');
});

test('두 명이 같은 전투에 합류하고, 전투 채팅이 참가자에게만 간다', async () => {
  const a = await player('guardian', 'god_vit');
  const b = await player('supporter', 'god_mag');
  const outsider = await player();
  for (const s of [a, b, outsider]) await walkToRift(s);

  assert.ok((await a.call('raid:enter', { eventId: 'test_vine' })).ok);
  await until(a, (x) => x.latest);
  assert.ok((await b.call('raid:enter', { eventId: 'test_vine' })).ok);
  const view = await until(b, (x) => x.latest?.party.length === 2 && x.latest);
  assert.ok(view.me.skills.some((sk) => sk.id === 'healing_light'));

  const list = await outsider.call('raid:list');
  assert.strictEqual(list.events[0].participants, 2);
  assert.ok((await outsider.call('chat', { channel: 'battle', text: 'x' })).error);

  const heard = new Promise((resolve) => b.once('chat', resolve));
  let leaked = false;
  outsider.on('chat', (m) => { if (m.channel === 'battle') leaked = true; });
  assert.ok((await a.call('chat', { channel: 'battle', text: '내 뒤로 와!' })).ok);
  assert.strictEqual((await heard).text, '내 뒤로 와!');
  assert.strictEqual(leaked, false);

  // 가디언 도발 → 몬스터가 가디언만 노린다
  await until(a, myTurn);
  assert.ok((await a.call('battle:action', { action: 'skill', skill: 'provoke' })).ok);
  await until(a, (x) => x.latest?.party.find((p) => p.id === a.character.id).taunting && x.latest);

  // 한 명이 끊기면 유예시간 뒤 전투에서 빠진다
  a.disconnect();
  await until(b, (x) => x.latest?.party.length === 1 && x.latest, 3000);
  b.disconnect();
  await until(server, () => !server.battles.has('test_vine'), 3000);
});

test('전투 중 새로고침하면 전투 화면으로 돌아온다', async () => {
  const s = await player();
  await walkToRift(s);
  await s.call('raid:enter', { eventId: 'test_vine' });
  await until(s, (x) => x.latest);
  const token = (await s.call('auth:login', { nickname: `전투${counter}`, password: 'pass1234' })).token;
  s.disconnect();

  const again = await client();
  await again.call('auth:resume', { token });
  await again.call('char:select', { id: s.character.id });
  const v = await until(again, (x) => x.latest);
  assert.strictEqual(v.eventId, 'test_vine');
  assert.strictEqual(v.me.id, s.character.id);
  await again.call('char:leave');
  assert.ok(!server.battles.has('test_vine'));
});

test('본부에 들어오면 HP/MP 회복', async () => {
  const s = await player();
  await walkToRift(s);
  await s.call('raid:enter', { eventId: 'test_vine' });
  await until(s, myTurn);
  await s.call('battle:action', { action: 'attack' });
  await until(s, (x) => myTurn(x) && x.latest.round === 2);
  await s.call('battle:action', { action: 'flee' });
  const fled = await until(s, (x) => x.ended);
  assert.ok(fled.character.hp < fled.character.derived.maxHp);
  for (const to of ['park_forest', 'park_trail', 'park_gate']) await s.call('move', { to });
  const home = await s.call('move', { to: 'hq_plaza' });
  assert.strictEqual(home.healed, true);
  assert.strictEqual(home.character.hp, home.character.derived.maxHp);
});

test('대사 프리셋: 전투 시작 · 공격할 때 내 대사가 전투 채팅(말풍선)으로 나온다', async () => {
  const s = await player();
  assert.ok((await s.call('profile:update', { lines: { start: ['계약의 이름으로!'], attack: ['간다!'] } })).ok);
  const said = [];
  s.on('chat', (m) => { if (m.channel === 'battle' && m.preset) said.push(m.text); });
  await walkToRift(s);
  await s.call('raid:enter', { eventId: 'test_vine' });
  await until(s, myTurn);
  await s.call('battle:action', { action: 'attack' });
  await until(s, () => said.length >= 2);
  assert.deepStrictEqual(said.slice(0, 2), ['계약의 이름으로!', '간다!']);
  await s.call('char:leave'); // 다음 테스트가 빈 전투로 시작하게 나간다
});

test('파티 같이 입장: 같은 장소의 파티원이 모두 수락하면 다 같이 들어가고, 한 명이 거절하면 취소', async () => {
  const a = await player();
  const b = await player('supporter');
  for (const s of [a, b]) await walkToRift(s);
  const invited = new Promise((r) => b.once('party:invited', r));
  assert.ok((await a.call('party:invite', { name: b.character.name })).ok);
  await b.call('party:respond', { partyId: (await invited).partyId, accept: true });

  // 거절하면 취소
  let asked = new Promise((r) => b.once('raid:vote', r));
  assert.ok((await a.call('raid:partyStart', { eventId: 'test_vine' })).ok);
  await asked;
  const cancelled = new Promise((r) => a.once('raid:voteEnd', r));
  await b.call('raid:partyAnswer', { accept: false });
  assert.match((await cancelled).message, /거절/);
  assert.strictEqual(a.latest, null);

  // 모두 수락하면 같이 입장
  asked = new Promise((r) => b.once('raid:vote', r));
  assert.ok((await a.call('raid:partyStart', { eventId: 'test_vine' })).ok);
  await asked;
  await b.call('raid:partyAnswer', { accept: true });
  await until(a, (x) => x.latest?.party.length === 2);
  await until(b, (x) => x.latest?.party.length === 2);
  // 같이 들어왔으니 둘 다 1라운드부터 차례가 있다.
  assert.strictEqual(a.latest.round, 1);
  for (const s of [a, b]) await s.call('char:leave');
});
