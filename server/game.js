// 고정 게임 데이터(JSON)와 캐릭터 규칙. DB와 통신 코드는 여기 두지 않는다.
const characterData = require('./data/character.json');
const mapData = require('./data/map.json');
const { monsters: monsterList } = require('./data/monsters.json');
const { items: itemList, grades: gradeList, slots: slotList } = require('./data/items.json');
const { shops: shopList } = require('./data/shops.json');
const { skills: skillList } = require('./data/skills.json');
const { events: eventList } = require('./data/events.json');

const STAT_KEYS = ['str', 'mag', 'vit', 'agi', 'luk'];
const NAME_PATTERN = /^[가-힣a-zA-Z0-9 ]{2,12}$/;

const zones = new Map(mapData.zones.map((z) => [z.id, z]));
const regions = new Map(mapData.regions.map((r) => [r.id, r]));
const monsters = new Map(monsterList.map((m) => [m.id, m]));
const items = new Map(itemList.map((i) => [i.id, i]));
const skills = new Map(skillList.map((s) => [s.id, s]));
const grades = new Map(gradeList.map((g) => [g.id, g]));
const slots = new Map(slotList.map((s) => [s.id, s]));
const shops = new Map(shopList.map((s) => [s.id, s]));
const { growth } = characterData;

// 서버 시작 시 맵이 잘못 적혀 있으면 바로 알려 준다 (없는 구역으로 가는 출구 등).
function validateMap() {
  for (const zone of mapData.zones) {
    if (!regions.has(zone.region)) {
      throw new Error(`map.json: 구역 ${zone.id}의 지역 ${zone.region}이 없습니다`);
    }
    for (const exit of zone.exits) {
      const target = zones.get(exit.to);
      if (!target) throw new Error(`map.json: ${zone.id} → ${exit.to} 구역이 없습니다`);
      if (!target.exits.some((e) => e.to === zone.id)) {
        throw new Error(`map.json: ${exit.to}에서 ${zone.id}로 돌아오는 출구가 없습니다`);
      }
    }
  }
  if (!zones.has(characterData.startLocation)) {
    throw new Error('character.json: startLocation 구역이 map.json에 없습니다');
  }
  for (const code of characterData.startItems) {
    if (!items.has(code)) throw new Error(`character.json: startItems의 ${code} 아이템이 items.json에 없습니다`);
  }
  for (const code of characterData.startEquipment) {
    if (items.get(code)?.kind !== 'equipment') throw new Error(`character.json: startEquipment의 ${code}가 장비가 아닙니다`);
  }
  for (const item of itemList) {
    if (item.kind === 'equipment' && !slots.has(item.slot)) throw new Error(`items.json: ${item.id}의 슬롯 ${item.slot}이 없습니다`);
  }
  for (const m of monsterList) {
    for (const drop of m.drops) {
      if (!items.has(drop.item)) throw new Error(`monsters.json: ${m.id}의 드롭 ${drop.item}이 items.json에 없습니다`);
      for (const g of drop.grades || []) {
        if (!grades.has(g)) throw new Error(`monsters.json: ${m.id}의 드롭 등급 ${g}가 items.json grades에 없습니다`);
      }
    }
  }
  for (const shop of shopList) {
    if (!zones.has(shop.zone)) throw new Error(`shops.json: ${shop.id}의 구역 ${shop.zone}이 없습니다`);
    for (const code of shop.sells) {
      if (!items.has(code)) throw new Error(`shops.json: ${shop.id}가 파는 ${code}가 items.json에 없습니다`);
    }
  }
  const classIds = new Set(characterData.classes.map((c) => c.id));
  for (const sk of skillList) {
    if (!classIds.has(sk.class)) throw new Error(`skills.json: ${sk.id}의 클래스 ${sk.class}가 없습니다`);
  }
  for (const ev of eventList) {
    if (!zones.has(ev.zone)) throw new Error(`events.json: ${ev.id}의 구역 ${ev.zone}이 map.json에 없습니다`);
    if (!monsters.has(ev.monster)) throw new Error(`events.json: ${ev.id}의 몬스터 ${ev.monster}가 monsters.json에 없습니다`);
  }
}

function findOption(list, id) {
  return list.find((o) => o.id === id);
}

// 생성 화면의 선택지로 기본 스탯을 계산한다. 잘못된 선택이면 null.
function computeStartStats({ classId, godId }) {
  const cls = findOption(characterData.classes, classId);
  const god = findOption(characterData.gods, godId);
  if (!cls || !god) return null;
  const stats = { ...characterData.baseStats };
  for (const [key, value] of Object.entries(cls.bonus)) stats[key] += value;
  stats[god.stat] += god.bonus;
  return stats;
}

// 기획서 3장의 파생 수치 공식.
function derivedStats(stats, level) {
  return {
    maxHp: 50 + stats.vit * 10 + level * 5,
    maxMp: 20 + stats.mag * 5,
    evasion: Math.min(30, stats.agi * 0.5),
    crit: Math.min(25, stats.luk * 0.5),
  };
}

// 다음 레벨까지 필요한 경험치. 최대 레벨이면 null.
function expToNext(level) {
  return level >= growth.maxLevel ? null : growth.expPerLevel * level;
}

// 경험치를 더하고 레벨업을 처리한다. row를 직접 바꾸고 오른 레벨 수를 돌려준다.
function gainExp(row, amount) {
  row.exp += amount;
  let levels = 0;
  for (let need = expToNext(row.level); need !== null && row.exp >= need; need = expToNext(row.level)) {
    row.exp -= need;
    row.level += 1;
    row.stat_points += growth.statPointsPerLevel;
    levels += 1;
  }
  if (expToNext(row.level) === null) row.exp = 0;
  if (levels) {
    // 레벨업 시 HP/MP 전체 회복.
    const { maxHp, maxMp } = derivedStats(totalStats(row), row.level);
    row.hp = maxHp;
    row.mp = maxMp;
  }
  return levels;
}

const statsOf = (row) => Object.fromEntries(STAT_KEYS.map((k) => [k, row[k]]));

// ---------- 아이템 · 장비 ----------
// 장비 "실물"은 { id, code, grade, options, equipped, slot } 모양이다.
// 등급은 드롭될 때 정해지고, 기본 스탯에 등급 배율을 곱한 뒤 추가 옵션을 더한다.

function equipmentStats(inst) {
  const def = items.get(inst.code);
  const grade = grades.get(inst.grade) || grades.get('common');
  const result = Object.fromEntries(STAT_KEYS.map((k) => [k, 0]));
  for (const [k, v] of Object.entries(def.stats || {})) result[k] += Math.max(1, Math.round(v * grade.mult));
  for (const [k, v] of Object.entries(inst.options || {})) if (k in result) result[k] += v;
  return result;
}

// 장비를 포함한 최종 스탯. row.equipment는 서버 메모리에만 있는 장착 장비 목록이다.
function totalStats(row) {
  const stats = statsOf(row);
  for (const inst of row.equipment || []) {
    for (const [k, v] of Object.entries(equipmentStats(inst))) stats[k] += v;
  }
  return stats;
}

// 허용된 등급 중에서 grades.weight 비율로 등급을 고르고, 등급만큼 추가 옵션을 붙인다.
function rollEquipment(code, allowed, rng) {
  const pool = (allowed && allowed.length ? allowed : ['common']).map((id) => grades.get(id));
  let pick = rng() * pool.reduce((sum, g) => sum + g.weight, 0);
  const grade = pool.find((g) => (pick -= g.weight) < 0) || pool[pool.length - 1];
  const options = {};
  const bonus = grade.mult >= 1.9 ? 2 : 1;
  for (let i = 0; i < grade.options; i++) {
    const stat = STAT_KEYS[Math.floor(rng() * STAT_KEYS.length)];
    options[stat] = (options[stat] || 0) + bonus;
  }
  return { code, grade: grade.id, options, slot: items.get(code).slot };
}

// 몬스터 드롭 목록을 굴려 새 아이템들을 만든다. 장비면 등급도 정한다.
function rollDrops(drops, rng) {
  const result = [];
  for (const drop of drops) {
    if (rng() >= drop.chance) continue;
    const def = items.get(drop.item);
    result.push(def.kind === 'equipment' ? rollEquipment(drop.item, drop.grades, rng) : { code: drop.item });
  }
  return result;
}

// 아이템의 기준 가치. 장비는 등급 배율과 옵션 수만큼 비싸진다.
function itemValue(inst) {
  const def = items.get(inst.code);
  if (def.kind !== 'equipment') return def.price;
  const grade = grades.get(inst.grade) || grades.get('common');
  const optionCount = Object.values(inst.options || {}).reduce((a, b) => a + b, 0);
  return def.price * grade.mult * (1 + 0.25 * optionCount);
}

// 상점에서 살 때는 비싸게(올림), 팔 때는 싸게(내림).
const buyPrice = (shop, code) => Math.ceil(items.get(code).price * shop.buyRate);
const sellPrice = (shop, inst) => Math.max(1, Math.floor(itemValue(inst) * shop.sellRate));
// 분해하면 나오는 균열 파편 수.
const disassembleShards = (inst) => (grades.get(inst.grade) || grades.get('common')).shards;

function itemView(inst, shop) {
  const def = items.get(inst.code);
  const view = { id: inst.id, code: def.id, name: def.name, kind: def.kind, desc: def.desc };
  if (def.kind === 'equipment') {
    const grade = grades.get(inst.grade) || grades.get('common');
    Object.assign(view, {
      slot: def.slot,
      slotName: slots.get(def.slot).name,
      grade: grade.id,
      gradeName: grade.name,
      color: grade.color,
      stats: equipmentStats(inst),
      options: inst.options || {},
      equipped: Boolean(inst.equipped),
      shards: disassembleShards(inst),
    });
  }
  if (shop) view.sellPrice = sellPrice(shop, inst);
  return view;
}

const shopInZone = (zoneId) => shopList.find((s) => s.zone === zoneId) || null;

// 전투용 수치 (장비 포함).
function combatStats(row) {
  const stats = totalStats(row);
  return {
    ...derivedStats(stats, row.level),
    physAtk: stats.str * 2 + row.level,
    magAtk: stats.mag * 2 + row.level,
    def: stats.vit * 1.5 + row.level,
    agi: stats.agi,
  };
}

function skillsFor(classId, level) {
  return skillList.filter((s) => s.class === classId && s.level <= level);
}

// 입력값을 검사하고 DB에 넣을 새 캐릭터 값을 만든다. 실패하면 { error }.
function buildNewCharacter(input) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!NAME_PATTERN.test(name)) {
    return { error: '이름은 한글/영문/숫자 2~12자로 지어 주세요.' };
  }
  if (!findOption(characterData.genders, input.gender)) return { error: '성별을 골라 주세요.' };
  if (!findOption(characterData.elements, input.element)) return { error: '속성을 골라 주세요.' };
  const stats = computeStartStats(input);
  if (!stats) return { error: '클래스와 계약 신을 골라 주세요.' };
  const level = 1;
  const { maxHp, maxMp } = derivedStats(stats, level);
  return {
    character: {
      name,
      gender: input.gender,
      element: input.element,
      class: input.classId,
      god: input.godId,
      level,
      exp: 0,
      gold: characterData.startGold,
      ...stats,
      stat_points: 0,
      hp: maxHp,
      mp: maxMp,
      location_id: characterData.startLocation,
    },
  };
}

// 클라이언트에 보낼 캐릭터 정보 (내부 컬럼 이름을 화면용으로 정리).
function characterView(row) {
  const base = statsOf(row);
  const stats = totalStats(row);
  const zone = zones.get(row.location_id);
  return {
    id: row.id,
    name: row.name,
    gender: row.gender,
    element: row.element,
    class: row.class,
    god: row.god,
    level: row.level,
    exp: row.exp,
    expToNext: expToNext(row.level),
    gold: row.gold,
    hp: row.hp,
    mp: row.mp,
    statPoints: row.stat_points,
    baseStats: base,
    stats,
    equipment: Object.fromEntries(slotList.map((sl) => {
      const inst = (row.equipment || []).find((e) => e.slot === sl.id);
      return [sl.id, inst ? itemView(inst) : null];
    })),
    derived: derivedStats(stats, row.level),
    skills: skillsFor(row.class, row.level).map((sk) => ({ id: sk.id, name: sk.name, mp: sk.mp, desc: sk.desc })),
    nextSkill: (skillList.find((sk) => sk.class === row.class && sk.level > row.level) || {}).level || null,
    locationId: row.location_id,
    locationName: zone ? zone.name : '알 수 없는 곳',
    avatarUrl: row.avatar_url || null,
  };
}

function zoneView(zoneId) {
  const zone = zones.get(zoneId);
  const region = regions.get(zone.region);
  return {
    id: zone.id,
    name: zone.name,
    desc: zone.desc,
    region: { id: region.id, name: region.name, safe: region.safe },
    exits: zone.exits.map((e) => ({ label: e.label, to: e.to })),
  };
}

module.exports = {
  characterData,
  mapData,
  zones,
  regions,
  monsters,
  items,
  skills,
  grades,
  slots,
  shops,
  totalStats,
  equipmentStats,
  rollEquipment,
  rollDrops,
  buyPrice,
  sellPrice,
  disassembleShards,
  itemView,
  shopInZone,
  eventList,
  expToNext,
  gainExp,
  combatStats,
  skillsFor,
  STAT_KEYS,
  validateMap,
  computeStartStats,
  derivedStats,
  buildNewCharacter,
  characterView,
  zoneView,
};
