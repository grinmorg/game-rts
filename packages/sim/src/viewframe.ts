import { LayerDelta } from './path';
import type { Player, Simulation } from './sim';
import { SimEvent } from './types';
import { WorldSnapshot } from './world';

/**
 * What a view needs of a simulation to show a tick, without running it: the world, the players, the events since
 * the last frame, and whatever of the fog, the passability layers and the ground has changed. The simulation runs
 * elsewhere - a worker in this tab, later the server - and a view keeps a copy of it that is never stepped, only
 * brought up to date with these (Simulation.applyViewFrame). Plain data, its arrays transferable.
 */
export interface ViewFrame {
  tick: number;
  gameOver: boolean;
  winnerTeam: number;
  /** every event since the last frame, in order */
  events: SimEvent[];
  players: Player[];
  world: WorldSnapshot;
  /** team buffers that are new to the view or have moved on, with the fog revision they are at */
  fog: { revision: number; buffers: [number, Uint8Array][] } | null;
  layers: LayerDelta | null;
  /** the map's tiles, when fire has changed them */
  tiles: Uint8Array | null;
  terrainRevision: number;
  burning: number[];
}

/** arrays of the world only the simulation itself reads: the order queues */
const VIEW_SKIP = new Set(['oq']);

/** Builds the frames a view of `sim` is kept up to date with (see ViewFrame). One writer per view. */
export class ViewFrameWriter {
  private fogRevision = -1;
  /** team buffers the view holds at fogRevision */
  private fogSent = new Set<number>();
  private terrainRevision: number;

  constructor(private readonly sim: Simulation) {
    sim.path.trackLayers();
    this.terrainRevision = sim.terrainRevision;
  }

  /**
   * The simulation was put back to another moment (Simulation.restore): the next frame carries everything - the
   * whole of the layers, the fog of every watched team, the ground - instead of what changed.
   */
  resync(): void {
    this.fogRevision = -1;
    this.fogSent.clear();
    this.terrainRevision = -1;
    this.sim.path.markAllDirty();
  }

  /** the frame for the state the simulation is in now; `watch` = the players whose fog the view looks through */
  frame(events: SimEvent[], watch: readonly number[]): ViewFrame {
    const sim = this.sim;
    const moved = sim.fog.revision !== this.fogRevision;
    if (moved) { this.fogSent.clear(); this.fogRevision = sim.fog.revision; }
    const buffers: [number, Uint8Array][] = [];
    for (const p of watch) {
      if (p < 0 || p >= sim.players.length) continue;
      const bi = sim.fog.bufferOf(p);
      if (this.fogSent.has(bi)) continue;
      this.fogSent.add(bi);
      buffers.push([bi, sim.fog.copyBuffer(bi)]);
    }
    let tiles: Uint8Array | null = null;
    if (sim.terrainRevision !== this.terrainRevision) { this.terrainRevision = sim.terrainRevision; tiles = sim.map.tiles.slice(); }
    return {
      tick: sim.tick, gameOver: sim.gameOver, winnerTeam: sim.winnerTeam, events,
      players: sim.players.map((p) => ({ ...p, upgrades: p.upgrades.slice() })),
      world: sim.world.snapshot(VIEW_SKIP),
      fog: moved || buffers.length ? { revision: sim.fog.revision, buffers } : null,
      layers: sim.path.takeLayerDelta(),
      tiles, terrainRevision: sim.terrainRevision, burning: sim.burning.slice(),
    };
  }
}
