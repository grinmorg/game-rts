import { fp } from './fixed';
import { AbilityId, ArmorType, BuildingType, DamageType, TICK_RATE, UnitType, UpgradeId } from './types';

export const sec = (s: number) => Math.round(s * TICK_RATE);

export interface UnitDef {
  name: string;
  cost: number;
  pop: number;
  hp: number;
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
    projectileSpeed: 0, trainedAt: BuildingType.Castle, ability: -1, bleeds: true,
  },
  [UnitType.Soldier]: {
    name: 'soldier', cost: 70, pop: 2, hp: 110, damage: 12, damageType: DamageType.Slash, armor: ArmorType.Heavy,
    range: 1, minRange: 0, speed: 2.4, cooldown: sec(1.0), trainTime: sec(20), vision: 7, radius: 0.35, aoe: 0,
    projectileSpeed: 0, trainedAt: BuildingType.Barracks, ability: AbilityId.ShieldStance, bleeds: true,
  },
  [UnitType.Archer]: {
    name: 'archer', cost: 80, pop: 2, hp: 65, damage: 10, damageType: DamageType.Pierce, armor: ArmorType.Light,
    range: 5, minRange: 0, speed: 2.4, cooldown: sec(1.2), trainTime: sec(22), vision: 8, radius: 0.33, aoe: 0,
    projectileSpeed: 0, trainedAt: BuildingType.Barracks, ability: AbilityId.Volley, bleeds: true,
  },
  [UnitType.Catapult]: {
    name: 'catapult', cost: 220, pop: 4, hp: 150, damage: 60, damageType: DamageType.Siege, armor: ArmorType.Siege,
    range: 8, minRange: 2, speed: 1.1, cooldown: sec(3.0), trainTime: sec(40), vision: 7, radius: 0.55, aoe: 1.5,
    projectileSpeed: 7, trainedAt: BuildingType.Forge, ability: AbilityId.Incendiary, bleeds: false,
  },
  [UnitType.Militia]: {
    name: 'militia', cost: 0, pop: 0, hp: 90, damage: 10, damageType: DamageType.Slash, armor: ArmorType.Heavy,
    range: 1, minRange: 0, speed: 2.6, cooldown: sec(1.0), trainTime: 0, vision: 6, radius: 0.35, aoe: 0,
    projectileSpeed: 0, trainedAt: -1, ability: -1, bleeds: true,
  },
};

export interface BuildingDef {
  name: string;
  cost: number;
  /** ticks */
  buildTime: number;
  hp: number;
  /** footprint size in cells (square) */
  size: number;
  requires: BuildingType | -1;
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
    name: 'castle', cost: 300, buildTime: sec(40), hp: 1200, size: 3, requires: -1, popCap: 10, vision: 9,
    // the castle defends itself: 30 piercing, +5 per ranged-attack upgrade level
    damage: 30, damageType: DamageType.Pierce, range: 7, cooldown: sec(2.0), upgradeBonus: 5, trains: [UnitType.Worker], ability: AbilityId.Militia,
  },
  [BuildingType.House]: {
    name: 'house', cost: 60, buildTime: sec(15), hp: 300, size: 2, requires: -1, popCap: 5, vision: 6,
    damage: 0, damageType: DamageType.Slash, range: 0, cooldown: 0, upgradeBonus: 0, trains: [], ability: -1,
  },
  [BuildingType.Barracks]: {
    name: 'barracks', cost: 120, buildTime: sec(25), hp: 700, size: 3, requires: -1, popCap: 0, vision: 7,
    damage: 0, damageType: DamageType.Slash, range: 0, cooldown: 0, upgradeBonus: 0, trains: [UnitType.Soldier, UnitType.Archer], ability: -1,
  },
  [BuildingType.Forge]: {
    name: 'forge', cost: 150, buildTime: sec(30), hp: 600, size: 3, requires: BuildingType.Barracks, popCap: 0, vision: 7,
    damage: 0, damageType: DamageType.Slash, range: 0, cooldown: 0, upgradeBonus: 0, trains: [UnitType.Catapult], ability: -1,
  },
  [BuildingType.Tower]: {
    name: 'tower', cost: 100, buildTime: sec(20), hp: 400, size: 2, requires: BuildingType.Barracks, popCap: 0, vision: 12,
    damage: 15, damageType: DamageType.Pierce, range: 7, cooldown: sec(1.5), upgradeBonus: 2, trains: [], ability: -1,
  },
};

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
  [AbilityId.Incendiary]: { name: 'incendiary', cooldown: sec(45), duration: sec(6), radius: 2, range: 8, targeted: true },
  [AbilityId.Militia]: { name: 'militia', cooldown: sec(120), duration: sec(30), radius: 0, range: 0, targeted: false },
};
export const SHIELD_STANCE_REDUCTION_PCT = 35;
export const VOLLEY_SIEGE_MULT = 2;
export const FIRE_DPS = 8;
export const FIRE_TICK_INTERVAL = 5; // apply fire damage every 5 ticks (0.25s)
export const MILITIA_COUNT = 3;

/** builder speed multipliers *10 for 1,2,3+ builders */
export const BUILDER_MULT = [10, 16, 20];

export const HARD_AI_GATHER_BONUS_PCT = 25;
export const LAST_CASTLE_WARNING_PCT = 25;
export const DISCONNECT_TIMEOUT_TICKS = sec(300);
export const MAX_QUEUE = 5;
export const MAX_ORDER_QUEUE = 6;

/** speeds precomputed in fixed per tick */
export const UNIT_SPEED_FP: number[] = [];
for (let t = 0; t < 5; t++) UNIT_SPEED_FP[t] = fp(UNITS[t as UnitType].speed / TICK_RATE);
