// 게임 서버 진입점. 웹 페이지를 보여 주고, Socket.IO로 실시간 명령을 처리한다.
const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');

const auth = require('./auth');
const game = require('./game');
const { createStore } = require('./db');

const RECONNECT_GRACE_MS = 30 * 1000;
const CHAT_MAX_LENGTH = 200;
const CHAT_BURST = 5; // CHAT_WINDOW_MS 동안 보낼 수 있는 메시지 수
const CHAT_WINDOW_MS = 5000;
const ZONE_HISTORY = 30;
const GLOBAL_HISTORY = 50;
const MAX_CHARACTERS_PER_USER = 5;

const zoneRoom = (zoneId) => `zone:${zoneId}`;
const WORLD_ROOM = 'world';

function createGameServer({ store, graceMs = RECONNECT_GRACE_MS }) {
  const app = express();
  app.get('/health', (_req, res) => res.send('ok'));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const httpServer = http.createServer(app);
  const io = new Server(httpServer);

  // 지금 게임 안에 있는 캐릭터들. characterId → { row, userId, socket, leaveTimer }
  const online = new Map();
  const chatHistory = { global: [], zones: new Map() };

  const playerSummary = (entry) => ({
    id: entry.row.id,
    name: entry.row.name,
    level: entry.row.level,
    class: entry.row.class,
    avatarUrl: entry.row.avatar_url || null,
    away: !entry.socket,
  });

  const playersInZone = (zoneId) =>
    [...online.values()].filter((e) => e.row.location_id === zoneId).map(playerSummary);

  const sendPlayers = (zoneId) => io.to(zoneRoom(zoneId)).emit('zone:players', playersInZone(zoneId));

  const systemMessage = (zoneId, text) => io.to(zoneRoom(zoneId)).emit('log', { text });

  function pushHistory(list, message, limit) {
    list.push(message);
    if (list.length > limit) list.shift();
  }

  function zoneHistory(zoneId) {
    if (!chatHistory.zones.has(zoneId)) chatHistory.zones.set(zoneId, []);
    return chatHistory.zones.get(zoneId);
  }

  // 캐릭터를 게임에서 완전히 내보낸다 (자리 비움 시간 초과, 캐릭터 변경, 로그아웃).
  function removeFromWorld(characterId) {
    const entry = online.get(characterId);
    if (!entry) return;
    clearTimeout(entry.leaveTimer);
    if (entry.socket) detachSocket(entry.socket);
    online.delete(characterId);
    systemMessage(entry.row.location_id, `${entry.row.name}이(가) 떠났다.`);
    sendPlayers(entry.row.location_id);
  }

  function detachSocket(socket) {
    const characterId = socket.data.characterId;
    if (!characterId) return;
    const entry = online.get(characterId);
    if (entry) {
      socket.leave(zoneRoom(entry.row.location_id));
      if (entry.socket === socket) entry.socket = null;
    }
    socket.leave(WORLD_ROOM);
    socket.data.characterId = null;
  }

  function enterWorld(socket, row) {
    let entry = online.get(row.id);
    const isNew = !entry;
    if (entry) {
      // 30초 안에 재접속했거나, 다른 창에서 같은 캐릭터로 들어온 경우.
      clearTimeout(entry.leaveTimer);
      entry.leaveTimer = null;
      if (entry.socket && entry.socket !== socket) {
        const old = entry.socket;
        detachSocket(old);
        old.emit('kicked', { reason: '다른 곳에서 같은 캐릭터로 접속했습니다.' });
      }
    } else {
      entry = { row, userId: socket.data.userId, socket: null, leaveTimer: null };
      online.set(row.id, entry);
    }
    entry.socket = socket;
    socket.data.characterId = row.id;
    socket.join(WORLD_ROOM);
    socket.join(zoneRoom(entry.row.location_id));

    const zoneId = entry.row.location_id;
    socket.emit('game:enter', {
      character: game.characterView(entry.row),
      zone: game.zoneView(zoneId),
      players: playersInZone(zoneId),
      history: { zone: zoneHistory(zoneId), global: chatHistory.global },
      resumed: !isNew,
    });
    if (isNew) systemMessage(zoneId, `${row.name}이(가) 나타났다.`);
    sendPlayers(zoneId);
  }

  const currentEntry = (socket) => online.get(socket.data.characterId);

  io.on('connection', (socket) => {
    socket.data.userId = null;
    socket.data.characterId = null;
    socket.data.chatTimes = [];

    // 소켓 이벤트 처리 중 오류가 나도 서버가 죽지 않도록 감싼다.
    const on = (event, handler) => {
      socket.on(event, async (payload, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        try {
          await handler(payload || {}, reply);
        } catch (err) {
          console.error(`[${event}]`, err);
          reply({ error: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
        }
      });
    };

    const requireUser = (reply) => {
      if (!socket.data.userId) reply({ error: '로그인이 필요합니다.' });
      return Boolean(socket.data.userId);
    };

    const loggedIn = (user, reply) => {
      socket.data.userId = user.id;
      reply({ ok: true, token: auth.issueToken(user.id), nickname: user.nickname });
    };

    on('auth:register', async ({ nickname, password }, reply) => {
      const problem = auth.checkCredentials(nickname, password);
      if (problem) return reply({ error: problem });
      const user = await store.createUser(nickname, auth.hashPassword(password));
      if (!user) return reply({ error: '이미 쓰고 있는 닉네임입니다.' });
      loggedIn(user, reply);
    });

    on('auth:login', async ({ nickname, password }, reply) => {
      const user = typeof nickname === 'string' && (await store.getUserByNickname(nickname));
      if (!user || typeof password !== 'string' || !auth.verifyPassword(password, user.password_hash)) {
        return reply({ error: '닉네임 또는 비밀번호가 맞지 않습니다.' });
      }
      loggedIn(user, reply);
    });

    on('auth:resume', async ({ token }, reply) => {
      const userId = auth.readToken(token);
      const user = userId && (await store.getUserById(userId));
      if (!user) return reply({ error: '다시 로그인해 주세요.' });
      loggedIn(user, reply);
    });

    on('auth:logout', async (_payload, reply) => {
      if (socket.data.characterId) removeFromWorld(socket.data.characterId);
      socket.data.userId = null;
      reply({ ok: true });
    });

    on('char:options', async (_payload, reply) => {
      const { genders, elements, classes, gods, baseStats } = game.characterData;
      reply({ ok: true, options: { genders, elements, classes, gods, baseStats } });
    });

    on('char:list', async (_payload, reply) => {
      if (!requireUser(reply)) return;
      const rows = await store.listCharacters(socket.data.userId);
      reply({ ok: true, characters: rows.map(game.characterView) });
    });

    on('char:create', async (input, reply) => {
      if (!requireUser(reply)) return;
      const existing = await store.listCharacters(socket.data.userId);
      if (existing.length >= MAX_CHARACTERS_PER_USER) {
        return reply({ error: `캐릭터는 계정당 ${MAX_CHARACTERS_PER_USER}개까지 만들 수 있습니다.` });
      }
      const result = game.buildNewCharacter(input);
      if (result.error) return reply({ error: result.error });
      const row = await store.createCharacter(socket.data.userId, result.character);
      if (!row) return reply({ error: '이미 있는 캐릭터 이름입니다.' });
      reply({ ok: true, character: game.characterView(row) });
    });

    on('char:delete', async ({ id }, reply) => {
      if (!requireUser(reply)) return;
      const row = await store.getCharacter(Number(id));
      if (!row || row.user_id !== socket.data.userId) return reply({ error: '캐릭터를 찾을 수 없습니다.' });
      if (online.has(row.id)) {
        online.get(row.id).socket?.emit('kicked', { reason: '캐릭터가 삭제되었습니다.' });
        removeFromWorld(row.id);
      }
      await store.deleteCharacter(socket.data.userId, row.id);
      reply({ ok: true });
    });

    on('char:select', async ({ id }, reply) => {
      if (!requireUser(reply)) return;
      const row = await store.getCharacter(Number(id));
      if (!row || row.user_id !== socket.data.userId) return reply({ error: '캐릭터를 찾을 수 없습니다.' });
      if (socket.data.characterId && socket.data.characterId !== row.id) removeFromWorld(socket.data.characterId);
      if (!game.zones.has(row.location_id)) {
        // map.json에서 구역이 지워졌으면 시작 지점으로 돌려보낸다.
        row.location_id = game.characterData.startLocation;
        await store.updateLocation(row.id, row.location_id);
      }
      reply({ ok: true });
      enterWorld(socket, row);
    });

    on('char:leave', async (_payload, reply) => {
      if (socket.data.characterId) removeFromWorld(socket.data.characterId);
      reply({ ok: true });
    });

    on('move', async ({ to }, reply) => {
      const entry = currentEntry(socket);
      if (!entry) return reply({ error: '캐릭터를 먼저 골라 주세요.' });
      const from = game.zones.get(entry.row.location_id);
      if (!from.exits.some((e) => e.to === to)) return reply({ error: '그쪽으로는 갈 수 없습니다.' });

      await store.updateLocation(entry.row.id, to);
      socket.leave(zoneRoom(from.id));
      entry.row.location_id = to;
      systemMessage(from.id, `${entry.row.name}이(가) ${game.zones.get(to).name}(으)로 떠났다.`);
      sendPlayers(from.id);

      systemMessage(to, `${entry.row.name}이(가) 도착했다.`);
      socket.join(zoneRoom(to));
      reply({
        ok: true,
        zone: game.zoneView(to),
        players: playersInZone(to),
        history: zoneHistory(to),
        character: game.characterView(entry.row),
      });
      sendPlayers(to);
    });

    on('look', async (_payload, reply) => {
      const entry = currentEntry(socket);
      if (!entry) return reply({ error: '캐릭터를 먼저 골라 주세요.' });
      const zone = game.zones.get(entry.row.location_id);
      const others = playersInZone(zone.id).filter((p) => p.id !== entry.row.id).map((p) => p.name);
      const people = others.length ? `${others.join(', ')}이(가) 여기 있다.` : '주변에 다른 계약자는 없다.';
      reply({ ok: true, text: `${zone.look}\n${people}` });
    });

    on('raid:list', async (_payload, reply) => {
      if (!currentEntry(socket)) return reply({ error: '캐릭터를 먼저 골라 주세요.' });
      reply({ ok: true, events: [] }); // 토벌 이벤트는 3단계에서 만든다.
    });

    on('map:view', async (_payload, reply) => {
      const entry = currentEntry(socket);
      if (!entry) return reply({ error: '캐릭터를 먼저 골라 주세요.' });
      const here = game.zones.get(entry.row.location_id);
      reply({
        ok: true,
        regions: game.mapData.regions.map((r) => ({
          id: r.id,
          name: r.name,
          level: r.level,
          element: r.element,
          destruction: 0, // 지역 파괴는 나중 단계에서 만든다.
          here: r.id === here.region,
          zones: game.mapData.zones.filter((z) => z.region === r.id).map((z) => ({ id: z.id, name: z.name, here: z.id === here.id })),
        })),
      });
    });

    on('chat', async ({ channel, text }, reply) => {
      const entry = currentEntry(socket);
      if (!entry) return reply({ error: '캐릭터를 먼저 골라 주세요.' });
      if (channel !== 'zone' && channel !== 'global') return reply({ error: '알 수 없는 채널입니다.' });
      const clean = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
      if (!clean) return reply({ error: '내용을 입력해 주세요.' });
      if (clean.length > CHAT_MAX_LENGTH) return reply({ error: `채팅은 ${CHAT_MAX_LENGTH}자까지 보낼 수 있습니다.` });

      const now = Date.now();
      socket.data.chatTimes = socket.data.chatTimes.filter((t) => now - t < CHAT_WINDOW_MS);
      if (socket.data.chatTimes.length >= CHAT_BURST) return reply({ error: '너무 빨리 보내고 있어요. 잠시만 기다려 주세요.' });
      socket.data.chatTimes.push(now);

      const message = {
        channel,
        from: { id: entry.row.id, name: entry.row.name, avatarUrl: entry.row.avatar_url || null },
        text: clean,
        at: now,
      };
      if (channel === 'global') {
        pushHistory(chatHistory.global, message, GLOBAL_HISTORY);
        io.to(WORLD_ROOM).emit('chat', message);
      } else {
        message.zoneId = entry.row.location_id;
        pushHistory(zoneHistory(entry.row.location_id), message, ZONE_HISTORY);
        io.to(zoneRoom(entry.row.location_id)).emit('chat', message);
      }
      reply({ ok: true });
    });

    socket.on('disconnect', () => {
      const entry = currentEntry(socket);
      if (!entry || entry.socket !== socket) return;
      entry.socket = null;
      socket.data.characterId = null;
      sendPlayers(entry.row.location_id); // "자리 비움"으로 표시
      entry.leaveTimer = setTimeout(() => removeFromWorld(entry.row.id), graceMs);
    });
  });

  return {
    app,
    io,
    httpServer,
    online,
    listen(port) {
      return new Promise((resolve) => httpServer.listen(port, () => resolve(httpServer.address().port)));
    },
    async close() {
      for (const entry of online.values()) clearTimeout(entry.leaveTimer);
      io.close();
      await new Promise((resolve) => httpServer.close(() => resolve()));
    },
  };
}

async function main() {
  game.validateMap();
  const store = createStore();
  await store.init();
  const server = createGameServer({ store });
  const port = await server.listen(Number(process.env.PORT) || 3000);
  console.log(`[server] 저장소: ${store.kind === 'postgres' ? 'Postgres (DATABASE_URL)' : `로컬 파일 ${store.filePath}`}`);
  console.log(`[server] http://localhost:${port} 에서 실행 중`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createGameServer };
