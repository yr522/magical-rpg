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

  function openModal(content, cls = 'pop-small') {
    $('modal-panel').className = `popup ${cls}`;
    $('modal-content').replaceChildren(content);
    $('modal').classList.remove('hidden');
  }
  const closeModal = () => $('modal').classList.add('hidden');
  $('modal-close').addEventListener('click', closeModal);
  // 창 바깥(어두운 곳)을 누르거나 Esc를 누르면 닫힌다.
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').classList.contains('hidden')) closeModal(); });

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
    if (zone.shop) tiles.push(tile(zone.shop.name, ICONS.shop, () => openShop()));
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

  // 토벌 목록: 2열 카드가 아래로 이어지고 넘치면 스크롤. 정보만 보여 준다 (입장은 그 장소에서).
  async function raidList() {
    const res = await request('raid:list');
    if (res.error) return toast(res.error);
    const card = (ev) => el('li', { class: `raid-card ${ev.here ? 'here' : ''}` }, [
      el('div', { class: 'rtop' }, [
        el('b', { text: ev.monsterName }), el('small', { text: `Lv.${ev.monsterLevel}` }),
        el('span', { class: `grade g-${ev.grade}`, text: ev.grade }),
      ]),
      el('span', { class: 'rwhere', text: `${ev.regionName} - ${ev.zoneName}` }),
      el('div', { class: 'rbottom' }, [
        el('span', { class: ev.remaining && ev.remaining !== '무기한' ? 'rtime' : 'rtime none', text: ev.remaining || '무기한' }),
        el('span', { class: 'seats' }, [
          el('span', { class: 'dots', 'aria-hidden': 'true' }, Array.from({ length: ev.max }, (_, i) => el('span', { class: i < ev.participants ? 'on' : '' }))),
          `참가 ${ev.participants} / ${ev.max}`,
        ]),
      ]),
    ]);
    openModal(el('div', { class: 'raid-win' }, [
      el('header', {}, [el('div', { class: 'phead' }, [el('h2', { class: 'ptitle', text: '토벌 목록' }), el('span', { class: 'who', text: `진행 중 ${res.events.length}건` })]), ornament()]),
      res.events.length ? el('ul', { class: 'raid-grid' }, res.events.map(card)) : el('p', { class: 'muted', text: '지금 열린 토벌 이벤트가 없다.' }),
    ]), 'pop-raid');
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
    equipment() {
      openEquipment();
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
  // ---------- 팝업 창 공통 ----------
  // 창은 화면 가운데에 뜨고 뒤는 어둡게, 닫기는 창 안 오른쪽 위 작은 흰색 ×. (docs/ui-design.md)
  const STAT_NAMES_SHORT = { str: ['힘', 'STR'], mag: ['마력', 'MAG'], vit: ['체력', 'VIT'], agi: ['민첩', 'AGI'], luk: ['행운', 'LUK'] };
  const KIND_NAMES = { consumable: '소모품', material: '재료', equipment: '장비' };
  const STAT_KO = { str: '힘', mag: '마력', vit: '체력', agi: '민첩', luk: '행운' };
  const statText = (stats) => Object.entries(stats || {}).filter(([, v]) => v).map(([k, v]) => `${STAT_KO[k]} +${v}`).join(' · ') || '보너스 없음';
  // 장비 이름은 등급 색으로.
  const itemName = (it) => el('span', { class: 'item-name', style: it.color ? `color:${it.color}` : '', text: it.gradeName ? `[${it.gradeName}] ${it.name}` : it.name });
  const ornament = (extra = '') => el('div', { class: `ornament ${extra}`, 'aria-hidden': 'true' }, [el('span'), el('i', { text: '✦' }), el('span')]);

  // 아이템 칸 하나 (장비 테두리 = 희귀도 색, 2개 이상이면 오른쪽 아래 개수)
  function itemCell(it, { selected, onclick, count } = {}) {
    if (!it) return el('span', { class: 'cell empty', 'aria-hidden': 'true' });
    return el('button', {
      type: 'button', class: `cell ${selected ? 'on' : ''}`, role: 'option', 'aria-selected': String(Boolean(selected)),
      'aria-label': `${it.name}${count > 1 ? ` ${count}개` : ''}`, title: it.name,
      style: it.color ? `border-color:${it.color};box-shadow:${selected ? '' : `0 0 8px ${it.color}55`}` : '', onclick,
    }, [el('span', { class: 'ico', text: it.icon || '📦' }), count > 1 ? el('span', { class: 'cnt', text: String(count) }) : null]);
  }
  // 가방 칸들 (빈 칸도 점선으로 채워서 보여 준다)
  function cellGrid(cells, min = 30) {
    const total = Math.max(min, Math.ceil(cells.length / 5) * 5);
    return el('div', { class: 'cells', role: 'listbox' }, [...cells, ...Array.from({ length: total - cells.length }, () => itemCell(null))]);
  }
  // 고른 아이템 설명 (인벤토리 · 상점 공통)
  function itemDetail(it, { priceLabel, price, actions = [], extra = null }) {
    const sub = it.gradeName ? `${it.gradeName} · ${it.slotName}` : KIND_NAMES[it.kind];
    return el('div', { class: 'detail' }, [
      el('div', { class: 'big-ico', role: 'img', 'aria-label': `${it.name} 그림`, style: it.color ? `border-color:${it.color}` : '', text: it.icon || '📦' }),
      el('div', {}, [el('p', { class: 'dname', text: it.name }), el('p', { class: 'dsub', style: it.color ? `color:${it.color}` : '', text: sub })]),
      el('p', { class: 'ddesc', text: it.stats ? `${it.desc}\n${statText(it.stats)}` : it.desc }),
      el('dl', { class: 'dmeta' }, [
        el('dt', { text: '습득처' }), el('dd', { text: (it.from || []).join(', ') || '-' }),
        el('dt', { text: priceLabel }), el('dd', { text: price }),
      ]),
      extra,
      actions.length ? el('div', { class: 'dactions' }, actions) : null,
    ]);
  }
  const actBtn = (label, onclick, main = false) => el('button', { type: 'button', class: main ? 'pbtn main' : 'pbtn', text: label, onclick });

  // 인벤토리 · 장비 · 상점 명령 결과를 받아 상태를 고치고 같은 창을 다시 그린다.
  async function itemAction(event, payload, rerender, confirmText) {
    if (confirmText && !confirm(confirmText)) return;
    const res = await request(event, payload);
    if (res.error) return toast(res.error);
    state.character = res.character;
    renderStatus();
    rerender(res);
  }

  // ---------- 스테이터스 창 ----------
  function renderCharacterInfo() {
    const c = state.character;
    const canAllocate = c.statPoints > 0 && !state.battle;
    const rows = Object.keys(STAT_NAMES_SHORT).map((k) => {
      const bonus = c.stats[k] - c.baseStats[k];
      return el('div', { class: 'stat-row' }, [
        el('span', { class: 'sname' }, [el('b', { text: STAT_NAMES_SHORT[k][0] }), ` `, el('small', { text: STAT_NAMES_SHORT[k][1] })]),
        el('span', { class: 'sbar', 'aria-hidden': 'true' }, [el('span', { style: `width:${Math.min(100, c.stats[k] * 3)}%` })]),
        el('span', { class: 'sval' }, [el('b', { text: String(c.stats[k]) }), bonus ? el('small', { text: ` (+${bonus})` }) : null]),
        el('span', { class: 'splus' }, [canAllocate ? el('button', { type: 'button', 'aria-label': `${STAT_NAMES_SHORT[k][0]} 1 올리기`, text: '+', onclick: () => allocate(k) }) : null]),
      ]);
    });
    const d = c.derived;
    const traits = [
      ['속성', optionName('elements', c.element)], ['클래스', optionName('classes', c.class)],
      ['계약 신', optionName('gods', c.god)], ['경험치', c.expToNext ? `${c.exp} / ${c.expToNext}` : '최대 레벨'],
      ['HP', `${c.hp} / ${d.maxHp}`], ['MP', `${c.mp} / ${d.maxMp}`],
      ['공격력', d.physAtk], ['마법 공격력', d.magAtk], ['방어력', d.def],
      ['회피율', `${d.evasion}%`], ['치명타율', `${d.crit}%`],
    ];
    openModal(el('div', { class: 'status-win' }, [
      el('header', {}, [
        el('div', { class: 'phead' }, [el('h2', { class: 'ptitle', text: '스테이터스' }), el('span', { class: 'who' }, [el('b', { text: c.name }), el('span', { text: ` Lv.${c.level}` })])]),
        ornament(),
      ]),
      el('div', { class: 'stats' }, [
        ...rows,
        el('p', { class: 'points' }, [el('span'), el('span', {}, ['남은 포인트 ', el('b', { class: c.statPoints > 0 ? 'has' : '', text: String(c.statPoints) })])]),
      ]),
      el('div', { class: 'traits' }, [
        el('h3', { text: '특성' }),
        el('div', { class: 'traits-scroll' }, [
          el('dl', { class: 'trait-grid' }, traits.map(([k, v]) => el('div', {}, [el('dt', { text: k }), el('dd', { text: String(v) })]))),
          el('h4', { text: '스킬' }),
          ...c.skills.map((sk) => el('div', { class: 'skill-box' }, [el('div', {}, [el('b', { text: sk.name }), el('small', { text: `MP ${sk.mp}` })]), el('span', { text: sk.desc })])),
          c.nextSkill ? el('div', { class: 'skill-box locked' }, [el('div', {}, [el('b', { text: '???' }), el('small', { text: `Lv.${c.nextSkill}에 해금` })]), el('span', { text: '레벨을 올리면 새 스킬이 열려요.' })]) : null,
        ]),
      ]),
    ]), 'pop-status');
  }

  async function allocate(stat) {
    const res = await request('stat:allocate', { stat });
    if (res.error) return toast(res.error);
    state.character = res.character;
    renderStatus();
    renderCharacterInfo();
  }

  // ---------- 인벤토리 창 ----------
  // 소모품 · 재료는 같은 종류끼리 한 칸, 장비는 한 개당 한 칸. 장비는 여기서 낄 수 없다(장비 창에서).
  async function openInventory(selKey) {
    const res = await request('inventory:list');
    if (res.error) return toast(res.error);
    renderInventory(res, selKey);
  }

  function bagList(inv) {
    return [
      ...inv.stacks.map((it) => ({ key: `s:${it.code}`, it, count: it.count })),
      ...inv.equipment.filter((e) => !e.equipped).map((it) => ({ key: `e:${it.id}`, it, count: 1 })),
    ];
  }

  function renderInventory(inv, selKey) {
    const list = bagList(inv);
    const sel = list.find((x) => x.key === selKey) || list[0];
    const again = (key) => (res) => renderInventory(res, key);
    let detail = el('p', { class: 'muted', text: '아이템을 누르면 여기에 설명이 나와요.' });
    if (sel) {
      const it = sel.it;
      const actions = [];
      if (it.kind === 'consumable') actions.push(actBtn('사용', () => itemAction('inventory:use', { code: it.code }, again(sel.key)), true));
      if (it.kind === 'equipment') actions.push(actBtn(`분해 (파편 ${it.shards})`, () => itemAction('inventory:disassemble', { id: it.id }, again(), `${it.name}을(를) 분해할까요? 되돌릴 수 없습니다.`)));
      actions.push(actBtn('버리기', () => (it.kind === 'equipment'
        ? itemAction('inventory:discard', { id: it.id }, again(), `${it.name}을(를) 버릴까요? 되돌릴 수 없습니다.`)
        : itemAction('inventory:discard', { code: it.code }, again(sel.key), `${it.name} 1개를 버릴까요?`))));
      if (state.battle) actions.length = 0;
      detail = itemDetail(it, { priceLabel: '판매가', price: `${it.sellPrice ?? '-'} G${inv.priceShop ? ` (${inv.priceShop})` : ''}`, actions });
    }
    openModal(el('div', { class: 'inv-win' }, [
      el('div', { class: 'inv-left' }, [detail]),
      el('div', { class: 'inv-right' }, [
        ornament('end'),
        el('div', { class: 'cells-scroll' }, [cellGrid(list.map((x) => itemCell(x.it, { selected: x === sel, count: x.count, onclick: () => renderInventory(inv, x.key) })))]),
        el('p', { class: 'bag-foot' }, [el('span', { text: `${inv.bag.used} / ${inv.bag.size}칸` }), el('span', {}, ['보유 골드 ', el('b', { text: `${inv.character.gold} G` })])]),
      ]),
    ]), 'pop-inv');
  }

  // ---------- 장비 창 ----------
  // 왼쪽: 지금 낀 장비 6칸 + 고른 장비 설명 / 오른쪽: 가방 속 장비만 (같은 장비도 한 칸씩)
  async function openEquipment(sel) {
    const res = await request('inventory:list');
    if (res.error) return toast(res.error);
    renderEquipment(res, sel);
  }

  function renderEquipment(inv, sel) {
    const c = inv.character;
    const worn = c.equipment;
    const bag = inv.equipment.filter((e) => !e.equipped);
    const pick = sel && (sel.slot ? worn[sel.slot] && { it: worn[sel.slot], slot: sel.slot } : bag.find((e) => e.id === sel.id) && { it: bag.find((e) => e.id === sel.id) });
    const chosen = pick || (Object.entries(worn).find(([, v]) => v) ? { it: Object.entries(worn).find(([, v]) => v)[1], slot: Object.entries(worn).find(([, v]) => v)[0] } : null);
    const again = (next) => (res) => renderEquipment(res, next);
    const slotCells = c.slots.map((sl) => {
      const it = worn[sl.id];
      if (!it) return el('span', { class: 'cell big empty', title: `${sl.name} (빈 칸)`, 'aria-label': `${sl.name} (빈 칸)` });
      const b = itemCell(it, { selected: chosen && chosen.slot === sl.id, onclick: () => renderEquipment(inv, { slot: sl.id }) });
      b.classList.add('big');
      b.title = `${sl.name}: ${it.name}`;
      return b;
    });
    let detail = el('p', { class: 'muted', text: '장비를 누르면 여기에 설명이 나와요.' });
    if (chosen) {
      const it = chosen.it;
      let action;
      if (chosen.slot) {
        action = actBtn('벗기', () => itemAction('inventory:unequip', { id: it.id }, again({ id: it.id })));
      } else {
        // 같은 종류 칸(장신구 · 장신구 2)이 다 차 있으면 바꿔 끼기
        const fits = c.slots.filter((sl) => sl.id === it.kindSlot || sl.id === `${it.kindSlot}2`);
        const full = fits.every((sl) => worn[sl.id]);
        action = actBtn(full ? '바꿔 끼기' : '장착', () => itemAction('inventory:equip', { id: it.id }, again({ slot: null, id: null })), true);
      }
      detail = el('div', { class: 'edetail' }, [
        el('p', { class: 'dname', text: it.name }),
        el('p', { class: 'dsub', style: `color:${it.color}`, text: `${it.gradeName} · ${it.slotName}` }),
        el('p', { class: 'ddesc', text: it.desc }),
        el('p', { class: 'dstats', text: statText(it.stats) }),
        state.battle ? null : el('div', { class: 'dactions' }, [action]),
      ]);
    }
    openModal(el('div', { class: 'inv-win' }, [
      el('div', { class: 'eq-left' }, [
        el('div', { class: 'eq-slots' }, [el('h2', { class: 'eq-title', text: '장비' }), el('div', { class: 'slot-grid' }, slotCells)]),
        el('div', { class: 'eq-detail' }, [detail]),
      ]),
      el('div', { class: 'inv-right' }, [
        ornament('end'),
        el('div', { class: 'cells-scroll' }, [cellGrid(bag.map((it) => itemCell(it, { selected: chosen && !chosen.slot && chosen.it.id === it.id, onclick: () => renderEquipment(inv, { id: it.id }) })), 20)]),
        el('p', { class: 'bag-foot' }, [el('span', { text: `가방 속 장비 ${bag.length}개 · 같은 장비도 한 칸씩` })]),
      ]),
    ]), 'pop-inv');
  }

  // ---------- 상점 창 ----------
  // 왼쪽: 내 가방 / 가운데: 고른 아이템 설명 + 구매·판매 / 오른쪽: 상점 물건. 안내 문구는 띄우지 않는다.
  async function openShop(sel) {
    const res = await request('shop:view');
    if (res.error) return toast(res.error);
    renderShop(res, sel || { side: 'shop', key: res.goods[0]?.code }, 1);
  }

  function renderShop(shop, sel, qty) {
    const mine = bagList(shop);
    const goods = shop.goods.map((g) => ({ key: g.code, it: g }));
    const chosen = sel.side === 'bag' ? mine.find((x) => x.key === sel.key) : goods.find((x) => x.key === sel.key);
    let center = el('p', { class: 'muted', text: '아이템을 누르면 여기에 설명이 나와요.' });
    if (chosen) {
      const it = chosen.it;
      const buying = sel.side === 'shop';
      const stack = it.kind !== 'equipment';
      const max = buying ? 20 : (chosen.count || 1);
      const n = stack ? Math.min(qty, max) : 1;
      const unit = buying ? it.price : it.sellPrice;
      const total = unit * n;
      const tooPoor = buying && total > shop.character.gold;
      const step = stack ? el('div', { class: 'qty', role: 'group', 'aria-label': '개수' }, [
        el('button', { type: 'button', 'aria-label': '하나 줄이기', text: '−', onclick: () => renderShop(shop, sel, Math.max(1, n - 1)) }),
        el('b', { text: `${n}개` }),
        el('button', { type: 'button', 'aria-label': '하나 늘리기', text: '+', onclick: () => renderShop(shop, sel, Math.min(max, n + 1)) }),
      ]) : null;
      const deal = actBtn(`${buying ? '구매' : '판매'} · ${total} G`, async () => {
        if (buying) {
          const res = await request('shop:buy', { code: it.code, count: n });
          if (res.error) return toast(res.error);
        } else {
          // 판매는 한 번에 하나씩 서버에 보낸다.
          for (let i = 0; i < n; i++) {
            const res = await request('shop:sell', it.kind === 'equipment' ? { id: it.id } : { code: it.code });
            if (res.error) { toast(res.error); break; }
          }
        }
        const next = await request('shop:view');
        if (next.error) return toast(next.error);
        state.character = next.character;
        renderStatus();
        const still = sel.side === 'shop' || bagList(next).some((x) => x.key === sel.key);
        renderShop(next, still ? sel : { side: 'shop', key: next.goods[0]?.code }, 1);
      }, true);
      if (tooPoor) deal.disabled = true;
      center = itemDetail(it, {
        priceLabel: buying ? '구매가' : '판매가',
        price: buying ? `${it.price} G` : `${it.sellPrice} G (가지고 있는 수 ${chosen.count || 1}개)`,
        extra: step,
        actions: [deal],
      });
    }
    openModal(el('div', { class: 'shop-win' }, [
      el('div', { class: 'shop-col' }, [
        el('div', { class: 'shop-head' }, [el('h2', { text: '내 가방' }), el('span', { class: 'line' })]),
        el('div', { class: 'cells-scroll' }, [cellGrid(mine.map((x) => itemCell(x.it, { selected: sel.side === 'bag' && sel.key === x.key, count: x.count, onclick: () => renderShop(shop, { side: 'bag', key: x.key }, 1) })))]),
        el('p', { class: 'bag-foot' }, [el('span', { text: `${shop.bag.used} / ${shop.bag.size}칸` }), el('span', {}, ['보유 골드 ', el('b', { text: `${shop.character.gold} G` })])]),
      ]),
      el('div', { class: 'shop-center' }, [center]),
      el('div', { class: 'shop-col' }, [
        el('div', { class: 'shop-head end' }, [el('span', { class: 'line' }), el('h2', { class: 'shop-name', text: shop.name })]),
        el('div', { class: 'cells-scroll' }, [cellGrid(goods.map((x) => itemCell(x.it, { selected: sel.side === 'shop' && sel.key === x.key, onclick: () => renderShop(shop, { side: 'shop', key: x.key }, 1) })), 10)]),
        el('p', { class: 'bag-foot' }, [el('span', { text: '상점은 일반 등급 장비만 팔아요.' })]),
      ]),
    ]), 'pop-shop');
  }

  for (const btn of document.querySelectorAll('[data-menu]')) {
    btn.addEventListener('click', () => {
      $('settings-pop').classList.add('hidden');
      $('settings-btn').setAttribute('aria-expanded', 'false');
      menus[btn.dataset.menu]();
    });
  }
})();
