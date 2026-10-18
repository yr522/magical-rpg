// 게임 서버 진입점. 웹 페이지를 보여 주고, Socket.IO로 실시간 명령을 처리한다.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');

const auth = require('./auth');
const game = require('./game');
const { Battle, MAX_PARTY } = require('./battle');
const { createStore } = require('./db');

const RECONNECT_GRACE_MS = 30 * 1000;
const CHAT_MAX_LENGTH = 200;
const CHAT_BURST = 5; // CHAT_WINDOW_MS 동안 보낼 수 있는 메시지 수
const CHAT_WINDOW_MS = 5000;
const ZONE_HISTORY = 30;
const GLOBAL_HISTORY = 50;
const MAX_CHARACTERS_PER_USER = 5;

const DEATH_GOLD_PENALTY = 0.1;

const zoneRoom = (zoneId) => `zone:${zoneId}`;
const battleRoom = (eventId) => `battle:${eventId}`;
const WORLD_ROOM = 'world';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// 화면 코드(public/)의 버전. 파일 내용이 바뀌면 값이 달라진다.
// 업데이트 뒤 예전 화면이 열린 채로 다시 연결되면, 브라우저가 이 값을 보고 스스로 새로고침한다.
function clientVersion() {
  const hash = crypto.createHash('sha256');
  for (const name of fs.readdirSync(PUBLIC_DIR).sort()) hash.update(name).update(fs.readFileSync(path.join(PUBLIC_DIR, name)));
  return hash.digest('hex').slice(0, 12);
}

// battleOptions: { rng, turnMs, monsterDelayMs } — 테스트에서 전투 속도와 난수를 고정할 때 쓴다.
function createGameServer({ store, graceMs = RECONNECT_GRACE_MS, battleOptions = {} }) {
  const rng = battleOptions.rng || Math.random;
  const app = express();
  app.get('/health', (_req, res) => res.send('ok'));
  // no-cache: 브라우저가 매번 서버에 최신 파일인지 확인한다 (게임 파일이 작아서 부담 없음).
  app.use(express.static(PUBLIC_DIR, { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
  const version = clientVersion();

  const httpServer = http.createServer(app);
  const io = new Server(httpServer);

  // 지금 게임 안에 있는 캐릭터들. characterId → { row, userId, socket, leaveTimer, battleId }
  const online = new Map();
  // 진행 중인 전투. eventId → Battle. 이벤트 자체는 events.json에 고정돼 있다.
  const battles = new Map();
  const events = new Map(game.eventList.map((e) => [e.id, e]));
  const chatHistory = { global: [], zones: new Map() };

  const playerSummary = (entry) => ({
    id: entry.row.id,
    name: entry.row.name,
    level: entry.row.level,
    class: entry.row.class,
    avatarUrl: entry.row.avatar_url || null,
    away: !entry.socket,
    inBattle: Boolean(entry.battleId),
  });

  const playersInZone = (zoneId) =>
    [...online.values()].filter((e) => e.row.location_id === zoneId).map(playerSummary);

  const sendPlayers = (zoneId) => io.to(zoneRoom(zoneId)).emit('zone:players', playersInZone(zoneId));

  const systemMessage = (zoneId, text) => io.to(zoneRoom(zoneId)).emit('log', { text });
  const notice = (text) => io.to(WORLD_ROOM).emit('notice', { text, at: Date.now() });

  const eventView = (ev, hereZoneId) => {
    const zone = game.zones.get(ev.zone);
    const battle = battles.get(ev.id);
    return {
      id: ev.id,
      label: ev.label,
      grade: ev.grade,
      monsterName: game.monsters.get(ev.monster).name,
      monsterLevel: game.monsters.get(ev.monster).level,
      zoneId: ev.zone,
      zoneName: zone.name,
      regionName: game.regions.get(zone.region).name,
      remaining: ev.permanent ? '무기한' : null,
      participants: battle ? battle.party.size : 0,
      max: MAX_PARTY,
      here: ev.zone === hereZoneId,
    };
  };
  const zoneEvents = (zoneId) => game.eventList.filter((e) => e.zone === zoneId).map((e) => eventView(e, zoneId));

  // 화면에 보낼 구역 정보 (고정 맵 + 지금 열린 토벌 이벤트).
  const zoneInfo = (zoneId) => ({ ...game.zoneView(zoneId), events: zoneEvents(zoneId) });

  const saveCharacter = (row) => store.updateCharacter(row.id, row);

  // ---------- 전투 연결 ----------

  const battleHooks = {
    onLog(battle, text) {
      io.to(battleRoom(battle.id)).emit('battle:log', { text });
    },
    onUpdate(battle) {
      for (const p of battle.party.values()) online.get(p.id)?.socket?.emit('battle:state', battle.view(p.id));
    },
    consumeItem: (characterId, code) => store.consumeItem(characterId, code),
    onLeave(battle, p, reason) {
      const entry = online.get(p.id);
      if (!entry) return;
      entry.battleId = null;
      entry.row.hp = Math.max(1, p.hp);
      entry.row.mp = p.mp;
      saveCharacter(entry.row).catch((err) => console.error('[battle:leave]', err));
      if (entry.socket) {
        entry.socket.leave(battleRoom(battle.id));
        if (reason === 'fled') {
          entry.socket.emit('battle:end', { result: 'fled', character: game.characterView(entry.row), zone: zoneInfo(entry.row.location_id) });
        }
      }
      sendPlayers(entry.row.location_id);
    },
    onEnd(battle, result, members) {
      battles.delete(battle.id);
      finishBattle(battle, result, members).catch((err) => console.error('[battle:end]', err));
    },
  };

  async function finishBattle(battle, result, members) {
    const def = battle.def;
    const zone = game.zones.get(battle.event.zone);
    for (const p of members) {
      const entry = online.get(p.id);
      if (!entry) continue;
      const row = entry.row;
      entry.battleId = null;
      const outcome = { result };
      if (result === 'victory') {
        // 경험치·골드는 참가 인원수로 똑같이 나누고, 아이템은 각자 확률 드롭.
        const exp = Math.floor(def.exp / members.length);
        const gold = Math.floor(def.gold / members.length);
        row.hp = Math.max(1, p.hp);
        row.mp = p.mp;
        row.gold += gold;
        const levels = game.gainExp(row, exp);
        const drops = def.drops.filter((d) => rng() < d.chance).map((d) => d.item);
        await store.addItems(row.id, drops);
        Object.assign(outcome, { exp, gold, levelUp: levels, items: drops.map((code) => game.items.get(code).name) });
      } else {
        // 전멸: 보유 골드 10% 손실, 본부로 귀환 (본부에서 HP/MP 회복).
        const lost = Math.floor(row.gold * DEATH_GOLD_PENALTY);
        row.gold -= lost;
        const from = row.location_id;
        row.location_id = game.characterData.startLocation;
        restoreFull(row);
        if (entry.socket) {
          entry.socket.leave(zoneRoom(from));
          entry.socket.join(zoneRoom(row.location_id));
        }
        systemMessage(from, `${row.name}이(가) 쓰러져 본부로 옮겨졌다.`);
        systemMessage(row.location_id, `${row.name}이(가) 본부로 실려 왔다.`);
        sendPlayers(from);
        Object.assign(outcome, { goldLost: lost, players: playersInZone(row.location_id), history: zoneHistory(row.location_id) });
      }
      await saveCharacter(row);
      outcome.character = game.characterView(row);
      outcome.zone = zoneInfo(row.location_id);
      if (entry.socket) {
        entry.socket.leave(battleRoom(battle.id));
        entry.socket.emit('battle:end', outcome);
      }
      sendPlayers(row.location_id);
    }
    const names = members.map((p) => p.name).join(', ');
    if (result === 'victory') {
      notice(`[토벌 완료] ${zone.name}의 ${def.name}을(를) ${names}이(가) 처치했다!`);
      if (battle.event.permanent) systemMessage(zone.id, `균열이 다시 꿈틀거린다… ${def.name}이(가) 또다시 형체를 갖춘다.`);
    } else if (result === 'defeat') {
      notice(`[토벌 실패] ${zone.name}에서 ${names}이(가) ${def.name}에게 쓰러졌다.`);
    }
  }

  function restoreFull(row) {
    const { maxHp, maxMp } = game.combatStats(row);
    row.hp = maxHp;
    row.mp = maxMp;
  }

  function leaveBattle(entry, reason) {
    if (entry.battleId) battles.get(entry.battleId)?.leave(entry.row.id, reason);
    entry.battleId = null;
  }

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
    leaveBattle(entry, 'leave');
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
      if (entry.battleId) socket.leave(battleRoom(entry.battleId));
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
      entry = { row, userId: socket.data.userId, socket: null, leaveTimer: null, battleId: null };
      online.set(row.id, entry);
    }
    entry.socket = socket;
    socket.data.characterId = row.id;
    socket.join(WORLD_ROOM);
    socket.join(zoneRoom(entry.row.location_id));

    const zoneId = entry.row.location_id;
    socket.emit('game:enter', {
      character: game.characterView(entry.row),
      zone: zoneInfo(zoneId),
      players: playersInZone(zoneId),
      history: { zone: zoneHistory(zoneId), global: chatHistory.global },
      resumed: !isNew,
    });
    const battle = entry.battleId && battles.get(entry.battleId);
    if (battle) {
      // 전투 중에 재접속하면 전투 화면으로 바로 돌아간다.
      socket.join(battleRoom(battle.id));
      socket.emit('battle:state', battle.view(row.id));
    }
    if (isNew) systemMessage(zoneId, `${row.name}이(가) 나타났다.`);
    sendPlayers(zoneId);
  }

  const currentEntry = (socket) => online.get(socket.data.characterId);

  io.on('connection', (socket) => {
    socket.emit('server:hello', { version });
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
      await store.addItems(row.id, game.characterData.startItems);
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
      if (entry.battleId) return reply({ error: '전투 중에는 이동할 수 없습니다.' });
      const from = game.zones.get(entry.row.location_id);
      if (!from.exits.some((e) => e.to === to)) return reply({ error: '그쪽으로는 갈 수 없습니다.' });

      entry.row.location_id = to;
      // 본부(안전지대)에 들어오면 HP/MP가 모두 회복된다.
      const { maxHp, maxMp } = game.combatStats(entry.row);
      const healed = game.regions.get(game.zones.get(to).region).safe && (entry.row.hp < maxHp || entry.row.mp < maxMp);
      if (healed) restoreFull(entry.row);
      await saveCharacter(entry.row);
      socket.leave(zoneRoom(from.id));
      systemMessage(from.id, `${entry.row.name}이(가) ${game.zones.get(to).name}(으)로 떠났다.`);
      sendPlayers(from.id);

      systemMessage(to, `${entry.row.name}이(가) 도착했다.`);
      socket.join(zoneRoom(to));
      reply({
        ok: true,
        zone: zoneInfo(to),
        players: playersInZone(to),
        history: zoneHistory(to),
        character: game.characterView(entry.row),
        healed,
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
      const entry = currentEntry(socket);
      if (!entry) return reply({ error: '캐릭터를 먼저 골라 주세요.' });
      reply({ ok: true, events: game.eventList.map((e) => eventView(e, entry.row.location_id)) });
    });

    on('raid:enter', async ({ eventId }, reply) => {
      const entry = currentEntry(socket);
      if (!entry) return reply({ error: '캐릭터를 먼저 골라 주세요.' });
      if (entry.battleId) return reply({ error: '이미 전투 중입니다.' });
      const ev = events.get(eventId);
      if (!ev) return reply({ error: '그런 토벌 이벤트는 없습니다.' });
      if (ev.zone !== entry.row.location_id) return reply({ error: `${game.zones.get(ev.zone).name}에 가야 입장할 수 있습니다.` });
      let battle = battles.get(ev.id);
      if (battle?.isFull()) return reply({ error: `이미 ${MAX_PARTY}명이 싸우고 있습니다. 전투가 끝나면 다시 시도해 주세요.` });

      const items = await store.listItems(entry.row.id);
      if (entry.battleId || !online.has(entry.row.id)) return reply({ error: '이미 전투 중입니다.' });
      battle = battles.get(ev.id);
      if (!battle) {
        battle = new Battle({ event: ev, hooks: battleHooks, rng, ...battleOptions });
        battles.set(ev.id, battle);
      } else if (battle.isFull()) {
        return reply({ error: `이미 ${MAX_PARTY}명이 싸우고 있습니다.` });
      }
      entry.battleId = ev.id;
      socket.join(battleRoom(ev.id));
      reply({ ok: true });
      battle.join(entry.row, items);
      systemMessage(ev.zone, `${entry.row.name}이(가) ${battle.def.name}에게 맞서 균열 속으로 들어갔다.`);
      sendPlayers(ev.zone);
    });

    on('battle:action', async (cmd, reply) => {
      const entry = currentEntry(socket);
      const battle = entry?.battleId && battles.get(entry.battleId);
      if (!battle) return reply({ error: '전투 중이 아닙니다.' });
      reply(await battle.act(entry.row.id, { action: cmd.action, skill: cmd.skill, item: cmd.item }));
    });

    on('stat:allocate', async ({ stat }, reply) => {
      const entry = currentEntry(socket);
      if (!entry) return reply({ error: '캐릭터를 먼저 골라 주세요.' });
      if (entry.battleId) return reply({ error: '전투 중에는 스탯을 분배할 수 없습니다.' });
      if (!game.STAT_KEYS.includes(stat)) return reply({ error: '알 수 없는 스탯입니다.' });
      if (entry.row.stat_points <= 0) return reply({ error: '남은 스탯 포인트가 없습니다.' });
      entry.row[stat] += 1;
      entry.row.stat_points -= 1;
      // 최대치가 오른 만큼 현재 HP/MP도 같이 올려 준다.
      if (stat === 'vit') entry.row.hp += 10;
      if (stat === 'mag') entry.row.mp += 5;
      await saveCharacter(entry.row);
      reply({ ok: true, character: game.characterView(entry.row) });
    });

    on('inventory:list', async (_payload, reply) => {
      const entry = currentEntry(socket);
      if (!entry) return reply({ error: '캐릭터를 먼저 골라 주세요.' });
      const owned = await store.listItems(entry.row.id);
      reply({
        ok: true,
        items: owned.filter((i) => game.items.has(i.code)).map((i) => {
          const item = game.items.get(i.code);
          return { id: item.id, name: item.name, kind: item.kind, desc: item.desc, count: i.count };
        }),
      });
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
      if (!['zone', 'global', 'battle'].includes(channel)) return reply({ error: '알 수 없는 채널입니다.' });
      if (channel === 'battle' && !entry.battleId) return reply({ error: '전투 중이 아닙니다.' });
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
      } else if (channel === 'battle') {
        // 전투 채팅은 참가자 프사 옆 말풍선으로 뜬다. 기록은 남기지 않는다.
        io.to(battleRoom(entry.battleId)).emit('chat', message);
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
    battles,
    async close() {
      for (const entry of online.values()) clearTimeout(entry.leaveTimer);
      for (const battle of battles.values()) battle.stop();
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
