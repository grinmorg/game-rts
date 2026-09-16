import { fp } from './fixed';
import { AbilityId, Age, ArmorType, BuildingType, DamageType, TICK_RATE, UNIT_TYPE_COUNT, UnitType, UpgradeId } from './types';

export const sec = (s: number) => Math.round(s * TICK_RATE);

export interface UnitDef {
  name: string;
  cost: number;
  pop: number;
  hp: number;
  /** the age the owner must have reached to train it */
  age: Age;
  damage: number;
  damageType: DamageType;
  armor: ArmorType;
  /** cells */
  range: number;
  minRange: number;
  /** cells per second */
  speed: number;
  /** attack cooldown in ticks */
  cooldown: number;
  /** ticks */
  trainTime: number;
  vision: number;
  /** collision radius in cells */
  radius: number;
  /** cells (0 = single target) */
  aoe: number;
  /** projectile travel speed cells/s (0 = instant) */
  projectileSpeed: number;
  trainedAt: BuildingType | -1;
  ability: AbilityId | -1;
  /** view-only hint: leaves blood decal */
  bleeds: boolean;
}

export const UNITS: Record<UnitType, UnitDef> = {
  [UnitType.Worker]: {
    name: 'worker', cost: 50, pop: 1, hp: 40, damage: 4, damageType: DamageType.Slash, armor: ArmorType.Light,
    range: 1, minRange: 0, speed: 2.6, cooldown: sec(1.2), trainTime: sec(15), vision: 6, radius: 0.3, aoe: 0,
    projectileSpeed: 0, trainedAt: BuildingType.Castle, ability: -1, bleeds: true, age: Age.First,
  },
  [UnitType.Soldier]: {
    name: 'soldier', cost: 70, pop: 2, hp: 110, damage: 12, damageType: DamageType.Slash, armor: ArmorType.Heavy,
    range: 1, minRange: 0, speed: 2.4, cooldown: sec(1.0), trainTime: sec(20), vision: 7, radius: 0.35, aoe: 0,
    projectileSpeed: 0, trainedAt: BuildingType.Barracks, ability: AbilityId.ShieldStance, bleeds: true, age: Age.First,
  },
  [UnitType.Archer]: {
    name: 'archer', cost: 80, pop: 2, hp: 65, damage: 10, damageType: DamageType.Pierce, armor: ArmorType.Light,
    range: 5, minRange: 0, speed: 2.4, cooldown: sec(1.2), trainTime: sec(22), vision: 8, radius: 0.33, aoe: 0,
    projectileSpeed: 0, trainedAt: BuildingType.Barracks, ability: AbilityId.Volley, bleeds: true, age: Age.First,
  },
  [UnitType.Catapult]: {
    // range stays under the castle's defensive reach so a lone catapult can't siege a castle for free
    name: 'catapult', cost: 220, pop: 4, hp: 150, damage: 60, damageType: DamageType.Siege, armor: ArmorType.Siege,
    range: 7, minRange: 2, speed: 1.1, cooldown: sec(3.0), trainTime: sec(40), vision: 7, radius: 0.55, aoe: 1.5,
    projectileSpeed: 7, trainedAt: BuildingType.Forge, ability: AbilityId.Incendiary, bleeds: false, age: Age.Second,
  },
  [UnitType.Militia]: {
    name: 'militia', cost: 0, pop: 0, hp: 90, damage: 10, damageType: DamageType.Slash, armor: ArmorType.Heavy,
    range: 1, minRange: 0, speed: 2.6, cooldown: sec(1.0), trainTime: 0, vision: 6, radius: 0.35, aoe: 0,
    projectileSpeed: 0, trainedAt: -1, ability: -1, bleeds: true, age: Age.First,
  },
  [UnitType.Cavalry]: {
    // fast lancer: hunts catapults and stragglers (pierce x1.5 vs siege), but soldiers cut it down (slash x1.5 vs light)
    name: 'cavalry', cost: 120, pop: 3, hp: 130, damage: 14, damageType: DamageType.Pierce, armor: ArmorType.Light,
    range: 1, minRange: 0, speed: 3.9, cooldown: sec(1.1), trainTime: sec(26), vision: 8, radius: 0.4, aoe: 0,
    projectileSpeed: 0, trainedAt: BuildingType.Barracks, ability: -1, bleeds: true, age: Age.Second,
  },
};

/** wide units (catapult) path on the dilated map and cannot use one-cell gaps between buildings */
export function isHeavy(type: UnitType): boolean { return UNITS[type].radius >= 0.5; }

export interface BuildingDef {
  name: string;
  cost: number;
  /** ticks */
  buildTime: number;
  hp: number;
  /** footprint size in cells (square) */
  size: number;
  requires: BuildingType | -1;
  /** the age the owner must have reached to place it */
  age: Age;
  popCap: number;
  vision: number;
  /** defensive attack (castle, tower); 0 = no attack */
  damage: number;
  damageType: DamageType;
  range: number;
  cooldown: number;
  /** extra damage per level of the ranged-attack upgrade */
  upgradeBonus: number;
  trains: UnitType[];
  ability: AbilityId | -1;
}

export const BUILDINGS: Record<BuildingType, BuildingDef> = {
  [BuildingType.Castle]: {
    name: 'castle', cost: 300, buildTime: sec(40), hp: 1200, size: 3, requires: -1, popCap: 10, age: Age.First, vision: 9,
    // the castle defends itself: 30 piercing, +5 per ranged-attack upgrade level
    damage: 30, damageType: DamageType.Pierce, range: 7, cooldown: sec(2.0), upgradeBonus: 5, trains: [UnitType.Worker], ability: AbilityId.Militia,
  },
  [BuildingType.House]: {
    name: 'house', cost: 60, buildTime: sec(15), hp: 300, size: 2, requires: -1, popCap: 5, age: Age.First, vision: 6,
    damage: 0, damageType: DamageType.Slash, range: 0, cooldown: 0, upgradeBonus: 0, trains: [], ability: -1,
  },
  [BuildingType.Barracks]: {
    name: 'barracks', cost: 120, buildTime: sec(25), hp: 700, size: 3, requires: -1, popCap: 0, age: Age.First, vision: 7,
    damage: 0, damageType: DamageType.Slash, range: 0, cooldown: 0, upgradeBonus: 0, trains: [UnitType.Soldier, UnitType.Archer, UnitType.Cavalry], ability: -1,
  },
  [BuildingType.Forge]: {
    name: 'forge', cost: 150, buildTime: sec(30), hp: 600, size: 3, requires: BuildingType.Barracks, popCap: 0, age: Age.First, vision: 7,
    damage: 0, damageType: DamageType.Slash, range: 0, cooldown: 0, upgradeBonus: 0, trains: [UnitType.Catapult], ability: -1,
  },
  [BuildingType.Tower]: {
    name: 'tower', cost: 100, buildTime: sec(20), hp: 400, size: 2, requires: BuildingType.Barracks, popCap: 0, age: Age.First, vision: 12,
    damage: 15, damageType: DamageType.Pierce, range: 7, cooldown: sec(1.5), upgradeBonus: 2, trains: [], ability: -1,
  },
  [BuildingType.Wall]: {
    // one-cell fence segment: cheap and fast, but siege armour-piercing damage tears it down
    name: 'wall', cost: 20, buildTime: sec(5), hp: 250, size: 1, requires: -1, popCap: 0, age: Age.First, vision: 3,
    damage: 0, damageType: DamageType.Slash, range: 0, cooldown: 0, upgradeBonus: 0, trains: [], ability: -1,
  },
  [BuildingType.Mine]: {
    // passive gold: MINE_GOLD_PER_WORKER per garrisoned worker every MINE_INCOME_TICKS, up to MINE_CAPACITY workers
    name: 'mine', cost: 150, buildTime: sec(30), hp: 500, size: 2, requires: -1, popCap: 0, age: Age.First, vision: 5,
    damage: 0, damageType: DamageType.Slash, range: 0, cooldown: 0, upgradeBonus: 0, trains: [], ability: -1,
  },
};

/** workers a BuildingType.Mine holds; income scales linearly with how many are inside */
export const MINE_CAPACITY = 3;
export const MINE_INCOME_TICKS = sec(5);
/** ~48 gold/min per worker - a worker on a close deposit makes ~80/min, but never has to walk or die outside */
export const MINE_GOLD_PER_WORKER = 4;
/** share of a unit's cost paid to whoever kills it (1/10) */
export const KILL_BOUNTY_DIV = 10;
/** the incendiary shot leaves the bucket this many ticks after the order - the catapult visibly winds up */
export const INCENDIARY_DELAY_TICKS = sec(0.6);
/** a forest cell caught by fire burns this long, then becomes scorched, passable dirt */
export const FOREST_BURN_TICKS = sec(8);
/** Order.Gather with orderV = GATHER_AUTO was chosen by the worker itself and may be re-tasked; a player's order is 0 */
export const GATHER_AUTO = 1;

/** how far (cells) a free worker looks for an unfinished or damaged own building before going back to gold */
export const WORKER_JOB_RADIUS = 30;
/** free workers re-check for build/repair jobs this often (ticks) */
export const WORKER_DISPATCH_INTERVAL = 10;
/** at most this many gatherers get pulled off gold per player per dispatch */
export const WORKER_PULLS_PER_DISPATCH = 2;
/** never pull gatherers below this share of all workers - a long fence line must not empty the gold line */
export const WORKER_MIN_GATHER_PCT = 50;

/** HP a freshly placed construction site starts with (10% of the finished building). */
export function constructionStartHp(maxHp: number): number {
  const h = Math.floor(maxHp / 10);
  return h < 1 ? 1 : h;
}

/**
 * HP an undamaged construction site should have at `progress` out of `total`.
 * Exact at both ends: `constructionStartHp` when placed, full `maxHp` when finished.
 */
export function constructionHp(maxHp: number, progress: number, total: number): number {
  const base = constructionStartHp(maxHp);
  if (total <= 0) return maxHp;
  return base + Math.floor(((maxHp - base) * progress) / total);
}

/**
 * Inverse of `constructionHp`: the progress an undamaged site would have at `hp`. Used when a site is
 * hit, so that losing hp also means losing build progress (the two stay one quantity during construction).
 */
export function constructionProgressForHp(maxHp: number, hp: number, total: number): number {
  const base = constructionStartHp(maxHp);
  if (hp <= base || maxHp <= base) return 0;
  const pr = Math.floor(((hp - base) * total) / (maxHp - base));
  return pr > total ? total : pr;
}

/** builders on a construction site work this much slower for SITE_HIT_SLOW_TICKS after it takes a hit */
export const SITE_HIT_SLOW_PCT = 35;
export const SITE_HIT_SLOW_TICKS = sec(3);

/**
 * Ring radius (cells) to draw for a defensive building's reach. The sim measures the reach from the
 * footprint edge (`Simulation.buildingRange`), the ring is drawn from the centre, hence + size / 2.
 */
export function buildingRangeCells(type: BuildingType, rangeUpgrade = 0): number {
  const def = BUILDINGS[type];
  return def.range > 0 ? def.range + rangeUpgrade + def.size / 2 : 0;
}

export const MINE_SIZE = 3;
export const MINE_GOLD = 6000;
export const GOLD_PER_TRIP = 8;
/** ticks a worker spends inside the mine per trip (before travel) */
export const GATHER_TICKS = sec(2.5);
export const MINE_MAX_WORKERS = 8;
export const START_GOLD = 300;
export const START_WORKERS = 4;
export const REPAIR_HP_PER_SEC_PCT = 2;

/** damage multiplier * 100, [damageType][armorType] */
export const DAMAGE_MATRIX: number[][] = [
  // light, heavy, siege, building
  [150, 100, 50, 75], // slash
  [100, 75, 150, 50], // pierce
  [125, 150, 75, 200], // siege
];

export interface UpgradeDef {
  name: string;
  levels: number;
  baseCost: number;
  /** ticks per level */
  time: number[];
}
export const UPGRADES: Record<UpgradeId, UpgradeDef> = {
  [UpgradeId.MeleeAttack]: { name: 'meleeAttack', levels: 3, baseCost: 100, time: [sec(30), sec(40), sec(50)] },
  [UpgradeId.RangedAttack]: { name: 'rangedAttack', levels: 3, baseCost: 100, time: [sec(30), sec(40), sec(50)] },
  [UpgradeId.Armor]: { name: 'armor', levels: 3, baseCost: 100, time: [sec(30), sec(40), sec(50)] },
  [UpgradeId.MoveSpeed]: { name: 'moveSpeed', levels: 3, baseCost: 100, time: [sec(30), sec(40), sec(50)] },
  [UpgradeId.Range]: { name: 'range', levels: 2, baseCost: 120, time: [sec(35), sec(50)] },
  [UpgradeId.Gather]: { name: 'gather', levels: 3, baseCost: 100, time: [sec(30), sec(40), sec(50)] },
};
/**
 * Advancing to the next age is researched at a castle, like an upgrade at the forge. The first age is wood, the
 * second stone: buildings get sturdier (AGE_BUILDING_HP_PCT), siege and cavalry unlock, upgrades may go past level 1.
 */
export const AGE_UP = { cost: 500, time: sec(60), requires: BuildingType.Forge as BuildingType | -1 };
/** building max HP as a percentage of the base value, per age of the owner */
export const AGE_BUILDING_HP_PCT = [100, 130];
export function buildingMaxHp(type: BuildingType, age: Age): number {
  return Math.floor((BUILDINGS[type].hp * AGE_BUILDING_HP_PCT[age]) / 100);
}
/** highest upgrade level researchable in each age */
export const UPGRADE_MAX_LEVEL_BY_AGE = [1, 3];
export function maxUpgradeLevel(id: UpgradeId, age: Age): number {
  return Math.min(UPGRADES[id].levels, UPGRADE_MAX_LEVEL_BY_AGE[age]);
}

export function upgradeCost(id: UpgradeId, level: number): number {
  // level is the level being researched (1-based)
  let c = UPGRADES[id].baseCost;
  for (let i = 1; i < level; i++) c = Math.floor((c * 18) / 10);
  return c;
}

export interface AbilityDef {
  name: string;
  cooldown: number; // ticks
  duration: number; // ticks
  radius: number; // cells
  range: number; // cells for targeted
  targeted: boolean;
}
export const ABILITIES: Record<AbilityId, AbilityDef> = {
  [AbilityId.ShieldStance]: { name: 'shieldStance', cooldown: sec(40), duration: sec(6), radius: 0, range: 0, targeted: false },
  [AbilityId.Volley]: { name: 'volley', cooldown: sec(30), duration: 0, radius: 1.5, range: 5, targeted: true },
  [AbilityId.Incendiary]: { name: 'incendiary', cooldown: sec(45), duration: sec(6), radius: 2, range: 7, targeted: true },
  [AbilityId.Militia]: { name: 'militia', cooldown: sec(120), duration: sec(30), radius: 0, range: 0, targeted: false },
};
export const SHIELD_STANCE_REDUCTION_PCT = 35;
export const VOLLEY_SIEGE_MULT = 2;
export const FIRE_DPS = 8;
export const FIRE_TICK_INTERVAL = 5; // apply fire damage every 5 ticks (0.25s)
export const MILITIA_COUNT = 3;

/** builder speed multipliers *10 for 1,2,3+ builders */
export const BUILDER_MULT = [10, 16, 20];
/** taking a building apart runs at this share of the build speed - tearing down is quicker than putting up */
export const DISMANTLE_SPEED_PCT = 150;

export const HARD_AI_GATHER_BONUS_PCT = 25;
export const LAST_CASTLE_WARNING_PCT = 25;
export const DISCONNECT_TIMEOUT_TICKS = sec(300);
export const MAX_QUEUE = 5;
/** queued orders per unit; long enough for a worker to take a whole dragged fence line */
export const MAX_ORDER_QUEUE = 16;

/** speeds precomputed in fixed per tick */
export const UNIT_SPEED_FP: number[] = [];
for (let t = 0; t < UNIT_TYPE_COUNT; t++) UNIT_SPEED_FP[t] = fp(UNITS[t as UnitType].speed / TICK_RATE);
