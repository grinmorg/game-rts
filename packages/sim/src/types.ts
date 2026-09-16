export const TICK_RATE = 20;
export const TICK_MS = 1000 / TICK_RATE;
export const COMMAND_DELAY_TICKS = 2;
export const HASH_INTERVAL = 50;
export const MAX_PLAYERS = 6;
export const MAX_ENTITIES = 4096;
export const MAX_POP = 60;

export enum Kind {
  None = 0,
  Unit = 1,
  Building = 2,
  Mine = 3,
  Projectile = 4,
  Zone = 5,
}

export enum UnitType {
  Worker = 0,
  Soldier = 1,
  Archer = 2,
  Catapult = 3,
  Militia = 4, // temporary soldier from castle ability
  /** lancer on a horse: fast raider, light armour, piercing damage */
  Cavalry = 5,
}
export const UNIT_TYPE_COUNT = 6;

export enum BuildingType {
  Castle = 0,
  House = 1,
  Barracks = 2,
  Forge = 3,
  Tower = 4,
  Wall = 5,
  /** player-built mine: passive gold from up to MINE_CAPACITY garrisoned workers (the neutral deposit is Kind.Mine) */
  Mine = 6,
}
export const BUILDING_TYPE_COUNT = 7;

export enum DamageType {
  Slash = 0,
  Pierce = 1,
  Siege = 2,
}
export enum ArmorType {
  Light = 0,
  Heavy = 1,
  Siege = 2,
  Building = 3,
}

export enum UpgradeId {
  MeleeAttack = 0,
  RangedAttack = 1,
  Armor = 2,
  MoveSpeed = 3,
  Range = 4,
  Gather = 5,
}
export const UPGRADE_COUNT = 6;

export enum AbilityId {
  ShieldStance = 0, // soldier
  Volley = 1, // archer
  Incendiary = 2, // catapult
  Militia = 3, // castle
}

/** Current standing order of a unit */
export enum Order {
  None = 0,
  Move = 1,
  AttackMove = 2,
  Attack = 3, // attack specific entity
  Hold = 4,
  Patrol = 5,
  Gather = 6,
  Build = 7,
  Repair = 8,
  ReturnGold = 9,
  /** worker walks into a BuildingType.Mine and disappears inside */
  Garrison = 10,
  /** worker takes an own/allied building apart (progress runs backwards, DISMANTLE_SPEED_PCT of build speed) */
  Dismantle = 11,
}

/** Fine-grained unit state, mostly for view (animation) and gather cycle */
export enum UnitState {
  Idle = 0,
  Moving = 1,
  Attacking = 2,
  Gathering = 3,
  Building = 4,
  Dead = 5,
}

export enum BuildingState {
  Constructing = 0,
  Complete = 1,
}

export enum Tile {
  Grass = 0,
  Water = 1,
  Rock = 2,
  Forest = 3,
  Dirt = 4,
}

export enum CommandType {
  Move = 1,
  AttackMove = 2,
  Attack = 3,
  Stop = 4,
  Hold = 5,
  Patrol = 6,
  Gather = 7,
  Build = 8,
  Repair = 9,
  Train = 10,
  Research = 11,
  CancelQueue = 12,
  Ability = 13,
  SetRally = 14,
  CancelBuilding = 15,
  Surrender = 16,
  VoteDraw = 17,
  /** system command (server) - eliminate a player (disconnect timeout) */
  Eliminate = 18,
  /** workers (ids) enter the mine (target) */
  Garrison = 19,
  /** all workers leave the mine (ids[0]) */
  Ungarrison = 20,
  /** workers (ids) dismantle a friendly building (target) */
  Dismantle = 21,
}

export enum EventType {
  Death = 0,
  Attack = 1, // melee swing / instant ranged shot
  ProjectileLaunch = 2,
  ProjectileLand = 3,
  BuildingPlaced = 4,
  BuildingComplete = 5,
  UnitTrained = 6,
  Deposit = 7,
  MineDepleted = 8,
  Ability = 9,
  PlayerEliminated = 10,
  LastCastleWarning = 11,
  ResearchComplete = 12,
  GameOver = 13,
  Fire = 14,
  BuildingDestroyed = 15,
  Rejected = 16,
  /** a worker entered a mine: a = mine, v = workers inside now */
  Garrison = 17,
  /** gold paid for a kill: a = victim, v = gold, owner = who got it */
  Bounty = 18,
  /** a forest cell burnt down: x,y = cell centre */
  ForestBurnt = 19,
}

export interface SimEvent {
  type: EventType;
  tick: number;
  /** entity id involved (source), -1 if none */
  a: number;
  /** second entity (target) or -1 */
  b: number;
  x: number; // fixed
  y: number; // fixed
  /** extra: unit/building type, ability id, player id, etc. */
  v: number;
  owner: number;
}

export interface Command {
  type: CommandType;
  player: number;
  /** selected entity ids (units or a single building) */
  ids?: number[];
  /** target entity */
  target?: number;
  /** target position (fixed) */
  x?: number;
  y?: number;
  /** generic small int: unit type, building type, upgrade id, ability id, queue index */
  v?: number;
  /** queue this order behind existing (shift) */
  queue?: boolean;
}

export interface PlayerSetup {
  slot: number;
  team: number;
  name: string;
  isBot: boolean;
  difficulty?: 0 | 1 | 2;
  color: number;
}

export interface MatchSetup {
  seed: number;
  mapId: string;
  players: PlayerSetup[];
  /** simulation version, part of replay compatibility */
  version: number;
}

export const SIM_VERSION = 6;

export const PLAYER_COLORS = [
  0xd94141, // red
  0x3d7bd9, // blue
  0x3fae4a, // green
  0xe0b53a, // yellow
  0x9b4fd6, // purple
  0xe57a2f, // orange
];
