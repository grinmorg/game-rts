import { UNITS } from './data';
import { FP_ONE } from './fixed';
import type { Simulation } from './sim';
import { Age, BuildingState, BuildingType, EventType, Kind, TICK_RATE, UnitType } from './types';

/**
 * What the post-match screen plots, one series per player:
 * `army` - gold worth of the fighting units alive, `workers` - workers alive (inside mines and towers
 * too), `mined` - gold brought home so far, `kills` - enemy units killed so far.
 */
export const SUMMARY_METRICS = ['army', 'workers', 'mined', 'kills'] as const;
export type SummaryMetric = (typeof SUMMARY_METRICS)[number];

/** bumps when the shape of MatchSummary changes; a reader skips a summary it does not know */
export const SUMMARY_VERSION = 1;
/** ticks between two chart samples: ten seconds of simulation */
export const SUMMARY_SAMPLE_TICKS = 10 * TICK_RATE;
/** militia are free, but a fight between them is still a fight: this is what one counts for */
const MILITIA_VALUE = 35;

// what a battle is - see findBattles
/** a death this close (cells) to a fight's centre belongs to it */
const BATTLE_RADIUS = 10;
/** the window the densest moment is looked for in */
const BATTLE_WINDOW_TICKS = 30 * TICK_RATE;
/** a lull this long ends a fight */
const BATTLE_GAP_TICKS = 12 * TICK_RATE;
/** smaller clashes are skirmishes, not moments worth a link */
const BATTLE_MIN_VALUE = 300;
const BATTLE_MIN_DEATHS = 5;
const MAX_BATTLES = 2;
/** seeds tried before giving up: a long match full of small clashes must not cost a quadratic scan per clash */
const MAX_SEEDS = 40;
/** a link to a battle starts this long before its first death, so the viewer sees the armies meet */
export const BATTLE_LEAD_IN_TICKS = 10 * TICK_RATE;

export interface BattleMoment {
  /** the fight's first and last death (ticks) */
  start: number;
  end: number;
  /** centre of the fight in map cells, weighted by what died where */
  x: number;
  y: number;
  /** gold worth of everything that died in it, and the number of units */
  value: number;
  deaths: number;
  /** units lost by each player (index = player id) */
  losses: number[];
}

export interface SummaryTotals { trained: number; lost: number; killed: number; razed: number; mined: number }

export interface MatchSummary {
  v: number;
  /** ticks between samples: sample i is taken at tick i * every, the last one at `end` */
  every: number;
  end: number;
  /** [metric][player][sample] */
  series: Record<SummaryMetric, number[][]>;
  /** tick each player reached the second age, -1 if they never did */
  ageUp: number[];
  /** tick each player was knocked out, -1 if they lasted */
  out: number[];
  /** the results table, so a summary read without the replay still has it */
  totals: SummaryTotals[];
  /** the biggest fights, biggest first */
  battles: BattleMoment[];
}

interface Death { t: number; x: number; y: number; value: number; owner: number }

/**
 * Watches a match tick by tick and turns it into a MatchSummary: the chart samples and the deaths the
 * battles are found in. Everything is read from the simulation after `step` and nothing is written back,
 * so a recorder never changes a match; the server, a skirmish tab and a replay viewer all build the same
 * summary out of the same ticks.
 */
export class SummaryRecorder {
  private readonly series: Record<SummaryMetric, number[][]>;
  private readonly ageUp: number[];
  private readonly deaths: Death[] = [];
  private lastSample = -1;
  private readonly armyScratch: number[];
  private readonly workerScratch: number[];

  constructor(sim: Simulation) {
    const n = sim.players.length;
    this.series = { army: [], workers: [], mined: [], kills: [] };
    for (const m of SUMMARY_METRICS) for (let p = 0; p < n; p++) this.series[m].push([]);
    this.ageUp = new Array<number>(n).fill(-1);
    this.armyScratch = new Array<number>(n).fill(0);
    this.workerScratch = new Array<number>(n).fill(0);
    if (sim.tick % SUMMARY_SAMPLE_TICKS === 0) this.sample(sim);
  }

  /** feed the tick the simulation has just stepped */
  observe(sim: Simulation): void {
    for (const e of sim.events) {
      if (e.type === EventType.Death) {
        // only the killed count: not the army that vanishes with a knocked-out player, nor a militiaman whose time ran out
        if (e.owner < 0 || e.b !== 1) continue;
        const cost = UNITS[e.v as UnitType]?.cost ?? 0;
        this.deaths.push({ t: e.tick, x: e.x, y: e.y, value: e.v === UnitType.Militia ? MILITIA_VALUE : cost, owner: e.owner });
      } else if (e.type === EventType.AgeUp && e.owner >= 0 && e.v >= Age.Second && this.ageUp[e.owner] < 0) {
        this.ageUp[e.owner] = e.tick;
      }
    }
    if (sim.tick % SUMMARY_SAMPLE_TICKS === 0) this.sample(sim);
  }

  /**
   * The summary so far. It can be asked for mid-match (a replay saved from the pause menu) and asked again
   * later: the last sample, taken now, is added to a copy and never to the recorder's own series.
   */
  finish(sim: Simulation): MatchSummary {
    const series = {} as Record<SummaryMetric, number[][]>;
    for (const m of SUMMARY_METRICS) series[m] = this.series[m].map((s) => s.slice());
    if (this.lastSample !== sim.tick) {
      const now = this.measure(sim);
      for (const m of SUMMARY_METRICS) now[m].forEach((v, p) => series[m][p].push(v));
    }
    return {
      v: SUMMARY_VERSION,
      every: SUMMARY_SAMPLE_TICKS,
      end: sim.tick,
      series,
      ageUp: this.ageUp.slice(),
      out: sim.players.map((p) => p.eliminatedTick),
      totals: sim.players.map((p) => ({ trained: p.unitsTrained, lost: p.unitsLost, killed: p.unitsKilled, razed: p.buildingsRazed, mined: p.goldMined })),
      battles: findBattles(this.deaths, sim.players.length),
    };
  }

  private sample(sim: Simulation): void {
    const now = this.measure(sim);
    for (const m of SUMMARY_METRICS) now[m].forEach((v, p) => this.series[m][p].push(v));
    this.lastSample = sim.tick;
  }

  private measure(sim: Simulation): Record<SummaryMetric, number[]> {
    const w = sim.world;
    const army = this.armyScratch.fill(0);
    const workers = this.workerScratch.fill(0);
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id]) continue;
      const o = w.owner[id];
      if (o < 0 || o >= army.length) continue;
      if (w.kind[id] === Kind.Unit) {
        const ty = w.type[id] as UnitType;
        if (ty === UnitType.Worker) workers[o]++;
        else army[o] += ty === UnitType.Militia ? MILITIA_VALUE : UNITS[ty].cost;
      } else if (w.kind[id] === Kind.Building && w.state[id] === BuildingState.Complete
        && (w.type[id] === BuildingType.Mine || w.type[id] === BuildingType.Tower)) {
        workers[o] += w.carry[id]; // the garrison: workers sitting inside
      }
    }
    return {
      army: army.slice(),
      workers: workers.slice(),
      mined: sim.players.map((p) => p.goldMined),
      kills: sim.players.map((p) => p.unitsKilled),
    };
  }
}

/**
 * The biggest fights of a match. A fight is seeded at the death with the most gold dying around it -
 * within BATTLE_RADIUS cells and half a BATTLE_WINDOW either side - and then grows from the deaths near
 * that seed's centre for as long as they keep coming, one at most BATTLE_GAP after the last. Its deaths
 * are taken out and the next seed is looked for among the rest; a second fight has to be a separate one
 * in time too, so the two never share a stretch of the timeline.
 */
export function findBattles(deaths: readonly Death[], players: number): BattleMoment[] {
  const r2 = (BATTLE_RADIUS * FP_ONE) ** 2;
  const near = (a: Death, x: number, y: number) => (a.x - x) ** 2 + (a.y - y) ** 2 <= r2;
  const taken = new Uint8Array(deaths.length);
  const out: BattleMoment[] = [];
  const half = BATTLE_WINDOW_TICKS / 2;
  for (let tries = 0; out.length < MAX_BATTLES && tries < MAX_SEEDS; tries++) {
    // the seed: the densest death still free
    let best = -1, bestScore = 0, lo = 0;
    for (let i = 0; i < deaths.length; i++) {
      if (taken[i]) continue;
      const d = deaths[i];
      while (deaths[lo].t < d.t - half) lo++;
      let score = 0;
      for (let j = lo; j < deaths.length && deaths[j].t <= d.t + half; j++) if (!taken[j] && near(deaths[j], d.x, d.y)) score += deaths[j].value;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best < 0 || bestScore < BATTLE_MIN_VALUE) break;
    // the centre of the densest window, weighted by value
    const seed = deaths[best];
    let sx = 0, sy = 0, sw = 0;
    for (let j = 0; j < deaths.length; j++) {
      const d = deaths[j];
      if (taken[j] || d.t < seed.t - half || d.t > seed.t + half || !near(d, seed.x, seed.y)) continue;
      const wt = d.value || 1;
      sx += d.x * wt; sy += d.y * wt; sw += wt;
    }
    const cx = sx / sw, cy = sy / sw;
    // grow both ways from the seed while the next death near the centre comes soon enough
    const members = [best];
    let start = seed.t, end = seed.t;
    for (let j = best + 1; j < deaths.length && deaths[j].t <= end + BATTLE_GAP_TICKS; j++) {
      if (!taken[j] && near(deaths[j], cx, cy)) { members.push(j); end = Math.max(end, deaths[j].t); }
    }
    for (let j = best - 1; j >= 0 && deaths[j].t >= start - BATTLE_GAP_TICKS; j--) {
      if (!taken[j] && near(deaths[j], cx, cy)) { members.push(j); start = Math.min(start, deaths[j].t); }
    }
    let value = 0, mx = 0, my = 0, mw = 0;
    const losses = new Array<number>(players).fill(0);
    for (const j of members) {
      const d = deaths[j];
      taken[j] = 1;
      value += d.value;
      const wt = d.value || 1;
      mx += d.x * wt; my += d.y * wt; mw += wt;
      if (d.owner >= 0 && d.owner < players) losses[d.owner]++;
    }
    if (members.length < BATTLE_MIN_DEATHS || value < BATTLE_MIN_VALUE) continue; // too small: its deaths stay out of the next seed
    if (out.some((b) => start <= b.end + BATTLE_GAP_TICKS && end >= b.start - BATTLE_GAP_TICKS)) continue;
    out.push({
      start, end,
      x: Math.round((mx / mw / FP_ONE) * 10) / 10,
      y: Math.round((my / mw / FP_ONE) * 10) / 10,
      value, deaths: members.length, losses,
    });
  }
  return out.sort((a, b) => b.value - a.value);
}

/** tick of chart sample i */
export function sampleTick(s: MatchSummary, i: number): number {
  return Math.min(i * s.every, s.end);
}

/** where a link to a battle starts playing */
export function battlePlayFrom(b: BattleMoment): number {
  return Math.max(0, b.start - BATTLE_LEAD_IN_TICKS);
}
