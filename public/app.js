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

  // ---------- 필드 ----------
  socket.on('game:enter', (data) => {
    state.character = data.character;
    setActiveCharacter(data.character.id);
    $('field-log').replaceChildren();
    $('chat-log').replaceChildren();
    const history = [...data.history.global, ...data.history.zone].sort((a, b) => a.at - b.at);
    for (const msg of history) addChat(msg);
    if (data.resumed) addLog('연결이 다시 이어졌다.', 'system');
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
  socket.on('log', ({ text }) => addLog(text, 'system'));
  socket.on('chat', addChat);
  socket.on('notice', ({ text }) => {
    const list = $('chat-log');
    list.append(el('li', { class: 'notice', 'data-channel': 'notice', text: `📢 ${text}` }));
    list.scrollTop = list.scrollHeight;
  });

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
      el('span', { text: c.expToNext ? `EXP ${c.exp}/${c.expToNext}` : 'EXP 최대 레벨' }),
      el('span', { text: `${c.gold} G` }),
      el('span', { class: 'muted', text: `${state.zone.region.name} · ${state.zone.name}` }),
    );
  }

  function enterZone(zone, players) {
    state.zone = zone;
    addLog(`— ${zone.name} —`, 'place');
    addLog(zone.desc);
    for (const ev of zone.events) addLog(`균열의 기척이 느껴진다 — ${ev.monsterName} (등급: ${ev.grade})`, 'system');
    renderStatus();
    renderPlayers(players);
    renderActions();
  }

  function renderActions() {
    const zone = state.zone;
    const buttons = zone.events.map((ev) => el('button', { class: 'raid', text: `⚔ 입장 · ${ev.monsterName}`, onclick: () => enterRaid(ev.id) }));
    buttons.push(...zone.exits.map((exit) => el('button', { class: 'move', text: exit.label, onclick: () => move(exit.to) })));
    buttons.push(el('button', { text: '둘러보기', onclick: look }));
    buttons.push(el('button', { text: '토벌 목록', onclick: raidList }));
    $('actions').replaceChildren(...buttons);
  }

  function renderPlayers(players) {
    $('players').replaceChildren(...players.map((p) => el('li', { class: p.away ? 'away' : '' }, [
      avatar(p.name, p.avatarUrl, true),
      `${p.name} Lv.${p.level}${p.inBattle ? ' (전투 중)' : ''}${p.away ? ' (자리 비움)' : ''}${state.character && p.id === state.character.id ? ' (나)' : ''}`,
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
    if (res.healed) addLog('본부의 등불 아래에서 상처가 아문다. (HP/MP 모두 회복)', 'system');
  }

  async function look() {
    const res = await request('look');
    if (res.error) return toast(res.error);
    addLog(res.text, 'notice');
  }

  async function raidList() {
    const res = await request('raid:list');
    if (res.error) return toast(res.error);
    const rows = res.events.map((ev) => el('div', { class: `region ${ev.here ? 'here' : ''}` }, [
      el('strong', { text: `${ev.monsterName} Lv.${ev.monsterLevel}` }),
      el('div', { class: 'muted', text: `${ev.regionName} · ${ev.zoneName} · 등급 ${ev.grade} · 남은 시간 ${ev.remaining || '-'} · 참가 ${ev.participants}/${ev.max}` }),
      ev.label ? el('div', { class: 'muted', text: ev.label }) : null,
      ev.here
        ? el('button', { text: '입장', onclick: () => { $('modal').classList.add('hidden'); enterRaid(ev.id); } })
        : el('div', { text: `${ev.zoneName}(으)로 가야 입장할 수 있다.` }),
    ]));
    openModal(el('div', {}, [el('h2', { text: '토벌 목록' }), ...(rows.length ? rows : [el('p', { class: 'muted', text: '지금 열린 토벌 이벤트가 없다.' })])]));
  }

  async function enterRaid(eventId) {
    const res = await request('raid:enter', { eventId });
    if (res.error) toast(res.error);
  }

  // ---------- 전투 ----------
  function setBattleMode(on) {
    $('field-view').classList.toggle('hidden', on);
    $('battle-view').classList.toggle('hidden', !on);
    document.body.classList.toggle('in-battle', on);
    const select = $('chat-form').elements.channel;
    const existing = select.querySelector('option[value=battle]');
    if (on && !existing) {
      select.prepend(el('option', { value: 'battle', text: '전투' }));
      select.value = 'battle';
    } else if (!on && existing) {
      existing.remove();
      select.value = 'zone';
    }
    if (!on) {
      state.battle = null;
      state.battleMenu = 'main';
      state.bubbles.clear();
    }
  }

  socket.on('battle:state', (view) => {
    if (!state.battle) {
      setBattleMode(true);
      $('battle-log').replaceChildren();
      for (const line of view.log) addBattleLog(line);
    }
    const myTurnBefore = isMyTurn();
    state.battle = view;
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
      state.zone = data.zone;
      renderStatus();
      renderActions();
    }
    showResult(data);
  });

  function isMyTurn() {
    const b = state.battle;
    return Boolean(b && b.turn && b.turn.kind === 'player' && b.me && b.turn.id === b.me.id);
  }

  function addBattleLog(text) {
    const log = $('battle-log');
    log.append(el('p', { class: `entry ${text.startsWith('—') ? 'place' : ''}`, text }));
    while (log.children.length > 80) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  }

  const bar = (kind, value, max) => el('div', { class: `bar ${kind}` }, [el('span', { style: `width:${max ? Math.round((value / max) * 100) : 0}%` })]);

  function renderBattle() {
    const b = state.battle;
    const m = b.monster;
    $('enemy').replaceChildren(
      el('div', { class: 'name', text: `${m.name}  Lv.${m.level}` }),
      bar('', m.hp, m.maxHp),
      el('div', { text: `HP ${m.hp} / ${m.maxHp}` }),
      el('div', { class: 'muted', text: m.desc }),
    );
    renderSlots();
    renderTurnInfo();
    renderBattleButtons();
  }

  function renderSlots() {
    const b = state.battle;
    const slots = [0, 1, 2, 3].map((i) => {
      const p = b.party[i];
      if (!p) return el('div', { class: 'slot empty', text: '빈자리' });
      const status = [p.down && '쓰러짐', p.defending && '방어', p.taunting && '도발', ...p.buffs].filter(Boolean).join(' · ');
      const bubble = state.bubbles.get(p.id);
      return el('div', { class: `slot ${p.down ? 'down' : ''} ${b.turn && b.turn.id === p.id ? 'turn' : ''}` }, [
        bubble && bubble.until > Date.now() ? el('div', { class: 'bubble', text: bubble.text }) : null,
        avatar(p.name, p.avatarUrl),
        el('div', { class: 'slot-name', text: `${p.name}${b.me && p.id === b.me.id ? ' (나)' : ''}` }),
        bar('hp', p.hp, p.maxHp),
        el('div', { text: `HP ${p.hp}/${p.maxHp}` }),
        bar('mp', p.mp, p.maxMp),
        el('div', { class: 'muted', text: `MP ${p.mp}/${p.maxMp}` }),
        status ? el('div', { class: 'status', text: status }) : null,
      ]);
    });
    $('slots-left').replaceChildren(slots[0], slots[1]);
    $('slots-right').replaceChildren(slots[2], slots[3]);
  }

  function renderTurnInfo() {
    const b = state.battle;
    const info = $('turn-info');
    if (!b || !b.turn) return (info.textContent = '');
    const left = b.turn.deadline ? ` (${Math.max(0, Math.ceil((b.turn.deadline - Date.now()) / 1000))}초)` : '';
    info.classList.toggle('mine', isMyTurn());
    info.textContent = isMyTurn() ? `내 차례!${left}` : `${b.turn.name}의 차례${b.turn.kind === 'monster' ? '…' : left}`;
  }
  setInterval(() => { if (state.battle) renderTurnInfo(); }, 500);

  function renderBattleButtons() {
    const b = state.battle;
    const mine = isMyTurn();
    const me = b.party.find((p) => b.me && p.id === b.me.id);
    const box = $('battle-buttons');
    const back = el('button', { class: 'secondary wide', text: '← 뒤로', onclick: () => { state.battleMenu = 'main'; renderBattleButtons(); } });
    if (state.battleMenu === 'skill') {
      const list = b.me.skills.map((sk) => el('button', {
        class: 'sub wide', onclick: () => battleAction({ action: 'skill', skill: sk.id }),
      }, [`${sk.name}  (MP ${sk.mp})`, el('small', { text: sk.cooldown > 0 ? `${sk.cooldown}턴 뒤 사용 가능` : sk.desc })]));
      list.forEach((btn, i) => { if (!b.me.skills[i].usable || !mine) btn.disabled = true; });
      return box.replaceChildren(...list, back);
    }
    if (state.battleMenu === 'item') {
      const list = b.me.items.map((it) => el('button', {
        class: 'sub wide', onclick: () => battleAction({ action: 'item', item: it.id }),
      }, [`${it.name} ×${it.count}`, el('small', { text: it.desc })]));
      for (const btn of list) btn.disabled = !mine;
      if (!list.length) list.push(el('p', { class: 'muted', text: '쓸 수 있는 아이템이 없다.' }));
      return box.replaceChildren(...list, back);
    }
    const buttons = [
      el('button', { text: '공격', onclick: () => battleAction({ action: 'attack' }) }),
      el('button', { text: '스킬', onclick: () => { state.battleMenu = 'skill'; renderBattleButtons(); } }),
      el('button', { text: '아이템', onclick: () => { state.battleMenu = 'item'; renderBattleButtons(); } }),
      el('button', { text: '방어', onclick: () => battleAction({ action: 'defend' }) }),
      el('button', { class: 'secondary wide', text: '도주', onclick: () => battleAction({ action: 'flee' }) }),
    ];
    for (const btn of buttons) btn.disabled = !mine;
    if (me && me.down) box.replaceChildren(el('p', { class: 'muted wide', text: '쓰러져 있다… 동료들이 싸우는 것을 지켜본다.' }));
    else box.replaceChildren(...buttons);
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
      lines.push(data.items.length ? `획득: ${data.items.join(', ')}` : '획득한 아이템 없음');
      if (data.levelUp) lines.push(`레벨 업! Lv.${c.level} — 스탯 포인트 +${data.levelUp * 3} (캐릭터 메뉴에서 분배)`);
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
    ]));
  }

  function addChat(msg) {
    const list = $('chat-log');
    const li = el('li', { class: msg.channel, 'data-channel': msg.channel }, [
      avatar(msg.from.name, msg.from.avatarUrl, true),
      el('span', {}, [
        el('span', { class: 'tag', text: { global: '[전체]', battle: '[전투]' }[msg.channel] || '[지역]' }),
        el('span', { class: 'name', text: msg.from.name }),
        msg.text,
      ]),
    ]);
    list.append(li);
    while (list.children.length > 150) list.firstChild.remove();
    list.scrollTop = list.scrollHeight;
    if (msg.channel === 'battle' && state.battle) {
      // 전투 중 채팅은 프사 옆 말풍선으로도 5초간 띄운다.
      state.bubbles.set(msg.from.id, { text: msg.text, until: Date.now() + 5000 });
      renderSlots();
      setTimeout(() => { if (state.battle) renderSlots(); }, 5100);
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

  // ---------- 하단 메뉴 ----------
  const menus = {
    async character() {
      const inv = await request('inventory:list');
      renderCharacterInfo(inv.items || []);
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
  function renderCharacterInfo(items) {
    const c = state.character;
    const canAllocate = c.statPoints > 0 && !state.battle;
    const row = (k, v) => el('tr', {}, [el('td', { text: k }), el('td', { text: String(v) })]);
    const statRow = (k) => el('tr', { class: 'stat-row' }, [
      el('td', { text: STAT_NAMES[k] }),
      el('td', {}, [String(c.stats[k]), canAllocate ? el('button', { text: '+', onclick: () => allocate(k, items) }) : null]),
    ]);
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
      el('h3', { text: '소지품' }),
      items.length
        ? el('ul', {}, items.map((it) => el('li', { text: `${it.name} ×${it.count} — ${it.desc}` })))
        : el('p', { class: 'muted', text: '아무것도 없다.' }),
    ]));
  }

  async function allocate(stat, items) {
    const res = await request('stat:allocate', { stat });
    if (res.error) return toast(res.error);
    state.character = res.character;
    renderStatus();
    renderCharacterInfo(items);
  }

  for (const btn of document.querySelectorAll('[data-menu]')) btn.addEventListener('click', () => menus[btn.dataset.menu]());
})();
