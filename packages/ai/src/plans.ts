import { MAX_POP } from '@pocket-of-empire/sim';

export type Difficulty = 0 | 1 | 2;

/**
 * How well a bot plays, and nothing about what it plays. Everything here is a measure of skill - how often it
 * looks at the board, how many orders it gets out, how fast it reacts, whether it micros at all. What gets
 * built is the plan's business (see Strategy), so that every plan is available at every difficulty: an easy
 * turtle really does fence itself in, it just does it slowly, with a worse army and no micro to hold the wall.
 */
export interface Profile {
  thinkInterval: number;
  apm: number;
  attackPop: number;
  attackPopGrowth: number;
  micro: boolean;
  upgrades: boolean;
  scout: boolean;
  retreatHpPct: number;
  reactionTicks: number;
  /**
   * How much of its plan's building appetite this bot actually gets through, in percent. This is how a plan
   * stays available at every level without an easy bot playing it as well as a hard one: an easy turtle walls
   * itself in with half the towers and half the bases, which still reads as a turtle across the map and still
   * loses to a medium one.
   */
  ambitionPct: number;
}

/**
 * How many diggers the bot is willing to put on one vein before it starts sending the rest to another
 * deposit. The vein itself takes any number; this is only the point past which spreading out shortens
 * more walks than it lengthens.
 */
export const MINE_CROWD = 8;
/**
 * How many workers one vein is worth hiring for. Higher than MINE_CROWD because a crowded deposit is a
 * longer queue of walkers, not a closed door - the marginal digger is worth less, never nothing. Measured on
 * duel-valley: 10 diggers bring 788 gold a minute, 20 bring 1348, 30 bring 1860 - near enough linear, so the
 * old 10 left half a base's income unmined for the first eight minutes.
 */
export const WORKERS_PER_VEIN = 16;
/** the plain worker line, in percent of the population cap: what a plan falls back to once its opening is over */
export const WORKER_POP_PCT = 25;

export const PROFILES: Record<Difficulty, Profile> = {
  0: { thinkInterval: 30, apm: 3, attackPop: 18, attackPopGrowth: 4, micro: false, upgrades: false, scout: false, retreatHpPct: 0, reactionTicks: 60, ambitionPct: 45 },
  1: { thinkInterval: 15, apm: 6, attackPop: 22, attackPopGrowth: 4, micro: true, upgrades: true, scout: true, retreatHpPct: 25, reactionTicks: 30, ambitionPct: 100 },
  2: { thinkInterval: 8, apm: 12, attackPop: 20, attackPopGrowth: 6, micro: true, upgrades: true, scout: true, retreatHpPct: 30, reactionTicks: 10, ambitionPct: 130 },
};

/** ticks in a minute of match time */
export const MINUTE = 20 * 60;

/**
 * What a bot is playing *for*. The difficulty says how well it plays - how often it thinks, how many orders it
 * gets out, whether it micros at all. The strategy says what it does with that skill, and it is rolled per bot
 * from the match seed, so two medium bots in the same game open differently and end up with bases that read
 * differently from across the map: a rusher with two barracks and nothing behind them, a turtle inside a fence
 * ring with towers beside its gates.
 */
export enum Strategy {
  /** barracks first, walks out with the first handful of men and keeps coming */
  Rush = 0,
  /** every free vein, then the population cap, then everything it owns walks out at once */
  Boom = 1,
  /** fences the base in, mans the towers when pressed, and only marches once the wall stands */
  Fortify = 2,
  /** forge before the second barracks: rams early, catapults later, and it aims at masonry */
  Siege = 3,
  /** saves, then walks a line of watchtowers at the enemy, each one covered by the last */
  Creep = 4,
}

export const STRATEGY_NAMES: Record<Strategy, string> = {
  [Strategy.Rush]: 'rush', [Strategy.Boom]: 'boom', [Strategy.Fortify]: 'fortify',
  [Strategy.Siege]: 'siege', [Strategy.Creep]: 'creep',
};

export interface Plan {
  /** percent of the difficulty's attack threshold: 60 walks out on half an army, 150 sits on a big one */
  attackPopPct: number;
  /** percent of the difficulty's per-wave growth: how much bigger the next wave has to be after a beating */
  wavePct: number;
  /**
   * The wave this plan is really after, as a percent of the population cap. This is how a massing plan is
   * written: not "a bit more than my difficulty's threshold" but "most of what the cap allows", so it keeps
   * building until the barracks have filled the map's worth of men and then sends all of them at once.
   */
  wavePopPct: number;
  /**
   * The worker line, as a percent of the population cap. A bot is held to the same MAX_POP as a player and to
   * nothing else - no difficulty of its own - so this is a choice about the shape of its army, the way a
   * player choosing thirty diggers over twenty is: every point spent on gold is a point not spent on men.
   */
  workerPct: number;
  /** workers on gold before the first barracks goes down */
  barracksWorkers: number;
  /** gold in hand before another barracks: an aggressive opening wants the second one much sooner */
  barracks2Gold: number;
  /**
   * Barracks it is willing to run. This is what actually decides how big an army a plan can field: a soldier
   * takes twenty seconds whatever the treasury looks like, so two barracks are six men a minute and no amount
   * of gold makes them seven. A plan that means to walk out with the population cap needs the halls to build it.
   */
  barracks: number;
  /** watchtowers around the home base */
  towers: number;
  /** watchtowers on top of that, all of them facing the enemy: a front is worth more than a flank */
  frontTowers: number;
  /** and more of both for every castle past the first - a second base wants its own cover */
  towersPerCastle: number;
  /** it walks a line of towers at the enemy, each new one inside the cover of the last */
  creep: boolean;
  /**
   * Castles it saves up for. Past this it still expands, up to the sim's BUILDING_LIMIT, but only out of gold
   * it has no other use for (see EXTRA_CASTLE_MARGIN) - a greedy plan will take every free vein on the map.
   */
  castles: number;
  /** how far ahead of the population cap it puts houses up: a plan that means to hit 60 cannot wait for 56 */
  popBuffer: number;
  /**
   * How many sides of the ring this plan pays for, walled in threat order: the side the enemy lives on, then
   * the flanks, then the back. Four is a ring; fewer is a barricade across the way in. Nearly every plan wants
   * the ring - a walled town with gates and towers is simply how a base should look - and what separates them
   * is `wallAfter`.
   */
  wallSides: number;
  /**
   * First tick it will lay a section. A plan whose whole idea is to be at the enemy early has better uses for
   * its opening gold than masonry, so it fences once the push is out rather than before it. Being attacked
   * twice at home overrides this: a bot under pressure walls up whatever its plan said (see wallLimit).
   */
  wallAfter: number;
  /** dig its own mine before it spends on a second barracks or a forge */
  mineFirst: boolean;
  /** first tick it digs a mine of its own at all: an opening that is all men has no gold for a hole in the ground */
  minesAfter: number;
  /** the forge comes before the second barracks, and rams come with the first wave */
  siegeFirst: boolean;
  /** first tick it will even consider a second castle */
  expandAfter: number;
  /** first tick it starts holding gold back for the second age (catapults, cavalry, stone walls) */
  ageAfter: number;
  /** the age is bought before a second castle, not after it - a catapult plan is nothing in the wooden age */
  ageFirst: boolean;
  /** from this tick the plan stops holding it home - no strategy is an excuse to never attack */
  pushAfter: number;
  /** where the idle army waits, in percent of the way from the castle to the map centre */
  rallyPct: number;
  /**
   * Share of the army, by population, that stays home when a wave goes out. A plan built on holding its ground
   * does not empty its walls for an attack: the one time it did, the enemy walked in behind the wave.
   */
  homeGuardPct: number;
  /** percent weights on the counter-pick shares: soldier, archer, catapult, cavalry */
  mixPct: [number, number, number, number];
}

export const PLANS: Record<Strategy, Plan> = {
  [Strategy.Rush]: {
    attackPopPct: 65, wavePct: 180, wavePopPct: 15, workerPct: 18, barracksWorkers: 4, barracks2Gold: 180, barracks: 4,
    towers: 0, frontTowers: 0, towersPerCastle: 0, creep: false, castles: 3, popBuffer: 4,
    wallSides: 4, wallAfter: 9 * MINUTE, mineFirst: false, minesAfter: 8 * MINUTE, siegeFirst: false,
    expandAfter: 7 * MINUTE, ageAfter: 10 * MINUTE, ageFirst: false, pushAfter: 0, rallyPct: 32, homeGuardPct: 0, mixPct: [130, 90, 40, 120],
  },
  [Strategy.Boom]: {
    attackPopPct: 160, wavePct: 100, wavePopPct: 50, workerPct: 30, barracksWorkers: 6, barracks2Gold: 300, barracks: 5,
    towers: 1, frontTowers: 2, towersPerCastle: 1, creep: false, castles: 6, popBuffer: 10,
    wallSides: 2, wallAfter: 10 * MINUTE, mineFirst: true, minesAfter: 0, siegeFirst: false,
    expandAfter: 4 * MINUTE, ageAfter: 6 * MINUTE, ageFirst: false, pushAfter: 14 * MINUTE, rallyPct: 22, homeGuardPct: 15, mixPct: [100, 100, 100, 100],
  },
  [Strategy.Fortify]: {
    attackPopPct: 130, wavePct: 100, wavePopPct: 55, workerPct: 28, barracksWorkers: 5, barracks2Gold: 300, barracks: 5,
    towers: 2, frontTowers: 3, towersPerCastle: 2, creep: false, castles: 4, popBuffer: 6,
    wallSides: 4, wallAfter: 0, mineFirst: true, minesAfter: 0, siegeFirst: false,
    expandAfter: 5 * MINUTE, ageAfter: 7 * MINUTE, ageFirst: false, pushAfter: 10 * MINUTE, rallyPct: 6, homeGuardPct: 25, mixPct: [105, 130, 120, 60],
  },
  [Strategy.Siege]: {
    attackPopPct: 120, wavePct: 130, wavePopPct: 45, workerPct: 25, barracksWorkers: 5, barracks2Gold: 300, barracks: 4,
    towers: 1, frontTowers: 1, towersPerCastle: 1, creep: false, castles: 4, popBuffer: 5,
    wallSides: 2, wallAfter: 9 * MINUTE, mineFirst: false, minesAfter: 0, siegeFirst: true,
    expandAfter: 5 * MINUTE, ageAfter: 4 * MINUTE, ageFirst: true, pushAfter: 12 * MINUTE, rallyPct: 22, homeGuardPct: 10, mixPct: [100, 90, 170, 90],
  },
  [Strategy.Creep]: {
    // it barely attacks with men at all: the towers do the walking, and the army is their escort
    attackPopPct: 130, wavePct: 100, wavePopPct: 60, workerPct: 27, barracksWorkers: 6, barracks2Gold: 320, barracks: 3,
    towers: 2, frontTowers: 6, towersPerCastle: 1, creep: true, castles: 5, popBuffer: 6,
    wallSides: 4, wallAfter: 5 * MINUTE, mineFirst: true, minesAfter: 0, siegeFirst: false,
    expandAfter: 5 * MINUTE, ageAfter: 8 * MINUTE, ageFirst: false, pushAfter: 10 * MINUTE, rallyPct: 10, homeGuardPct: 25, mixPct: [100, 130, 100, 70],
  },
};

/**
 * Which plans a difficulty may roll, with repeats for weight. Every plan is on every list: a plan is what a bot
 * is trying to do, and there is no reason an easy bot cannot try to wall itself in or walk a line of towers at
 * you - it will simply do it worse. The weights differ because the harder profiles get more out of the plans
 * that ask for more orders, not because a plan is off limits.
 */
export const STRATEGY_POOL: Record<Difficulty, Strategy[]> = {
  0: [Strategy.Rush, Strategy.Rush, Strategy.Boom, Strategy.Boom, Strategy.Fortify, Strategy.Siege, Strategy.Creep],
  1: [Strategy.Rush, Strategy.Rush, Strategy.Boom, Strategy.Boom, Strategy.Fortify, Strategy.Fortify, Strategy.Siege, Strategy.Siege, Strategy.Creep, Strategy.Creep],
  2: [Strategy.Rush, Strategy.Boom, Strategy.Boom, Strategy.Fortify, Strategy.Fortify, Strategy.Siege, Strategy.Creep],
};

/**
 * Twelve directions round a circle as integer vectors scaled by 1000. The bots must produce byte-identical
 * commands on every peer, and `Math.sin`/`Math.atan2` are not guaranteed to agree between engines, so every
 * angle in this file is a vector out of this table (see DESIGN: determinism).
 */
export const DIRS: readonly (readonly [number, number])[] = [
  [1000, 0], [866, 500], [500, 866], [0, 1000], [-500, 866], [-866, 500],
  [-1000, 0], [-866, -500], [-500, -866], [0, -1000], [500, -866], [866, -500],
];

export interface KnownBuilding { id: number; gen: number; x: number; y: number; type: number; owner: number; lastSeen: number }

export interface Snapshot {
  /** workers standing on the map - the ones that can be sent somewhere */
  workers: number[];
  /**
   * every worker the bot owns, the ones sitting inside mines and towers too. The size of the economy is read
   * off this: with all three mines staffed, nine workers are out of `workers`, and a bot that measured itself
   * by the ones outside thought it was too poor to ever take a second base.
   */
  workforce: number;
  army: number[];
  byType: number[][];
  buildings: number[];
  complete: number[][];
  constructing: number[][];
  castles: number[];
  enemyUnits: number[];
  enemyByType: number[];
  enemyBuildings: number[];
  idleWorkers: number[];
  gold: number;
  popUsed: number;
  popCap: number;
}
