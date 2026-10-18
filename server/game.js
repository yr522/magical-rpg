// 고정 게임 데이터(JSON)와 캐릭터 규칙. DB와 통신 코드는 여기 두지 않는다.
const characterData = require('./data/character.json');
const mapData = require('./data/map.json');
const { monsters: monsterList } = require('./data/monsters.json');
const { items: itemList } = require('./data/items.json');
const { skills: skillList } = require('./data/skills.json');
const { events: eventList } = require('./data/events.json');

const STAT_KEYS = ['str', 'mag', 'vit', 'agi', 'luk'];
const NAME_PATTERN = /^[가-힣a-zA-Z0-9 ]{2,12}$/;

const zones = new Map(mapData.zones.map((z) => [z.id, z]));
const regions = new Map(mapData.regions.map((r) => [r.id, r]));
const monsters = new Map(monsterList.map((m) => [m.id, m]));
const items = new Map(itemList.map((i) => [i.id, i]));
const skills = new Map(skillList.map((s) => [s.id, s]));
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
  for (const m of monsterList) {
    for (const drop of m.drops) {
      if (!items.has(drop.item)) throw new Error(`monsters.json: ${m.id}의 드롭 ${drop.item}이 items.json에 없습니다`);
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
    const { maxHp, maxMp } = derivedStats(statsOf(row), row.level);
    row.hp = maxHp;
    row.mp = maxMp;
  }
  return levels;
}

const statsOf = (row) => Object.fromEntries(STAT_KEYS.map((k) => [k, row[k]]));

// 전투용 수치 (장비가 생기면 여기에 더한다).
function combatStats(row) {
  const stats = statsOf(row);
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
  const stats = statsOf(row);
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
    stats,
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
