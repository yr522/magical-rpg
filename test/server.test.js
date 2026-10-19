// 서버를 실제로 띄우고 Socket.IO 클라이언트 두 개로 1~2단계 흐름을 확인한다.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: connect } = require('socket.io-client');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magical-rpg-test-'));
process.env.LOCAL_DB_FILE = path.join(tmpDir, 'db.json');
// 기본은 로컬 파일 저장소. TEST_DATABASE_URL을 주면 그 Postgres(빈 DB)로 테스트한다.
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
  server = createGameServer({ store, graceMs: 300 });
  const port = await server.listen(0);
  url = `http://localhost:${port}`;
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
  socket.next = (event) => new Promise((resolve) => socket.once(event, resolve));
  return new Promise((resolve) => socket.on('connect', () => resolve(socket)));
}

const newCharacter = (name, extra = {}) => ({
  name, gender: 'girl', element: 'light', classId: 'guardian', godId: 'god_vit', ...extra,
});

async function playerReady(nickname, charName) {
  const socket = await client();
  const reg = await socket.call('auth:register', { nickname, password: 'pass1234' });
  assert.ok(reg.ok, reg.error);
  const created = await socket.call('char:create', newCharacter(charName));
  assert.ok(created.ok, created.error);
  const entered = socket.next('game:enter');
  assert.ok((await socket.call('char:select', { id: created.character.id })).ok);
  return { socket, character: created.character, enter: await entered, token: reg.token };
}

test('회원가입 · 로그인 · 토큰 복귀', async () => {
  const a = await client();
  assert.match((await a.call('auth:register', { nickname: 'x', password: 'pass1234' })).error, /닉네임/);
  const reg = await a.call('auth:register', { nickname: '루미', password: 'pass1234' });
  assert.ok(reg.ok);
  assert.match((await a.call('auth:register', { nickname: '루미', password: 'other123' })).error, /이미/);

  const b = await client();
  assert.match((await b.call('auth:login', { nickname: '루미', password: 'wrong' })).error, /맞지 않습니다/);
  assert.ok((await b.call('auth:login', { nickname: '루미', password: 'pass1234' })).ok);

  const c = await client();
  assert.ok((await c.call('auth:resume', { token: reg.token })).ok);
  assert.ok((await c.call('auth:resume', { token: reg.token + 'x' })).error);
});

test('캐릭터 생성 시 스탯 계산과 검증', async () => {
  const s = await client();
  assert.ok((await s.call('char:list')).error, '로그인 전에는 막혀야 함');
  await s.call('auth:register', { nickname: '세라', password: 'pass1234' });

  const res = await s.call('char:create', newCharacter('세라핀', { classId: 'attacker', godId: 'god_mag' }));
  assert.ok(res.ok, res.error);
  // 기본 5 + 어태커(STR+2, MAG+2) + 마력의 신(MAG+3)
  assert.deepStrictEqual(res.character.baseStats, { str: 7, mag: 10, vit: 5, agi: 5, luk: 5 });
  // 기본 장비: 견습 마법봉(STR+1 MAG+1), 견습 리본(VIT+1), 견습 브로치(LUK+1) — 처음부터 장착
  assert.deepStrictEqual(res.character.stats, { str: 8, mag: 11, vit: 6, agi: 5, luk: 6 });
  assert.strictEqual(res.character.equipment.weapon.name, '견습 마법봉');
  assert.strictEqual(res.character.derived.maxHp, 50 + 6 * 10 + 5);
  assert.strictEqual(res.character.hp, res.character.derived.maxHp, '장비 포함 최대 HP로 시작');
  assert.strictEqual(res.character.derived.maxMp, 20 + 11 * 5);
  assert.strictEqual(res.character.locationId, 'hq_plaza');

  assert.match((await s.call('char:create', newCharacter('세라핀'))).error, /이미 있는/);
  assert.ok((await s.call('char:create', newCharacter('세라2', { element: 'poison' }))).error);
  assert.ok((await s.call('char:create', newCharacter('<b>'))).error);

  const list = await s.call('char:list');
  assert.strictEqual(list.characters.length, 1);
  assert.ok((await s.call('char:delete', { id: res.character.id })).ok);
  assert.strictEqual((await s.call('char:list')).characters.length, 0);
});

test('같은 구역 채팅 · 전체 채팅 · 이동 · 같은 구역 유저 표시', async () => {
  const a = await playerReady('플레이어A', '아리아');
  const b = await playerReady('플레이어B', '벨라');
  assert.strictEqual(b.enter.zone.id, 'hq_plaza');
  assert.ok(b.enter.players.some((p) => p.name === '아리아'));

  const heard = b.socket.next('chat');
  assert.ok((await a.socket.call('chat', { channel: 'zone', text: '  안녕   하세요 ' })).ok);
  const msg = await heard;
  assert.strictEqual(msg.text, '안녕 하세요');
  assert.strictEqual(msg.from.name, '아리아');

  // A가 이동하면 B의 목록에서 빠지고, 지역 채팅은 B에게 가지 않는다.
  const bPlayers = b.socket.next('zone:players');
  const moved = await a.socket.call('move', { to: 'park_gate' });
  assert.ok(moved.ok, moved.error);
  assert.strictEqual(moved.zone.region.id, 'park');
  assert.ok(!(await bPlayers).some((p) => p.name === '아리아'));
  assert.ok((await a.socket.call('move', { to: 'park_core' })).error, '인접하지 않은 구역은 이동 불가');

  let leaked = false;
  b.socket.on('chat', (m) => { if (m.channel === 'zone') leaked = true; });
  await a.socket.call('chat', { channel: 'zone', text: '공원이다' });
  const global = b.socket.next('chat');
  await a.socket.call('chat', { channel: 'global', text: '다들 안녕' });
  assert.strictEqual((await global).channel, 'global');
  assert.strictEqual(leaked, false);

  const look = await a.socket.call('look');
  assert.match(look.text, /다른 계약자는 없다/);

  // 이동한 위치는 저장된다.
  const list = await a.socket.call('char:list');
  assert.strictEqual(list.characters[0].locationId, 'park_gate');
});

test('채팅 도배 제한과 길이 제한', async () => {
  const { socket } = await playerReady('도배', '스팸');
  assert.match((await socket.call('chat', { channel: 'zone', text: 'a'.repeat(201) })).error, /200자/);
  const results = [];
  for (let i = 0; i < 6; i++) results.push(await socket.call('chat', { channel: 'zone', text: `${i}` }));
  assert.ok(results.slice(0, 5).every((r) => r.ok));
  assert.match(results[5].error, /너무 빨리/);
});

test('끊겨도 잠시 유지되고, 다시 들어오면 그 자리로 복귀', async () => {
  const a = await playerReady('재접속', '리나');
  await a.socket.call('move', { to: 'hq_shop' });
  const watcher = await playerReady('관찰자', '관찰');
  await watcher.socket.call('move', { to: 'hq_plaza' });
  await watcher.socket.call('move', { to: 'hq_shop' });

  const away = watcher.socket.next('zone:players');
  a.socket.disconnect();
  assert.ok((await away).find((p) => p.name === '리나').away);

  const again = await client();
  await again.call('auth:resume', { token: a.token });
  const entered = again.next('game:enter');
  await again.call('char:select', { id: a.character.id });
  const data = await entered;
  assert.strictEqual(data.resumed, true);
  assert.strictEqual(data.zone.id, 'hq_shop');

  // 다시 끊고 유예시간(테스트에선 0.3초)이 지나면 목록에서 사라진다.
  again.disconnect();
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(!server.online.has(a.character.id));
});

test('같은 캐릭터로 다른 창에서 접속하면 이전 창은 내보낸다', async () => {
  const a = await playerReady('두창', '하나');
  const second = await client();
  await second.call('auth:resume', { token: a.token });
  const kicked = a.socket.next('kicked');
  await second.call('char:select', { id: a.character.id });
  assert.match((await kicked).reason, /다른 곳/);
  assert.ok((await a.socket.call('chat', { channel: 'zone', text: 'hi' })).error);
  assert.ok((await second.call('chat', { channel: 'zone', text: 'hi' })).ok);
});

test('다른 사람 캐릭터는 고르거나 지울 수 없다', async () => {
  const a = await playerReady('주인', '주인캐');
  const thief = await client();
  await thief.call('auth:register', { nickname: '도둑', password: 'pass1234' });
  assert.ok((await thief.call('char:select', { id: a.character.id })).error);
  assert.ok((await thief.call('char:delete', { id: a.character.id })).error);
});

test('OC 프로필: 이름 중복 확인, 칭호 · 성별 · 설정 · 사진 두 장 · 대사 프리셋 저장', async () => {
  const s = await client();
  await s.call('auth:register', { nickname: '프로필러', password: 'pass1234' });
  const a = await s.call('char:create', { name: '프로필가', gender: 'girl', element: 'light', classId: 'attacker', godId: 'god_mag' });
  assert.ok(a.ok, a.error);
  await s.call('char:create', { name: '이미있음', gender: 'boy', element: 'water', classId: 'guardian', godId: 'god_vit' });
  await s.call('char:select', { id: a.character.id });

  assert.strictEqual((await s.call('profile:checkName', { name: '이미있음' })).available, false);
  assert.strictEqual((await s.call('profile:checkName', { name: '새이름' })).available, true);
  assert.match((await s.call('profile:update', { name: '이미있음' })).error, /이미/);

  // 커스텀 사진은 두 장 다 있어야 한다.
  const img = 'data:image/jpeg;base64,AAAA';
  assert.match((await s.call('profile:update', { photo: { avatar: img } })).error, /두 장/);
  assert.match((await s.call('profile:update', { title: '없는 칭호' })).error, /얻은 칭호/);
  const lines = { attack: ['간다!', '받아라!'], win: ['오늘도 무사해.'] };
  const res = await s.call('profile:update', { name: '새이름', gender: 'boy', title: '견습 계약자', text: '별을 좋아한다.', photo: { avatar: img, cutin: img }, lines });
  assert.ok(res.ok, res.error);
  assert.strictEqual(res.character.name, '새이름');
  assert.strictEqual(res.character.gender, 'boy');
  assert.strictEqual(res.character.cutinUrl, img);
  assert.deepStrictEqual(res.character.customLines, lines);
  assert.match((await s.call('profile:update', { lines: { attack: ['1', '2', '3', '4'] } })).error, /3개/);

  const view = await s.call('profile:view', { id: a.character.id });
  assert.strictEqual(view.profile.text, '별을 좋아한다.');
  assert.strictEqual(view.profile.equipment.weapon.name, '견습 마법봉');
  assert.strictEqual(view.profile.mine, true);
});
