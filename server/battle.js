// 턴제 전투 하나. 서버가 모든 판정을 계산하고, 결과는 hooks로 바깥(index.js)에 알린다.
// 저장·소켓 전송은 여기서 하지 않는다.
const game = require('./game');

const MAX_PARTY = 4;
const LOG_KEEP = 40;

const RESIST = {
  weak: { mult: 1.5, note: ' (취약!)' },
  normal: { mult: 1, note: '' },
  resist: { mult: 0.5, note: ' (내성…)' },
  immune: { mult: 0, note: ' (면역 — 통하지 않는다!)' },
};

const TRANSFORM_FLAVOR = {
  fire: '불꽃이', water: '물결이', nature: '잎사귀가', light: '빛이',
  dark: '어둠이', thunder: '번개가', ice: '서리가', physical: '계약의 문장이',
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 기획서 4장 데미지 공식. 면역(배율 0)이면 0.
function calcDamage({ atk, coef, def, mult, rng }) {
  if (mult === 0) return 0;
  const raw = (atk * coef - def * 0.5) * mult * (0.9 + rng() * 0.2);
  return Math.max(1, Math.round(raw));
}

class Battle {
  constructor({ event, hooks, rng = Math.random, turnMs = 0, monsterDelayMs = 1000 }) {
    this.event = event;
    this.def = game.monsters.get(event.monster);
    this.monster = { hp: this.def.hp, maxHp: this.def.hp, turns: 0 };
    this.party = new Map();
    this.hooks = hooks;
    this.rng = rng;
    this.turnMs = turnMs;
    this.monsterDelayMs = monsterDelayMs;
    this.order = [];
    this.turnIndex = -1;
    this.round = 0;
    this.current = null;
    this.timer = null;
    this.busy = false;
    this.ended = false;
    this.lines = [];
    this.monsterTie = Math.random(); // 민첩이 같을 때의 순서. 전투 내내 그대로 (라운드마다 바뀌지 않게)
  }

  get id() {
    return this.event.id;
  }

  isFull() {
    return this.party.size >= MAX_PARTY;
  }

  // ---------- 입장 / 퇴장 ----------

  // defer: 파티가 같이 들어올 때 마지막 사람이 들어올 때까지 전투를 시작하지 않는다.
  join(row, items, defer = false) {
    const stats = game.combatStats(row);
    const p = {
      id: row.id,
      name: row.name,
      element: row.element,
      cls: row.class,
      level: row.level,
      mag: row.mag,
      avatarUrl: row.avatar_url || null,
      cutinUrl: row.cutin_url || null,
      lines: game.linesOf(row), // 대사 프리셋 (상황 → 대사 목록)
      ...stats,
      hp: clamp(row.hp, 1, stats.maxHp),
      mp: clamp(row.mp, 0, stats.maxMp),
      items: new Map(items.map((i) => [i.code, i.count])),
      cooldowns: {},
      buffs: [],
      taunt: 0,
      defending: false,
      down: false,
      dealt: 0,
      tie: Math.random(),
    };
    this.party.set(p.id, p);
    this.log(`${p.name}의 몸을 ${TRANSFORM_FLAVOR[p.element] || '빛이'} 감싼다. 계약의 문장이 새겨진다 — 변신!`);
    this.say(p, 'start');
    if (this.round === 0) {
      if (defer) return this.update();
      this.log(`${this.def.name}이(가) 모습을 드러냈다. ${this.def.desc}`);
      this.startRound();
    } else {
      this.log(`${p.name}이(가) 전투에 합류했다. 다음 라운드부터 행동한다.`);
      this.update();
    }
  }

  // 전투 밖으로 나간다 (도주 성공, 접속 종료, 캐릭터 변경 등).
  leave(id, reason) {
    if (this.ended || !this.party.has(id)) return;
    const wasTurn = this.removeMember(id, reason);
    if (this.checkEnd()) return;
    if (wasTurn) this.nextTurn();
    else this.update();
  }

  removeMember(id, reason) {
    const p = this.party.get(id);
    this.party.delete(id);
    const wasTurn = this.current?.kind === 'player' && this.current.id === id;
    this.hooks.onLeave(this, p, reason);
    return wasTurn;
  }

  // ---------- 차례 진행 ----------

  startRound() {
    this.round += 1;
    for (const p of this.party.values()) {
      p.buffs = p.buffs.map((b) => ({ ...b, rounds: b.rounds - 1 })).filter((b) => b.rounds > 0);
      p.taunt = Math.max(0, p.taunt - 1);
    }
    // 민첩 높은 순, 같으면 무작위 — 그 무작위는 들어올 때 한 번만 정해서 라운드마다 순서가 뒤바뀌지 않는다.
    const turns = [...this.party.values()].filter((p) => !p.down).map((p) => ({ kind: 'player', id: p.id, agi: p.agi, tie: p.tie }));
    turns.push({ kind: 'monster', agi: this.def.agi, tie: this.monsterTie });
    this.order = turns.sort((a, b) => b.agi - a.agi || a.tie - b.tie);
    this.turnIndex = -1;
    this.log(`— ${this.round}라운드 —`);
    this.nextTurn();
  }

  nextTurn() {
    if (this.ended) return;
    clearTimeout(this.timer);
    for (;;) {
      this.turnIndex += 1;
      if (this.turnIndex >= this.order.length) return this.startRound();
      const turn = this.order[this.turnIndex];
      if (turn.kind === 'monster') {
        this.current = { kind: 'monster' };
        this.update();
        this.timer = setTimeout(() => this.monsterTurn(), this.monsterDelayMs);
        return;
      }
      const p = this.party.get(turn.id);
      if (!p || p.down) continue;
      p.defending = false;
      for (const code of Object.keys(p.cooldowns)) p.cooldowns[code] = Math.max(0, p.cooldowns[code] - 1);
      // 차례 제한시간은 없다 (기획자 결정: RP 요소가 많아 한 턴 한 턴 천천히 고를 수 있게).
      // 연결이 끊긴 사람은 재접속 대기 시간(30초)이 지나면 전투에서 빠지므로 전투가 멈추지 않는다.
      // turnMs는 테스트에서만 쓴다: 정하면 그 시간 안에 안 고를 때 자동 공격.
      this.current = { kind: 'player', id: p.id, deadline: this.turnMs ? Date.now() + this.turnMs : null };
      if (this.turnMs) {
        this.timer = setTimeout(() => {
          if (!this.busy) this.act(p.id, { action: 'attack' }, true);
        }, this.turnMs);
      }
      this.update();
      return;
    }
  }

  // 플레이어 행동. 잘못된 명령이면 { error }를 돌려주고 차례는 그대로 둔다.
  async act(id, cmd, auto = false) {
    if (this.ended) return { error: '전투가 이미 끝났습니다.' };
    if (this.busy) return { error: '처리 중입니다.' };
    if (this.current?.kind !== 'player' || this.current.id !== id) return { error: '지금은 내 차례가 아닙니다.' };
    const p = this.party.get(id);
    const problem = this.validate(p, cmd);
    if (problem) return { error: problem };

    this.busy = true;
    clearTimeout(this.timer);
    let fled = false;
    try {
      switch (cmd.action) {
        case 'attack':
          this.say(p, 'attack');
          if (auto) this.log(`${p.name}은(는) 머뭇거리다 반사적으로 공격했다. (시간 초과)`);
          this.hitMonster(p, { atk: p.physAtk, coef: 1, element: 'physical', label: '공격' });
          break;
        case 'skill':
          this.useSkill(p, game.skills.get(cmd.skill));
          break;
        case 'item':
          await this.useItem(p, game.items.get(cmd.item));
          break;
        case 'defend':
          p.defending = true;
          this.log(`${p.name}은(는) 방어 자세를 취했다.`);
          break;
        case 'flee':
          fled = this.tryFlee(p);
          break;
      }
    } finally {
      this.busy = false;
    }
    if (this.ended) return { ok: true };
    if (fled) this.removeMember(p.id, 'fled');
    if (!this.checkEnd()) this.nextTurn();
    return { ok: true };
  }

  validate(p, cmd) {
    switch (cmd.action) {
      case 'attack':
      case 'defend':
      case 'flee':
        return null;
      case 'skill': {
        const sk = game.skills.get(cmd.skill);
        if (!sk || sk.class !== p.cls || sk.level > p.level) return '쓸 수 없는 스킬입니다.';
        if ((p.cooldowns[sk.id] || 0) > 0) return `${sk.name}은(는) 아직 다시 쓸 수 없습니다.`;
        if (p.mp < sk.mp) return 'MP가 부족합니다.';
        return null;
      }
      case 'item': {
        const item = game.items.get(cmd.item);
        if (!item || item.kind !== 'consumable') return '쓸 수 없는 아이템입니다.';
        if (!(p.items.get(item.id) > 0)) return '그 아이템이 없습니다.';
        return null;
      }
      default:
        return '알 수 없는 행동입니다.';
    }
  }

  // ---------- 행동 처리 ----------

  // 대사 프리셋: 그 상황의 대사 중 하나를 무작위로 말풍선에 띄운다. 비어 있으면 말없이.
  // (전투 결과용 rng와 섞이지 않게 Math.random을 쓴다)
  say(p, situation) {
    const list = p.lines?.[situation];
    if (!list || !list.length || !this.hooks.onLine) return;
    this.hooks.onLine(this, p, list[Math.floor(Math.random() * list.length)]);
  }

  hitMonster(p, { atk, coef, element, label, hits = 1 }) {
    const resist = RESIST[this.def.resist[element] || 'normal'];
    const atkBoost = 1 + p.buffs.filter((b) => b.kind === 'atk').reduce((sum, b) => sum + b.value, 0);
    const evasion = Math.min(30, this.def.agi * 0.5);
    for (let i = 0; i < hits && this.monster.hp > 0; i++) {
      if (this.rng() * 100 < evasion) {
        this.log(`${p.name}의 ${label}! 그러나 ${this.def.name}이(가) 피했다.`);
        this.hooks.onHit?.(this, { miss: true });
        continue;
      }
      let dmg = calcDamage({ atk: atk * atkBoost, coef, def: this.def.def, mult: resist.mult, rng: this.rng });
      const crit = dmg > 0 && this.rng() * 100 < p.crit;
      if (crit) dmg = Math.round(dmg * 1.5);
      this.monster.hp = Math.max(0, this.monster.hp - dmg);
      p.dealt += dmg;
      this.hooks.onHit?.(this, { amount: dmg, element, crit, resist: this.def.resist[element] || 'normal' });
      this.log(`${p.name}의 ${label}!${crit ? ' 치명타!' : ''} ${this.def.name}에게 ${dmg} 데미지.${resist.note}`);
    }
  }

  useSkill(p, sk) {
    this.say(p, 'skill');
    p.mp -= sk.mp;
    p.cooldowns[sk.id] = sk.cooldown + 1; // 다음 내 차례 시작 때 1 줄어든다.
    if (sk.type === 'damage') {
      const element = sk.element === 'own' ? p.element : sk.element;
      this.hitMonster(p, { atk: sk.stat === 'mag' ? p.magAtk : p.physAtk, coef: sk.coef, element, label: sk.name, hits: sk.hits });
    } else if (sk.type === 'heal') {
      const amount = Math.round(p.mag * sk.coef + (sk.base || 0));
      const alive = [...this.party.values()].filter((m) => !m.down);
      const targets = sk.target === 'allies' ? alive : [alive.sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0]];
      const parts = targets.map((t) => {
        const healed = Math.min(t.maxHp - t.hp, amount);
        t.hp += healed;
        if (healed > 0 && t !== p) this.say(t, 'healed');
        return `${t.name} +${healed}`;
      });
      this.log(`${p.name}의 ${sk.name}! HP 회복 (${parts.join(', ')})`);
    } else if (sk.type === 'buff') {
      const targets = sk.target === 'allies' ? [...this.party.values()].filter((m) => !m.down) : [p];
      for (const t of targets) this.addBuff(t, sk);
      this.log(`${p.name}의 ${sk.name}! ${sk.desc}`);
    } else if (sk.type === 'taunt') {
      p.taunt = sk.rounds;
      if (sk.buff) this.addBuff(p, sk);
      this.log(`${p.name}의 ${sk.name}! ${this.def.name}의 시선이 ${p.name}에게 꽂힌다.`);
    }
  }

  addBuff(target, sk) {
    target.buffs = target.buffs.filter((b) => b.source !== sk.id);
    target.buffs.push({ source: sk.id, name: sk.name, ...sk.buff });
  }

  async useItem(p, item) {
    const ok = await this.hooks.consumeItem(p.id, item.id);
    if (!ok) {
      p.items.set(item.id, 0);
      this.log(`${p.name}은(는) ${item.name}을(를) 찾지 못했다.`);
      return;
    }
    p.items.set(item.id, p.items.get(item.id) - 1);
    const hp = Math.min(p.maxHp - p.hp, item.use.hp || 0);
    const mp = Math.min(p.maxMp - p.mp, item.use.mp || 0);
    p.hp += hp;
    p.mp += mp;
    const parts = [hp && `HP +${hp}`, mp && `MP +${mp}`].filter(Boolean).join(', ') || '효과 없음';
    this.log(`${p.name}은(는) ${item.name}을(를) 사용했다. (${parts})`);
  }

  tryFlee(p) {
    const chance = clamp(50 + (p.agi - this.def.agi) * 2, 5, 95);
    if (this.rng() * 100 < chance) {
      this.log(`${p.name}은(는) 전투에서 벗어났다.`);
      return true;
    }
    this.log(`${p.name}은(는) 도망치려 했지만 실패했다.`);
    return false;
  }

  monsterTurn() {
    if (this.ended) return;
    this.monster.turns += 1;
    const alive = [...this.party.values()].filter((p) => !p.down);
    const taunter = alive.find((p) => p.taunt > 0);
    let target;
    if (taunter) target = taunter;
    else if (this.rng() < 0.5) target = alive.reduce((a, b) => (b.dealt > a.dealt ? b : a));
    else target = alive[Math.floor(this.rng() * alive.length)];

    const special = this.def.special && this.monster.turns % this.def.special.every === 0 ? this.def.special : null;
    const label = special ? `${special.name}! ${special.text}` : '공격!';
    if (this.rng() * 100 < target.evasion) {
      this.log(`${this.def.name}의 ${label} 그러나 ${target.name}이(가) 피했다.`);
    } else {
      let reduce = target.buffs.filter((b) => b.kind === 'guard').reduce((r, b) => r * (1 - b.value), 1);
      if (target.defending) reduce *= 0.5;
      const base = calcDamage({ atk: this.def.atk, coef: special ? special.coef : 1, def: target.def, mult: 1, rng: this.rng });
      const dmg = Math.max(1, Math.round(base * Math.max(0.2, reduce)));
      target.hp = Math.max(0, target.hp - dmg);
      this.log(`${this.def.name}의 ${label} ${target.name}에게 ${dmg} 데미지.${target.defending ? ' (방어)' : ''}`);
      if (target.hp === 0) {
        target.down = true;
        this.log(`${target.name}이(가) 쓰러졌다.`);
        this.say(target, 'down');
      } else {
        this.say(target, 'hurt');
      }
    }
    if (!this.checkEnd()) this.nextTurn();
  }

  // ---------- 종료 ----------

  checkEnd() {
    if (this.ended) return true;
    let result = null;
    if (this.monster.hp <= 0) result = 'victory';
    else if (this.party.size === 0) result = 'abandoned';
    else if ([...this.party.values()].every((p) => p.down)) result = 'defeat';
    if (!result) return false;
    this.ended = true;
    clearTimeout(this.timer);
    this.current = null;
    if (result === 'victory') {
      this.log(`${this.def.name}을(를) 쓰러뜨렸다!`);
      for (const p of this.party.values()) if (!p.down) this.say(p, 'win');
    }
    if (result === 'defeat') this.log('파티가 전멸했다…');
    this.hooks.onEnd(this, result, [...this.party.values()]);
    return true;
  }

  stop() {
    this.ended = true;
    clearTimeout(this.timer);
  }

  // ---------- 화면용 데이터 ----------

  log(text) {
    this.lines.push(text);
    if (this.lines.length > LOG_KEEP) this.lines.shift();
    this.hooks.onLog(this, text);
  }

  update() {
    this.hooks.onUpdate(this);
  }

  view(forId) {
    const me = this.party.get(forId);
    const currentName = this.current?.kind === 'monster' ? this.def.name : this.party.get(this.current?.id)?.name;
    return {
      eventId: this.id,
      round: this.round,
      monster: {
        name: this.def.name,
        level: this.def.level,
        desc: this.def.desc,
        element: this.def.element,
        hp: this.monster.hp,
        maxHp: this.monster.maxHp,
      },
      party: [...this.party.values()].map((p) => ({
        id: p.id,
        name: p.name,
        avatarUrl: p.avatarUrl,
        cutinUrl: p.cutinUrl,
        hp: p.hp,
        maxHp: p.maxHp,
        mp: p.mp,
        maxMp: p.maxMp,
        down: p.down,
        defending: p.defending,
        taunting: p.taunt > 0,
        buffs: p.buffs.map((b) => b.name),
      })),
      turn: this.current ? { ...this.current, name: currentName } : null,
      me: me && {
        id: me.id,
        skills: game.skillsFor(me.cls, me.level).map((sk) => ({
          id: sk.id,
          name: sk.name,
          mp: sk.mp,
          desc: sk.desc,
          cooldown: me.cooldowns[sk.id] || 0,
          usable: !(me.cooldowns[sk.id] > 0) && me.mp >= sk.mp,
        })),
        items: [...me.items]
          .filter(([code, count]) => count > 0 && game.items.get(code)?.kind === 'consumable')
          .map(([code, count]) => ({ id: code, name: game.items.get(code).name, desc: game.items.get(code).desc, count })),
      },
      log: this.lines,
    };
  }
}

module.exports = { Battle, calcDamage, MAX_PARTY };
