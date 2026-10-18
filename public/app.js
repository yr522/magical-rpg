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

  // ---------- 필드 ----------
  socket.on('game:enter', (data) => {
    state.character = data.character;
    setActiveCharacter(data.character.id);
    $('field-log').replaceChildren();
    $('chat-log').replaceChildren();
    const history = [...data.history.global, ...data.history.zone].sort((a, b) => a.at - b.at);
    for (const msg of history) addChat(msg);
    if (data.resumed) addLog('연결이 다시 이어졌다.', 'system');
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
  socket.on('log', ({ text }) => addLog(text, 'system'));
  socket.on('chat', addChat);

  function addLog(text, kind) {
    const log = $('field-log');
    log.append(el('p', { class: `entry ${kind || ''}`, text }));
    log.scrollTop = log.scrollHeight;
  }

  function renderStatus() {
    const c = state.character;
    $('statusbar').replaceChildren(
      el('span', {}, [el('strong', { text: c.name }), ` Lv.${c.level}`]),
      el('span', { text: `HP ${c.hp}/${c.derived.maxHp}` }),
      el('span', { text: `MP ${c.mp}/${c.derived.maxMp}` }),
      el('span', { text: `${c.gold} G` }),
      el('span', { class: 'muted', text: `${state.zone.region.name} · ${state.zone.name}` }),
    );
  }

  function enterZone(zone, players) {
    state.zone = zone;
    addLog(`— ${zone.name} —`, 'place');
    addLog(zone.desc);
    renderStatus();
    renderPlayers(players);
    const buttons = zone.exits.map((exit) => el('button', { class: 'move', text: exit.label, onclick: () => move(exit.to) }));
    buttons.push(el('button', { text: '둘러보기', onclick: look }));
    if (!zone.region.safe) buttons.push(el('button', { text: '토벌 목록', onclick: raidList }));
    $('actions').replaceChildren(...buttons);
  }

  function renderPlayers(players) {
    $('players').replaceChildren(...players.map((p) => el('li', { class: p.away ? 'away' : '' }, [
      avatar(p.name, p.avatarUrl, true),
      `${p.name} Lv.${p.level}${p.away ? ' (자리 비움)' : ''}${state.character && p.id === state.character.id ? ' (나)' : ''}`,
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
  }

  async function look() {
    const res = await request('look');
    if (res.error) return toast(res.error);
    addLog(res.text, 'notice');
  }

  async function raidList() {
    const res = await request('raid:list');
    if (res.error) return toast(res.error);
    addLog(res.events.length ? `토벌 이벤트 ${res.events.length}개가 열려 있다.` :'지금 이 지역에 열린 토벌 이벤트는 없다.', 'notice');
  }

  function addChat(msg) {
    const list = $('chat-log');
    const li = el('li', { class: msg.channel, 'data-channel': msg.channel }, [
      avatar(msg.from.name, msg.from.avatarUrl, true),
      el('span', {}, [
        el('span', { class: 'tag', text: msg.channel === 'global' ? '[전체]' : '[지역]' }),
        el('span', { class: 'name', text: msg.from.name }),
        msg.text,
      ]),
    ]);
    list.append(li);
    while (list.children.length > 150) list.firstChild.remove();
    list.scrollTop = list.scrollHeight;
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

  // ---------- 하단 메뉴 ----------
  const menus = {
    character() {
      const c = state.character;
      const rows = [
        ['성별', optionName('genders', c.gender)],
        ['속성', optionName('elements', c.element)],
        ['클래스', optionName('classes', c.class)],
        ['계약 신', optionName('gods', c.god)],
        ['경험치', c.exp],
        ...Object.keys(STAT_NAMES).map((k) => [STAT_NAMES[k], c.stats[k]]),
        ['남은 스탯 포인트', c.statPoints],
        ['최대 HP', c.derived.maxHp],
        ['최대 MP', c.derived.maxMp],
        ['회피율', `${c.derived.evasion}%`],
        ['치명타율', `${c.derived.crit}%`],
      ];
      openModal(el('div', {}, [
        el('h2', { text: `${c.name}  Lv.${c.level}` }),
        el('table', { class: 'info-table' }, rows.map(([k, v]) => el('tr', {}, [el('td', { text: k }), el('td', { text: String(v) })]))),
      ]));
    },
    async map() {
      const res = await request('map:view');
      if (res.error) return toast(res.error);
      openModal(el('div', {}, [
        el('h2', { text: '지도' }),
        ...res.regions.map((r) => el('div', { class: `region ${r.here ? 'here' : ''}` }, [
          el('strong', { text: `${r.name}${r.here ? ' (현재 지역)' : ''}` }),
          el('div', { class: 'muted', text: `권장 레벨 ${r.level} · 주 속성 ${r.element} · 파괴도 ${r.destruction}%` }),
          el('div', { text: r.zones.map((z) => (z.here ? `▶ ${z.name}` : z.name)).join(' · ') }),
        ])),
      ]));
    },
    async switch() {
      await request('char:leave');
      setActiveCharacter(null);
      state.character = null;
      openSelect();
    },
    logout,
  };
  for (const btn of document.querySelectorAll('[data-menu]')) btn.addEventListener('click', () => menus[btn.dataset.menu]());
})();
