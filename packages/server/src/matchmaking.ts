import { QueueState, RANKED_SPEEDS } from '@rookfall/protocol';

export interface Ticket<T> {
  client: T;
  /** ladder key - two connections of the same profile are never matched against each other */
  key: string;
  rating: number;
  rd: number;
  speed: number;
  /** ms timestamp the client entered the queue */
  since: number;
}

/**
 * How wide a rating window a ticket accepts (PRD 7.6): +-50 for the first 20 seconds, then +-25 more
 * every 10 seconds, capped at +-400. A profile the ladder is still unsure about (high RD: placement
 * games, or a long break) starts wide, because its rating carries little information anyway.
 */
export function searchWindow(waitedSec: number, rd: number): number {
  const base = 50 + 25 * Math.max(0, Math.floor((waitedSec - 20) / 10));
  const uncertain = rd > 100 ? Math.min(150, Math.round(rd - 100)) : 0;
  return Math.min(400, base + uncertain);
}

/** 1v1 queue, one per match speed. Nothing persists: a restart empties it and clients re-queue. */
export class Matchmaker<T> {
  private tickets: Ticket<T>[] = [];

  join(t: Ticket<T>): void {
    this.leave(t.client);
    if (!RANKED_SPEEDS.includes(t.speed as never)) return;
    this.tickets.push(t);
  }

  leave(client: T): boolean {
    const n = this.tickets.length;
    this.tickets = this.tickets.filter((t) => t.client !== client);
    return this.tickets.length !== n;
  }

  has(client: T): boolean { return this.tickets.some((t) => t.client === client); }

  state(client: T, now = Date.now()): QueueState | null {
    const t = this.tickets.find((x) => x.client === client);
    if (!t) return null;
    const waiting = Math.floor((now - t.since) / 1000);
    return { speed: t.speed, waiting, size: this.tickets.filter((x) => x.speed === t.speed).length, range: searchWindow(waiting, t.rd) };
  }

  get size(): number { return this.tickets.length; }

  /**
   * Take everyone who can be paired right now. Longest-waiting ticket first, and it gets the closest
   * rating inside either side's window, so a player who has waited a long time can pull in a newcomer.
   */
  pop(now = Date.now()): [Ticket<T>, Ticket<T>][] {
    const queue = [...this.tickets].sort((a, b) => a.since - b.since);
    const used = new Set<Ticket<T>>();
    const pairs: [Ticket<T>, Ticket<T>][] = [];
    const windowOf = (t: Ticket<T>) => searchWindow((now - t.since) / 1000, t.rd);
    for (const t of queue) {
      if (used.has(t)) continue;
      let best: Ticket<T> | null = null, bestDiff = Infinity;
      for (const o of queue) {
        if (o === t || used.has(o) || o.speed !== t.speed || o.key === t.key) continue;
        const diff = Math.abs(o.rating - t.rating);
        if (diff > Math.max(windowOf(t), windowOf(o))) continue;
        if (diff < bestDiff) { best = o; bestDiff = diff; }
      }
      if (best) { used.add(t); used.add(best); pairs.push([t, best]); }
    }
    if (used.size) this.tickets = this.tickets.filter((t) => !used.has(t));
    return pairs;
  }
}
