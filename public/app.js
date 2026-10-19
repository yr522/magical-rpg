// 브라우저 화면 코드. 서버가 보내 준 데이터를 화면에 그리고, 누른 버튼만 서버로 보낸다.
(() => {
  const $ = (id) => document.getElementById(id);
  const socket = io();

  // 브라우저 저장소는 막혀 있을 수도 있어서 실패해도 동작하게 감싼다.
  const storage = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* 무시 */ } },
  };

  const STAT_NAMES = { str: '힘 (STR)', mag: '마력 (MAG)', vit: '체력 (VIT)', agi: '민첩 (AGI)', luk: '행운 (LUK)' };
  const state = {
    token: storage.get('token'),
    nickname: null,
    options: null,
    characters: [],
    character: null, // 게임 중인 캐릭터
    zone: null,
    activeCharacterId: Number(storage.get('activeCharacterId')) || null,
    draft: {},
    battle: null, // 전투 중이면 서버가 보낸 전투 화면 데이터
    battleMenu: 'main', // main / skill / item
    fieldMenu: 'main', // main / move
    bubbles: new Map(), // 캐릭터 id → { text, until } 말풍선
  };

  // ---------- 공통 ----------
  function request(event, payload = {}) {
    return new Promise((resolve) => socket.emit(event, payload, (res) => resolve(res || { error: '응답이 없습니다.' })));
  }

  function show(screen) {
    for (const el of document.querySelectorAll('.screen')) el.classList.add('hidden');
    $(`screen-${screen}`).classList.remove('hidden');
  }

  let toastTimer;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) if (child) node.append(child);
    return node;
  }

  function avatar(name, url, small) {
    const box = el('span', { class: small ? 'avatar small' : 'avatar' });
    if (url) box.append(el('img', { src: url, alt: '' }));
    else box.textContent = (name || '?').slice(0, 1);
    return box;
  }

  const optionName = (list, id) => (state.options?.[list].find((o) => o.id === id) || {}).name || id;

  function openModal(content) {
    $('modal-content').replaceChildren(content);
    $('modal').classList.remove('hidden');
  }
  $('modal-close').addEventListener('click', () => $('modal').classList.add('hidden'));

  // ---------- 접속 / 로그인 ----------
  // 처음 접속했을 때의 서버 버전을 기억해 두고, 다시 연결됐을 때 버전이 바뀌었으면
  // (서버가 업데이트됨) 새 화면을 받도록 새로고침한다. 게임 중이면 같은 캐릭터로 돌아온다.
  let serverVersion = null;
  socket.on('server:hello', ({ version }) => {
    if (serverVersion && serverVersion !== version) location.reload();
    serverVersion = version;
  });

  socket.on('connect', async () => {
    $('connection').classList.add('hidden');
    if (!state.options) state.options = (await request('char:options')).options;
    if (!state.token) return show('auth');
    const res = await request('auth:resume', { token: state.token });
    if (res.error) {
      setToken(null);
      return show('auth');
    }
    state.nickname = res.nickname;
    setToken(res.token);
    // 끊기기 전에 게임 중이었다면 같은 캐릭터로 바로 복귀한다 (30초 안이면 그 자리 그대로).
    if (state.activeCharacterId) {
      const sel = await request('char:select', { id: state.activeCharacterId });
      if (!sel.error) return;
      setActiveCharacter(null);
    }
    openSelect();
  });

  socket.on('disconnect', () => $('connection').classList.remove('hidden'));
  socket.io.on('reconnect_attempt', () => $('connection').classList.remove('hidden'));

  function setToken(token) {
    state.token = token;
    storage.set('token', token);
  }

  function setActiveCharacter(id) {
    state.activeCharacterId = id;
    storage.set('activeCharacterId', id == null ? null : String(id));
  }

  $('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const mode = e.submitter?.dataset.mode || 'login';
    const form = new FormData(e.target);
    const res = await request(mode === 'register' ? 'auth:register' : 'auth:login', {
      nickname: form.get('nickname').trim(),
      password: form.get('password'),
    });
    if (res.error) return ($('auth-error').textContent = res.error);
    $('auth-error').textContent = '';
    e.target.reset();
    state.nickname = res.nickname;
    setToken(res.token);
    openSelect();
  });

  async function logout() {
    await request('auth:logout');
    setToken(null);
    setActiveCharacter(null);
    state.character = null;
    show('auth');
  }
  $('logout-from-select').addEventListener('click', logout);

  // ---------- 캐릭터 선택 ----------
  async function openSelect() {
    $('select-nickname').textContent = state.nickname;
    $('select-error').textContent = '';
    const res = await request('char:list');
    if (res.error) return ($('select-error').textContent = res.error);
    state.characters = res.characters;
    const list = $('character-list');
    list.replaceChildren();
    if (!state.characters.length) list.append(el('li', { class: 'muted', text: '아직 캐릭터가 없습니다. 새로 만들어 보세요.' }));
    for (const ch of state.characters) {
      list.append(el('li', {}, [
        avatar(ch.name, ch.avatarUrl),
        el('div', { class: 'info' }, [
          el('div', { text: `${ch.name}  Lv.${ch.level}` }),
          el('div', { class: 'muted', text: `${optionName('genders', ch.gender)} · ${optionName('classes', ch.class)} · ${ch.locationName}` }),
        ]),
        el('button', { text: '시작', onclick: () => selectCharacter(ch.id) }),
        el('button', { class: 'danger', text: '삭제', onclick: () => deleteCharacter(ch) }),
      ]));
    }
    show('select');
  }

  async function selectCharacter(id) {
    const res = await request('char:select', { id });
    if (res.error) $('select-error').textContent = res.error;
  }

  async function deleteCharacter(ch) {
    if (!confirm(`${ch.name}을(를) 정말 삭제할까요? 되돌릴 수 없습니다.`)) return;
    const res = await request('char:delete', { id: ch.id });
    if (res.error) return ($('select-error').textContent = res.error);
    if (state.activeCharacterId === ch.id) setActiveCharacter(null);
    openSelect();
  }

  // ---------- 캐릭터 생성 ----------
  $('go-create').addEventListener('click', openCreate);
  $('cancel-create').addEventListener('click', openSelect);

  function openCreate() {
    const o = state.options;
    state.draft = { gender: o.genders[0].id, element: o.elements[0].id, classId: o.classes[0].id, godId: o.gods[0].id };
    const lists = { gender: o.genders, element: o.elements, classId: o.classes, godId: o.gods };
    for (const box of document.querySelectorAll('#create-form .choices')) {
      const field = box.dataset.field;
      box.replaceChildren(...lists[field].map((opt) =>
        el('button', { type: 'button', 'data-id': opt.id, text: opt.name, onclick: () => { state.draft[field] = opt.id; renderCreate(); } })));
    }
    $('create-form').reset();
    $('create-error').textContent = '';
    renderCreate();
    show('create');
  }

  function renderCreate() {
    const o = state.options;
    for (const box of document.querySelectorAll('#create-form .choices')) {
      for (const btn of box.children) btn.classList.toggle('selected', btn.dataset.id === state.draft[box.dataset.field]);
    }
    const cls = o.classes.find((c) => c.id === state.draft.classId);
    const god = o.gods.find((g) => g.id === state.draft.godId);
    $('class-desc').textContent = cls.desc;

    // 미리보기일 뿐이고, 실제 값은 서버가 같은 규칙으로 다시 계산한다.
    const stats = { ...o.baseStats };
    const bonus = {};
    for (const [k, v] of Object.entries(cls.bonus)) bonus[k] = (bonus[k] || 0) + v;
    bonus[god.stat] = (bonus[god.stat] || 0) + god.bonus;
    for (const [k, v] of Object.entries(bonus)) stats[k] += v;
    const level = 1;
    const derived = {
      '최대 HP': 50 + stats.vit * 10 + level * 5,
      '최대 MP': 20 + stats.mag * 5,
      '회피율': `${Math.min(30, stats.agi * 0.5)}%`,
      '치명타율': `${Math.min(25, stats.luk * 0.5)}%`,
    };
    const rows = Object.keys(STAT_NAMES).map((k) => el('tr', {}, [
      el('td', { text: STAT_NAMES[k] }),
      el('td', {}, [String(stats[k]), bonus[k] ? el('span', { class: 'bonus', text: ` (+${bonus[k]})` }) : null]),
    ]));
    for (const [k, v] of Object.entries(derived)) rows.push(el('tr', {}, [el('td', { text: k }), el('td', { text: String(v) })]));
    $('stat-preview').replaceChildren(...rows);
  }

  $('create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = new FormData(e.target).get('name').trim();
    const res = await request('char:create', { ...state.draft, name });
    if (res.error) return ($('create-error').textContent = res.error);
    openSelect();
  });

  // ---------- 게임 화면 공통 (필드 · 전투) ----------
  const ICONS = {
    move: 'M5 12h14M13 6l6 6-6 6',
    look: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
    raids: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
    sword: 'M14.5 4.5L20 4l-.5 5.5L9 20l-5-5zM7 13l4 4',
    skill: 'M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z',
    item: 'M9 3h6M10 3v5l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3',
    flee: 'M15 12H3M7 8l-4 4 4 4M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4',
    shop: 'M4 7h16l-1 4H5zM5 11v8h14v-8M9 19v-5h6v5',
    back: 'M19 12H5M11 6l-6 6 6 6',
  };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(path, size = 22) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', path);
    svg.append(p);
    return svg;
  }
  // 사진이 없을 때 쓰는 사람 모양 (정사각형 프사 / 반신 컷인)
  function silhouette(kind) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    const shapes = {
      square: ['0 0 100 100', 'xMidYMid meet', '<circle cx="50" cy="40" r="18"/><path d="M14 100c0-22 16-38 36-38s36 16 36 38z"/>'],
      half: ['0 0 100 200', 'xMidYMin slice', '<circle cx="50" cy="46" r="24"/><path d="M42 68h16v12H42z"/><path d="M8 200V112c0-18 14-30 30-32h24c16 2 30 14 30 32v88z"/>'],
      bust: ['0 0 100 120', 'xMidYMax meet', '<circle cx="50" cy="42" r="22"/><path d="M6 120c0-27 20-45 44-45s44 18 44 45z"/>'],
    }[kind];
    svg.setAttribute('viewBox', shapes[0]);
    svg.setAttribute('preserveAspectRatio', shapes[1]);
    svg.setAttribute('fill', 'rgba(255,255,255,0.6)');
    svg.innerHTML = shapes[2];
    // 컷 안의 짧은 프사는 아래쪽에 붙이고, 나머지는 칸을 꽉 채운다.
    svg.setAttribute('style', kind === 'bust' ? 'left:0;bottom:0;width:100%;height:92%' : 'left:0;top:0;width:100%;height:100%');
    return svg;
  }
  function photo(url, kind) {
    return url ? el('img', { src: url, alt: '' }) : silhouette(kind);
  }

  function tile(label, iconPath, onclick, cls = '') {
    return el('button', { type: 'button', class: `tile ${cls}`, onclick }, [icon(iconPath), el('span', { text: label })]);
  }

  // 바닥 글 상자: 묘사 · 대사 · 선택지. 지나간 글은 [시스템] 채팅에 남는다.
  function showCaption(text, choices = null, keep = true) {
    $('caption-text').textContent = text;
    $('caption-choices').replaceChildren(...(choices || []).map((c) => el('button', { type: 'button', text: c.label, onclick: c.pick })));
    $('caption-close').classList.toggle('hidden', Boolean(choices && choices.length));
    $('caption').classList.remove('hidden');
    if (keep) addSystem(text);
  }
  $('caption-close').addEventListener('click', () => $('caption').classList.add('hidden'));

  // ---------- 필드 ----------
  socket.on('game:enter', (data) => {
    state.character = data.character;
    setActiveCharacter(data.character.id);
    $('chat-log').replaceChildren();
    const history = [...data.history.global, ...data.history.zone].sort((a, b) => a.at - b.at);
    for (const msg of history) addChat(msg);
    if (data.resumed) addSystem('연결이 다시 이어졌다.');
    setOnline(data.onlineCount);
    setBattleMode(false);
    enterZone(data.zone, data.players);
    show('game');
  });

  socket.on('kicked', ({ reason }) => {
    state.character = null;
    setActiveCharacter(null);
    alert(reason);
    openSelect();
  });

  socket.on('zone:players', renderPlayers);
  socket.on('log', ({ text }) => addSystem(text));
  socket.on('chat', addChat);
  socket.on('notice', ({ text }) => addSystem(`📢 ${text}`));
  socket.on('online:count', ({ count }) => setOnline(count));

  function setOnline(count) {
    if (count != null) $('online-count').textContent = count;
  }

  function renderProfileCard() {
    const c = state.character;
    if (!c) return;
    const me = state.battle && state.battle.party.find((p) => p.id === state.battle.me?.id);
    const hp = me ? me.hp : c.hp;
    const mp = me ? me.mp : c.mp;
    const bar = (label, value, max, color) => el('div', { class: 'bar-row' }, [
      el('b', { text: label }),
      el('span', { class: 'bar-track' }, [el('span', { style: `width:${max ? Math.min(100, Math.round((value / max) * 100)) : 100}%;background:${color}` })]),
      el('span', { class: 'val', text: max ? `${value}/${max}` : 'MAX' }),
    ]);
    $('profile-card').replaceChildren(...[
      el('span', { class: 'lv', text: `Lv.${c.level}` }),
      el('div', { class: 'photo', role: 'img', 'aria-label': `${c.name} 프로필 사진` }, [photo(c.avatarUrl, 'square')]),
      c.title ? el('p', { class: 'title', text: `[${c.title}]` }) : null,
      el('p', { class: 'name', text: c.name }),
      el('div', { class: 'bars' }, [
        bar('HP', hp, c.derived.maxHp, 'var(--hp)'),
        bar('MP', mp, c.derived.maxMp, 'var(--mp)'),
        bar('EXP', c.exp, c.expToNext, 'var(--accent)'),
      ]),
    ].filter(Boolean));
  }
  const renderStatus = renderProfileCard;

  function enterZone(zone, players = state.players) {
    state.zone = zone;
    state.fieldMenu = 'main';
    $('zone-title').textContent = `${zone.region.name} - ${zone.name}`;
    $('scene').style.background = zone.colors.sky || '';
    $('ground').style.background = zone.colors.ground || '';
    $('ground').style.borderTop = zone.colors.groundEdge ? `2px solid ${zone.colors.groundEdge}` : '';
    const raids = zone.events.map((ev) => `균열의 기척이 느껴진다 — ${ev.monsterName} (등급: ${ev.grade})`);
    showCaption([zone.desc, ...raids].join('\n'));
    renderProfileCard();
    renderPlayers(players);
    renderActions();
  }

  function renderActions() {
    const box = $('actions');
    box.className = 'actions';
    if (state.battle) return renderBattleButtons();
    const zone = state.zone;
    const back = tile('뒤로', ICONS.back, () => { state.fieldMenu = 'main'; renderActions(); }, 'back');
    if (state.fieldMenu === 'move') {
      return box.replaceChildren(el('div', { class: 'tiles' }, [
        ...zone.exits.map((exit) => tile(exit.label, ICONS.move, () => move(exit.to), 'move')),
        back,
      ]));
    }
    const tiles = [];
    if (zone.events.length) tiles.push(tile('토벌 입장', ICONS.sword, raidPrompt, 'danger'));
    tiles.push(tile('이동', ICONS.move, () => { state.fieldMenu = 'move'; renderActions(); }));
    tiles.push(tile('둘러보기', ICONS.look, look));
    tiles.push(tile('토벌 목록', ICONS.raids, raidList));
    if (zone.shop) tiles.push(tile(zone.shop.name, ICONS.shop, () => openShop('buy')));
    box.replaceChildren(el('div', { class: 'tiles' }, tiles));
  }

  // 토벌 입장: 바닥 글 상자에 선택지
  function raidPrompt() {
    const evs = state.zone.events;
    const choices = evs.map((ev, i) => ({ label: `${i + 1}. ${evs.length > 1 ? `${ev.monsterName}에게 ` : ''}들어간다`, pick: () => enterRaid(ev.id) }));
    choices.push({ label: `${choices.length + 1}. 물러난다`, pick: () => showCaption(state.zone.desc, null, false) });
    showCaption(evs.map((ev) => `${ev.monsterName} Lv.${ev.monsterLevel ?? ''} — 등급: ${ev.grade} · 참가 ${ev.participants}/${ev.max}`).join('\n'), choices, false);
  }

  // 같은 구역 사람 버튼
  $('people-btn').addEventListener('click', () => {
    const open = $('people-panel').classList.toggle('hidden') === false;
    $('people-btn').setAttribute('aria-expanded', String(open));
  });

  function renderPlayers(players = state.players || []) {
    state.players = players;
    const meId = state.character?.id;
    $('people-count').textContent = players.length;
    $('players').replaceChildren(...players.map((p) => el('li', {}, [
      el('span', { class: 'lv', text: `Lv.${p.level} ` }),
      p.title ? el('span', { style: 'color:#f2c97a', text: `[${p.title}] ` }) : null,
      el('span', { class: p.id === meId ? 'me' : '', text: p.name }),
      p.inBattle ? el('span', { class: 'dim', text: ' · 전투 중' }) : null,
      p.away ? el('span', { class: 'dim', text: ' · 자리 비움' }) : null,
    ])));
  }

  let moving = false;
  async function move(to) {
    if (moving) return;
    moving = true;
    const res = await request('move', { to });
    moving = false;
    if (res.error) return toast(res.error);
    state.character = res.character;
    // 다른 구역의 지역 채팅은 지우고, 새 구역의 최근 대화를 보여 준다.
    for (const li of [...$('chat-log').children]) if (li.dataset.channel === 'zone') li.remove();
    for (const msg of res.history) addChat(msg);
    enterZone(res.zone, res.players);
    if (res.healed) showCaption('본부의 등불 아래에서 상처가 아문다. (HP/MP 모두 회복)');
  }

  async function look() {
    const res = await request('look');
    if (res.error) return toast(res.error);
    showCaption(res.text);
  }

  async function raidList() {
    const res = await request('raid:list');
    if (res.error) return toast(res.error);
    const rows = res.events.map((ev) => el('div', { class: `region ${ev.here ? 'here' : ''}` }, [
      el('strong', { text: `${ev.monsterName} Lv.${ev.monsterLevel}` }),
      el('div', { class: 'muted', text: `${ev.regionName} - ${ev.zoneName} · 등급 ${ev.grade} · ${ev.remaining || '-'} · 참가 ${ev.participants}/${ev.max}` }),
    ]));
    openModal(el('div', {}, [el('h2', { text: '토벌 목록' }), ...(rows.length ? rows : [el('p', { class: 'muted', text: '지금 열린 토벌 이벤트가 없다.' })])]));
  }

  async function enterRaid(eventId) {
    const res = await request('raid:enter', { eventId });
    if (res.error) toast(res.error);
  }

  // ---------- 전투 ----------
  function setBattleMode(on) {
    $('screen-game').classList.toggle('in-battle', on);
    const select = $('chat-form').elements.channel;
    const existing = select.querySelector('option[value=battle]');
    if (on && !existing) {
      select.prepend(el('option', { value: 'battle', text: '전투' }));
      select.value = 'battle';
    } else if (!on && existing) {
      existing.remove();
      select.value = 'zone';
    }
    select.disabled = on;
    if (!on) {
      state.battle = null;
      state.battleMenu = 'main';
      state.bubbles.clear();
      $('cuts').replaceChildren();
    }
    renderChatTabs();
  }

  socket.on('battle:state', (view) => {
    const first = !state.battle;
    if (first) setBattleMode(true);
    const myTurnBefore = isMyTurn();
    state.battle = view;
    if (first) for (const line of view.log) addBattleLog(line);
    if (!isMyTurn() || !myTurnBefore) state.battleMenu = 'main';
    renderBattle();
  });

  socket.on('battle:log', ({ text }) => addBattleLog(text));

  socket.on('battle:end', (data) => {
    setBattleMode(false);
    state.character = data.character;
    if (data.result === 'defeat') {
      for (const li of [...$('chat-log').children]) if (li.dataset.channel === 'zone') li.remove();
      for (const msg of data.history) addChat(msg);
      enterZone(data.zone, data.players);
    } else {
      enterZone(data.zone);
    }
    showResult(data);
  });

  function isMyTurn() {
    const b = state.battle;
    return Boolean(b && b.turn && b.turn.kind === 'player' && b.me && b.turn.id === b.me.id);
  }

  // 전투 기록: 바닥 글 상자에 최신 한 줄, 전투 채팅 칸에도 회색으로 남긴다.
  function addBattleLog(text) {
    if (!text.startsWith('—')) showCaption(text, null, false);
    pushChatLine(el('li', { class: 'battlelog', 'data-channel': 'battlelog' }, [
      el('span', { class: 'ava sys', text: '·' }),
      el('span', { class: 'body' }, [el('span', { class: 'text', text })]),
    ]));
  }

  function renderBattle() {
    const b = state.battle;
    const m = b.monster;
    $('enemy-name').replaceChildren(`${m.name} `, el('small', { text: `Lv.${m.level}` }));
    $('enemy-bar').setAttribute('aria-label', `적 HP ${m.hp} / ${m.maxHp}`);
    $('enemy-bar').firstElementChild.style.width = `${m.maxHp ? Math.round((m.hp / m.maxHp) * 100) : 0}%`;
    renderCuts();
    renderTurnInfo();
    renderProfileCard();
    renderBattleButtons();
  }

  // 참가자 컷: 좌 우 좌 우. 1~2명은 길게(반신 컷인), 3~4명은 위아래로 짧게(정사각형 프사).
  const CLIP = { left: 'polygon(0 0, 100% 0, 82% 100%, 0 100%)', right: 'polygon(0 0, 100% 0, 100% 100%, 18% 100%)' };
  function renderCuts() {
    const b = state.battle;
    const tall = b.party.length <= 2;
    const cuts = b.party.slice(0, 4).map((p, i) => {
      const side = i % 2 === 0 ? 'left' : 'right';
      const row = Math.floor(i / 2);
      // 전경 높이 기준 비율 (시안 560px: 위 104, 긴 컷 372, 짧은 컷 176, 사이 24)
      const top = tall ? 18.6 : 18.6 + row * 35.7;
      const height = tall ? 66.4 : 31.4;
      const bubble = state.bubbles.get(p.id);
      const turn = b.turn && b.turn.kind === 'player' && b.turn.id === p.id;
      const lost = p.maxHp ? 100 - Math.round((p.hp / p.maxHp) * 100) : 0;
      return el('div', { class: `cut ${side} ${turn ? 'turn' : ''} ${p.down ? 'down' : ''}`, style: `top:${top}%;height:${height}%` }, [
        el('div', { class: 'cut-frame', style: `clip-path:${CLIP[side]}` }, [
          el('div', { class: 'cut-photo', role: 'img', 'aria-label': `${p.name} HP ${p.hp}/${p.maxHp}`, title: `${p.name} HP ${p.hp}/${p.maxHp}`, style: `clip-path:${CLIP[side]}` }, [
            tall ? photo(p.cutinUrl, 'half') : photo(p.avatarUrl, 'bust'),
            el('span', { class: 'cut-hp', 'aria-hidden': 'true', style: `height:${lost}%` }),
          ]),
        ]),
        el('span', { class: 'cut-name', text: p.name }),
        bubble && bubble.until > Date.now() ? el('div', { class: 'cut-bubble', text: bubble.text }) : null,
      ]);
    });
    $('cuts').replaceChildren(...cuts);
  }

  function renderTurnInfo() {
    const b = state.battle;
    const badge = $('turn-badge');
    if (!b || !b.turn) return badge.replaceChildren(`${b?.round || 1}라운드`);
    const left = b.turn.deadline ? Math.max(0, Math.ceil((b.turn.deadline - Date.now()) / 1000)) : null;
    badge.replaceChildren(...[
      el('span', { text: `${b.round}라운드` }),
      el('b', { text: `· ${b.turn.name}의 차례` }),
      left != null ? el('span', { text: `· ${left}초` }) : null,
    ].filter(Boolean));
  }
  setInterval(() => { if (state.battle) renderTurnInfo(); }, 500);

  function renderBattleButtons() {
    const b = state.battle;
    const mine = isMyTurn();
    const me = b.party.find((p) => b.me && p.id === b.me.id);
    const box = $('actions');
    box.className = 'actions battle';
    if (me && me.down) return box.replaceChildren(el('p', { class: 'note', text: '쓰러져 있다… 동료들이 싸우는 것을 지켜본다.' }));
    const back = tile('뒤로', ICONS.back, () => { state.battleMenu = 'main'; renderBattleButtons(); }, 'back');
    const sub = (list) => box.replaceChildren(el('div', { class: 'tiles' }, [...list, back]));
    if (state.battleMenu === 'skill') {
      return sub(b.me.skills.map((sk) => {
        const t = el('button', { type: 'button', class: 'tile', title: sk.desc, onclick: () => battleAction({ action: 'skill', skill: sk.id }) }, [
          el('span', { text: sk.name }),
          el('small', { text: sk.cooldown > 0 ? `${sk.cooldown}턴 뒤` : `MP ${sk.mp}` }),
        ]);
        t.disabled = !mine || !sk.usable;
        return t;
      }));
    }
    if (state.battleMenu === 'item') {
      const list = b.me.items.map((it) => {
        const t = el('button', { type: 'button', class: 'tile', title: it.desc, onclick: () => battleAction({ action: 'item', item: it.id }) }, [
          el('span', { text: it.name }), el('small', { text: `×${it.count}` }),
        ]);
        t.disabled = !mine;
        return t;
      });
      if (!list.length) list.push(el('p', { class: 'note', text: '쓸 수 있는 아이템이 없다.' }));
      return sub(list);
    }
    // 윗줄: 스킬(3) · 공격(2) / 아랫줄: 아이템(남은 폭) · 도주(정사각형)
    const skill = tile('스킬', ICONS.skill, () => { state.battleMenu = 'skill'; renderBattleButtons(); }, 'skill');
    const attack = tile('공격', ICONS.sword, () => battleAction({ action: 'attack' }), 'attack');
    const item = tile('아이템', ICONS.item, () => { state.battleMenu = 'item'; renderBattleButtons(); }, 'item');
    const flee = tile('도주', ICONS.flee, () => battleAction({ action: 'flee' }), 'flee');
    for (const t of [skill, attack, item, flee]) t.disabled = !mine;
    box.replaceChildren(el('div', { class: 'battle-grid' }, [
      el('div', { class: 'row' }, [skill, attack]),
      el('div', { class: 'row' }, [item, flee]),
    ]));
  }

  let acting = false;
  async function battleAction(cmd) {
    if (acting) return;
    acting = true;
    const res = await request('battle:action', cmd);
    acting = false;
    if (res.error) return toast(res.error);
    state.battleMenu = 'main';
    if (state.battle) renderBattleButtons();
  }

  function showResult(data) {
    const c = data.character;
    const lines = [];
    let title;
    let cls;
    if (data.result === 'victory') {
      title = '승리!';
      cls = 'victory';
      lines.push(`경험치 +${data.exp}`, `골드 +${data.gold}`);
      if (!data.items.length) lines.push('획득한 아이템 없음');
      if (data.levelUp) lines.push(`레벨 업! Lv.${c.level} — 스탯 포인트 +${data.levelUp * 3} (스테이터스에서 분배)`);
    } else if (data.result === 'defeat') {
      title = '패배…';
      cls = 'defeat';
      lines.push('본부로 옮겨졌다. 상처는 모두 아물었다.', `골드 -${data.goldLost}`);
    } else {
      title = '도주';
      cls = '';
      lines.push('무사히 전투에서 벗어났다. 토벌 이벤트는 그대로 남아 있다.');
    }
    openModal(el('div', { class: 'result' }, [
      el('div', { class: `big ${cls}`, text: title }),
      ...lines.map((t) => el('p', { text: t })),
      ...(data.items || []).map((it) => el('p', {}, ['획득: ', itemName(it), it.stats ? el('span', { class: 'muted', text: ` (${statText(it.stats)})` }) : null])),
    ]));
  }

  // ---------- 채팅 ----------
  // 탭: 필드는 [서버][지역][시스템] 보이기/숨기기, 전투 중에는 [전투 채팅] 하나.
  const CHAT_TABS = [['global', '서버'], ['zone', '지역'], ['system', '시스템']];
  const hiddenChannels = new Set();
  function renderChatTabs() {
    const box = $('chat-tabs');
    if (state.battle || $('screen-game').classList.contains('in-battle')) {
      return box.replaceChildren(el('button', { type: 'button', class: 'battle on', text: '전투 채팅', disabled: '' }));
    }
    box.replaceChildren(...CHAT_TABS.map(([ch, label]) => {
      const on = !hiddenChannels.has(ch);
      return el('button', {
        type: 'button', class: `${ch} ${on ? 'on' : ''}`, text: label, 'aria-pressed': String(on),
        title: on ? `${label} 채팅 켜짐 (누르면 숨김)` : `${label} 채팅 꺼짐 (누르면 보임)`,
        onclick: () => {
          if (on) hiddenChannels.add(ch); else hiddenChannels.delete(ch);
          $('chat-log').classList.toggle(`hide-${ch}`, !on);
          renderChatTabs();
        },
      });
    }));
  }

  function pushChatLine(li) {
    const list = $('chat-log');
    list.append(li);
    while (list.children.length > 200) list.firstChild.remove();
    list.scrollTop = list.scrollHeight;
  }

  function addSystem(text) {
    pushChatLine(el('li', { class: 'system', 'data-channel': 'system' }, [
      el('span', { class: 'ava sys', text: '!' }),
      el('span', { class: 'body' }, [el('span', { class: 'tag', text: '[시스템]' }), el('span', { class: 'text', text })]),
    ]));
  }

  function addChat(msg) {
    const ava = el('span', { class: 'ava' });
    if (msg.from.avatarUrl) ava.append(el('img', { src: msg.from.avatarUrl, alt: '' }));
    else ava.textContent = (msg.from.name || '?').slice(0, 1);
    pushChatLine(el('li', { class: msg.channel, 'data-channel': msg.channel }, [
      ava,
      el('span', { class: 'body' }, [
        el('span', { class: 'tag', text: { global: '[서버]', battle: '[전투]' }[msg.channel] || '[지역]' }),
        el('span', { class: 'name', text: `${msg.from.name}:` }),
        el('span', { class: 'text', text: msg.text }),
      ]),
    ]));
    if (msg.channel === 'battle' && state.battle) {
      // 전투 중 채팅은 컷 옆 말풍선으로도 5초간 띄운다.
      state.bubbles.set(msg.from.id, { text: msg.text, until: Date.now() + 5000 });
      renderCuts();
      setTimeout(() => { if (state.battle) renderCuts(); }, 5100);
    }
  }

  $('chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const text = form.elements.text.value.trim();
    if (!text) return;
    const res = await request('chat', { channel: form.elements.channel.value, text });
    if (res.error) return toast(res.error);
    form.elements.text.value = '';
  });

  // ---------- 서버 연결 점 ----------
  function setConn(kind) {
    const dot = $('conn-dot');
    dot.classList.toggle('warn', kind === 'warn');
    dot.classList.toggle('bad', kind === 'bad');
    dot.setAttribute('aria-label', { ok: '서버 연결: 좋음', warn: '서버 연결: 다시 잇는 중', bad: '서버 연결: 끊김' }[kind]);
  }
  socket.on('connect', () => setConn('ok'));
  socket.on('disconnect', () => setConn('bad'));
  socket.io.on('reconnect_attempt', () => setConn('warn'));

  // ---------- 오른쪽 아이콘 메뉴 ----------
  try { if (storage.get('theme') === 'light') document.body.classList.add('light'); } catch { /* 무시 */ }
  $('settings-btn').addEventListener('click', () => {
    const open = $('settings-pop').classList.toggle('hidden') === false;
    $('settings-btn').setAttribute('aria-expanded', String(open));
  });
  const menus = {
    inventory() {
      openInventory();
    },
    status() {
      renderCharacterInfo();
    },
    profile() {
      toast('OC 프로필은 준비 중이에요.');
    },
    community() {
      toast('파티 · 친구는 준비 중이에요.');
    },
    theme() {
      const light = document.body.classList.toggle('light');
      storage.set('theme', light ? 'light' : null);
    },
    async switch() {
      await request('char:leave');
      setActiveCharacter(null);
      state.character = null;
      setBattleMode(false);
      openSelect();
    },
    logout,
  };
  function renderCharacterInfo() {
    const c = state.character;
    const canAllocate = c.statPoints > 0 && !state.battle;
    const row = (k, v) => el('tr', {}, [el('td', { text: k }), el('td', { text: String(v) })]);
    const statRow = (k) => {
      const bonus = c.stats[k] - c.baseStats[k];
      return el('tr', { class: 'stat-row' }, [
        el('td', { text: STAT_NAMES[k] }),
        el('td', {}, [
          String(c.stats[k]),
          bonus ? el('span', { class: 'bonus', text: ` (장비 +${bonus})` }) : null,
          canAllocate ? el('button', { text: '+', onclick: () => allocate(k) }) : null,
        ]),
      ]);
    };
    openModal(el('div', {}, [
      el('h2', { text: `${c.name}  Lv.${c.level}` }),
      el('table', { class: 'info-table' }, [
        row('성별', optionName('genders', c.gender)),
        row('속성', optionName('elements', c.element)),
        row('클래스', optionName('classes', c.class)),
        row('계약 신', optionName('gods', c.god)),
        row('경험치', c.expToNext ? `${c.exp} / ${c.expToNext}` : '최대 레벨'),
        row('HP', `${c.hp} / ${c.derived.maxHp}`),
        row('MP', `${c.mp} / ${c.derived.maxMp}`),
        ...Object.keys(STAT_NAMES).map(statRow),
        row('남은 스탯 포인트', c.statPoints),
        row('회피율', `${c.derived.evasion}%`),
        row('치명타율', `${c.derived.crit}%`),
      ]),
      el('h3', { text: '스킬' }),
      el('ul', {}, [
        ...c.skills.map((sk) => el('li', { text: `${sk.name} (MP ${sk.mp}) — ${sk.desc}` })),
        c.nextSkill ? el('li', { class: 'muted', text: `Lv.${c.nextSkill}에 새 스킬 해금` }) : null,
      ]),
      el('h3', { text: '장비' }),
      el('ul', {}, Object.entries(c.equipment).map(([slot, it]) => el('li', {}, [
        `${SLOT_NAMES[slot]}: `,
        it ? itemName(it) : el('span', { class: 'muted', text: '없음' }),
        it ? el('span', { class: 'muted', text: ` (${statText(it.stats)})` }) : null,
      ]))),
      el('button', { class: 'secondary', text: '인벤토리 열기', onclick: () => openInventory() }),
    ]));
  }

  async function allocate(stat) {
    const res = await request('stat:allocate', { stat });
    if (res.error) return toast(res.error);
    state.character = res.character;
    renderStatus();
    renderCharacterInfo();
  }

  // ---------- 인벤토리 · 상점 ----------
  const SLOT_NAMES = { weapon: '무기', outfit: '의상', accessory: '장신구' };
  const SHORT_STAT = { str: 'STR', mag: 'MAG', vit: 'VIT', agi: 'AGI', luk: 'LUK' };
  const statText = (stats) => Object.entries(stats).filter(([, v]) => v).map(([k, v]) => `${SHORT_STAT[k]}+${v}`).join(' ') || '보너스 없음';
  // 장비 이름은 등급 색으로, 앞에 [등급]을 붙인다.
  const itemName = (it) => el('span', { class: 'item-name', style: it.color ? `color:${it.color}` : '', text: it.gradeName ? `[${it.gradeName}] ${it.name}` : it.name });

  // 인벤토리·상점 명령 결과를 받아 상태를 고치고 같은 창을 다시 그린다.
  async function itemAction(event, payload, rerender, confirmText) {
    if (confirmText && !confirm(confirmText)) return;
    const res = await request(event, payload);
    if (res.error) return toast(res.error);
    state.character = res.character;
    renderStatus();
    rerender(res, res.message);
  }

  async function openInventory() {
    const res = await request('inventory:list');
    if (res.error) return toast(res.error);
    renderInventory(res);
  }

  function renderInventory(inv, message) {
    const again = (res, msg) => renderInventory(res, msg);
    const equipCard = (it) => el('div', { class: `item-card ${it.equipped ? 'equipped' : ''}` }, [
      itemName(it),
      el('div', { class: 'item-meta', text: `${it.slotName} · ${statText(it.stats)}${it.equipped ? ' · 장착 중' : ''}` }),
      el('div', { class: 'item-meta', text: it.desc }),
      el('div', { class: 'row' }, it.equipped
        ? [el('button', { class: 'secondary', text: '벗기', onclick: () => itemAction('inventory:unequip', { id: it.id }, again) })]
        : [
          el('button', { text: '장착', onclick: () => itemAction('inventory:equip', { id: it.id }, again) }),
          el('button', { class: 'secondary', text: `분해 (파편 ${it.shards})`, onclick: () => itemAction('inventory:disassemble', { id: it.id }, again, `${it.name}을(를) 분해할까요? 되돌릴 수 없습니다.`) }),
          el('button', { class: 'danger', text: '버리기', onclick: () => itemAction('inventory:discard', { id: it.id }, again, `${it.name}을(를) 버릴까요? 되돌릴 수 없습니다.`) }),
        ]),
    ]);
    const stackCard = (it) => el('div', { class: 'item-card' }, [
      el('span', { class: 'item-name', text: `${it.name} ×${it.count}` }),
      el('div', { class: 'item-meta', text: it.desc }),
      el('div', { class: 'row' }, [
        it.kind === 'consumable' ? el('button', { text: '사용', onclick: () => itemAction('inventory:use', { code: it.code }, again) }) : null,
        el('button', { class: 'danger', text: '1개 버리기', onclick: () => itemAction('inventory:discard', { code: it.code }, again, `${it.name} 1개를 버릴까요?`) }),
      ]),
    ]);
    const worn = inv.equipment.filter((e) => e.equipped);
    const bag = inv.equipment.filter((e) => !e.equipped);
    openModal(el('div', {}, [
      el('h2', { text: '인벤토리' }),
      el('p', { class: 'muted', text: `골드 ${inv.character.gold} G${state.battle ? ' · 전투 중에는 바꿀 수 없다' : ''}` }),
      el('p', { class: 'inv-message', text: message || '' }),
      el('h3', { text: '장착 중' }),
      ...Object.keys(SLOT_NAMES).map((slot) => {
        const it = worn.find((e) => e.slot === slot);
        return it ? equipCard(it) : el('div', { class: 'item-card muted', text: `${SLOT_NAMES[slot]}: 비어 있음` });
      }),
      el('h3', { text: `장비 (${bag.length})` }),
      ...(bag.length ? bag.map(equipCard) : [el('p', { class: 'muted', text: '가방에 장비가 없다.' })]),
      el('h3', { text: '소지품' }),
      ...(inv.stacks.length ? inv.stacks.map(stackCard) : [el('p', { class: 'muted', text: '아무것도 없다.' })]),
    ]));
  }

  async function openShop(tab, message) {
    const res = await request('shop:view');
    if (res.error) return toast(res.error);
    renderShop(res, tab, message);
  }

  function renderShop(shop, tab, message) {
    const again = (_res, msg) => openShop(tab, msg);
    const tabs = el('div', { class: 'tabs' }, [
      el('button', { class: tab === 'buy' ? '' : 'off', text: '구매', onclick: () => renderShop(shop, 'buy') }),
      el('button', { class: tab === 'sell' ? '' : 'off', text: '판매', onclick: () => renderShop(shop, 'sell') }),
    ]);
    let body;
    if (tab === 'buy') {
      body = shop.goods.map((g) => el('div', { class: 'item-card' }, [
        itemName(g),
        el('span', { class: 'muted', text: `  ${g.price} G` }),
        el('div', { class: 'item-meta', text: g.stats ? `${g.slotName} · ${statText(g.stats)}` : g.desc }),
        el('div', { class: 'row' }, [
          el('button', { text: '1개 구매', onclick: () => itemAction('shop:buy', { code: g.code }, again) }),
          g.kind === 'consumable' ? el('button', { class: 'secondary', text: `5개 (${g.price * 5} G)`, onclick: () => itemAction('shop:buy', { code: g.code, count: 5 }, again) }) : null,
        ]),
      ]));
    } else {
      const sellEquip = shop.equipment.filter((e) => !e.equipped).map((it) => el('div', { class: 'item-card' }, [
        itemName(it),
        el('span', { class: 'muted', text: `  판매가 ${it.sellPrice} G` }),
        el('div', { class: 'item-meta', text: `${it.slotName} · ${statText(it.stats)}` }),
        el('div', { class: 'row' }, [el('button', {
          text: '판매', onclick: () => itemAction('shop:sell', { id: it.id }, again, `${it.name}을(를) ${it.sellPrice} G에 팔까요?`),
        })]),
      ]));
      const sellStacks = shop.stacks.map((it) => el('div', { class: 'item-card' }, [
        el('span', { class: 'item-name', text: `${it.name} ×${it.count}` }),
        el('span', { class: 'muted', text: `  개당 ${it.sellPrice} G` }),
        el('div', { class: 'row' }, [el('button', { text: '1개 판매', onclick: () => itemAction('shop:sell', { code: it.code }, again) })]),
      ]));
      body = [...sellEquip, ...sellStacks];
      if (!body.length) body.push(el('p', { class: 'muted', text: '팔 수 있는 물건이 없다. (장착 중인 장비는 벗어야 팔 수 있다)' }));
    }
    openModal(el('div', {}, [
      el('h2', { text: shop.name }),
      el('p', { class: 'muted', text: `가진 골드 ${shop.character.gold} G · 팔 때는 사는 값보다 훨씬 싸게 쳐준다.` }),
      el('p', { class: 'inv-message', text: message || '' }),
      tabs,
      ...body,
    ]));
  }

  for (const btn of document.querySelectorAll('[data-menu]')) {
    btn.addEventListener('click', () => {
      $('settings-pop').classList.add('hidden');
      $('settings-btn').setAttribute('aria-expanded', 'false');
      menus[btn.dataset.menu]();
    });
  }
})();
