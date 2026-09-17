import {
  garrisonCapacity, buildingDamage, TOWER_CAPACITY,
  ABILITIES, AbilityId, BUILDINGS, BUILDING_TYPE_COUNT, BuildingState, BuildingType, Command, CommandType, EventType, FOG_EXPLORED,
  FOG_UNEXPLORED, Kind, MINE_CAPACITY, MINE_GOLD_PER_WORKER, MINE_INCOME_TICKS, REJECT_NAMES, SimEvent, Simulation, TICK_RATE, Tile, UNITS,
  UPGRADES, UnitType, UpgradeId, fp, queueItemIsUpgrade, queueItemUpgrade, toFloat, upgradeCost, ArmorType, DamageType, AGE_UP, queueItemIsAgeUp, AGE_COUNT, maxUpgradeLevel,
  buildingMaxHp,
} from '@rookfall/sim';
import {
  ABILITY_DESC_KEYS, ABILITY_ICONS, ABILITY_KEYS, BUILDING_ICONS, BUILDING_KEYS, TKey, UNIT_ICONS, UNIT_KEYS, UPGRADE_ICONS, UPGRADE_KEYS, formatTime, t,
} from '../i18n';
import { NetClient } from '../net/client';
import { getSettings, subscribeSettings } from '../settings';
import { AudioFx } from './audio';
import { InputController, InputMode } from './input';
import { Models } from './models';
import { Renderer, rendererCaps } from './renderer';
import { Session } from './session';

export interface HudPlayer { slot: number; name: string; color: number; team: number; alive: boolean; isBot: boolean; status: 'ok' | 'disconnected' | 'eliminated'; secondsLeft?: number; gold?: number; pop?: string }
/** one requirement line in a tooltip: green when it is already satisfied, red when it is what blocks the button */
export interface PanelReq { text: string; ok: boolean }
export interface PanelButton {
  id: string; key: string; icon: string;
  /** what fits on the button */
  label: string;
  /** the full name for the tooltip, when the button had to shorten it */
  title?: string;
  cost?: number;
  /** false when the player cannot pay right now - the price is shown in red */
  costOk?: boolean;
  /** build / train / research time in ticks */
  time?: number;
  disabled?: boolean; active?: boolean; cooldown?: number;
  /** what the thing is for, one or two sentences */
  desc?: string;
  /** the numbers that matter: HP, damage, range... */
  stats?: { k: string; v: string }[];
  /** everything the button needs before it can be pressed, satisfied or not */
  reqs?: PanelReq[];
}
export interface SelectionGroup { type: number; count: number; icon: string; label: string; hp: number; ids: number[] }
export interface QueueItem { icon: string; label: string; progress: number }
export interface SelectionInfo {
  ids: number[];
  foreign: boolean;
  primary: {
    id: number; kind: 'unit' | 'building' | 'mine'; type: number; name: string; icon: string; hp: number; maxHp: number; owner: number; ownerName: string; color: number;
    carry?: number; goldLeft?: number; progress?: number; queue?: QueueItem[]; abilityCd?: number; abilityName?: string; buff?: number; stats?: { k: string; v: string }[]; rally?: boolean; upgrades?: string;
    /** workers inside a mine */
    garrison?: { n: number; max: number };
    /** a complete building being taken apart: `progress` is what is left of it */
    dismantling?: boolean;
    /** one-line tip under the stats */
    hint?: string;
  };
  groups: SelectionGroup[];
}
export interface HudMessage { id: number; text: string; from?: string; color?: number; system?: boolean; t: number }
export interface HudToast { id: number; text: string; kind: 'error' | 'warn' | 'info'; t: number }
export interface HudGameOver {
  winnerTeam: number; result: 'victory' | 'defeat' | 'draw' | 'spectator'; duration: string;
  /** we were eliminated but the match continues (FFA/teams): offer to keep watching */
  canContinue: boolean; dismissed: boolean;
  rows: { name: string; color: number; team: number; alive: boolean; trained: number; lost: number; killed: number; razed: number; gold: number }[];
}
export interface HudState {
  tick: number; time: string; gold: number; popUsed: number; popCap: number; mySlot: number; perspective: number;
  /** age of the perspective player (Age enum) */
  age: number;
  players: HudPlayer[]; selection: SelectionInfo | null; panel: PanelButton[]; mode: InputMode; hint: string;
  messages: HudMessage[]; toasts: HudToast[]; gameOver: HudGameOver | null; menuOpen: boolean; chatOpen: boolean;
  replay: { speed: number; paused: boolean; total: number; kind: string } | null; fps: number; ping: number; behind: number; drawCalls: number;
  idleWorkers: number; desync: boolean; connected: boolean; catchingUp: boolean; drag: { x: number; y: number; w: number; h: number } | null; voteDraw: boolean;
}

let msgId = 1;
/** orders that send units somewhere: their routes flash for a moment when given */
const MOVE_COMMANDS = new Set<CommandType>([CommandType.Move, CommandType.AttackMove, CommandType.Patrol, CommandType.Attack, CommandType.Gather, CommandType.Repair, CommandType.Build, CommandType.Garrison, CommandType.Dismantle]);

/** Owns the render loop, input, HUD state and the bridge between simulation events and effects. */
export class GameView {
  readonly sim: Simulation;
  readonly renderer: Renderer;
  readonly input: InputController;
  readonly audio = new AudioFx();
  mySlot: number;
  perspective: number;
  private raf = 0;
  private lastT = performance.now();
  private hudTimer = 0;
  private listeners = new Set<(h: HudState) => void>();
  private messages: HudMessage[] = [];
  private toasts: HudToast[] = [];
  private statuses = new Map<number, { status: 'ok' | 'disconnected' | 'eliminated'; secondsLeft?: number }>();
  private gameOver: HudGameOver | null = null;
  private menuOpen = false;
  private chatOpen = false;
  private desync = false;
  private fps = 0; private frames = 0; private fpsT = 0;
  /** rolling frame times (ms), read by the stress harness - the fps counter above averages hitches away */
  readonly frameMs = new Float32Array(1024);
  frameN = 0;
  private minimap: HTMLCanvasElement | null = null;
  private minimapTerrain: HTMLCanvasElement | null = null;
  private minimapFog: ImageData | null = null;
  private minimapT = 0;
  private unsub: (() => void)[] = [];
  private lastRejectT = 0;
  private disposed = false;
  private panelCache: PanelButton[] = [];
  private lastWarnT = -1e9;

  constructor(readonly canvas: HTMLCanvasElement, readonly session: Session, readonly models: Models, private net: NetClient | null) {
    this.sim = session.sim;
    this.mySlot = session.mySlot;
    this.perspective = session.mySlot >= 0 ? session.mySlot : -1;
    const s = getSettings();
    let alive = 0;
    for (let id = 0; id < this.sim.world.maxId; id++) if (this.sim.world.alive[id] && this.sim.world.kind[id] === Kind.Unit) alive++;
    this.renderer = new Renderer(canvas, this.sim.map, models, s.shadows, rendererCaps(this.sim.players.length, this.sim.map.mines.length, alive));
    this.renderer.perspective = this.perspective;
    this.renderer.revealAll = this.perspective < 0;
    this.renderer.colorblind = s.colorblind;
    this.input = new InputController(canvas, this);
    this.input.attach();
    this.input.onSelectionChanged = () => { this.panelCache = this.buildPanel(); };
    this.input.onToggleChat = (open) => { this.chatOpen = open; this.publish(); };
    this.input.onEscapeMenu = () => this.toggleMenu();
    session.onStep = (events) => this.onEvents(events);
    // camera on own castle
    const w = this.sim.world;
    const start = this.sim.players[Math.max(0, this.perspective)] ?? this.sim.players[0];
    this.renderer.cam.lookAt(start.startX + 0.5, start.startY + 0.5);
    for (let id = 0; id < w.maxId; id++) if (w.alive[id] && w.kind[id] === Kind.Building && w.owner[id] === this.perspective && w.type[id] === BuildingType.Castle) { this.renderer.cam.lookAt(toFloat(w.x[id]), toFloat(w.y[id])); break; }
    this.unsub.push(subscribeSettings(() => {
      const st = getSettings();
      this.renderer.colorblind = st.colorblind;
      this.renderer.setShadows(st.shadows);
      this.audio.setVolume(st.volume);
    }));
    if (net) {
      this.unsub.push(net.on('chat', (m) => this.onNetChat(m.from, m.name, m.text, !!m.system)));
      this.unsub.push(net.on('playerStatus', (m) => { this.statuses.set(m.slot, { status: m.status === 'connected' ? 'ok' : m.status, secondsLeft: m.secondsLeft }); }));
      this.unsub.push(net.on('desync', (m) => { this.desync = true; this.toast(t('msgDesync', { tick: m.tick }), 'error'); }));
      this.unsub.push(net.on('close', () => this.publish()));
      this.unsub.push(net.on('open', () => this.publish()));
    }
    this.panelCache = this.buildPanel();
    window.addEventListener('resize', this.onResize);
  }

  private onResize = () => this.renderer.resize();
  perfReset(): void { this.frameN = 0; }

  start(): void {
    this.lastT = performance.now();
    const loop = (now: number) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - this.lastT) / 1000);
      this.frameMs[this.frameN++ % this.frameMs.length] = now - this.lastT;
      this.lastT = now;
      this.session.update(dt * 1000);
      this.input.update(dt);
      this.input.pruneSelection();
      const sel = new Set(this.input.selected);
      this.renderer.perspective = this.perspective;
      this.renderer.sync(this.sim, this.session.alpha, sel, this.input.hoverId, getSettings().showHealthBars, dt);
      this.renderer.render();
      this.frames++; this.fpsT += dt;
      if (this.fpsT >= 0.5) { this.fps = Math.round(this.frames / this.fpsT); this.frames = 0; this.fpsT = 0; }
      this.hudTimer += dt;
      if (this.hudTimer >= 0.1) { this.hudTimer = 0; this.publish(); }
      this.minimapT += dt;
      if (this.minimapT >= 0.1) { this.minimapT = 0; this.drawMinimap(); }
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.input.detach();
    for (const u of this.unsub) u();
    window.removeEventListener('resize', this.onResize);
    this.session.dispose();
    this.renderer.dispose();
  }

  // ---------------------------------------------------------------- commands

  /** Validate locally and submit. Returns true if accepted. */
  issue(cmd: Command): boolean {
    if (this.session.kind === 'replay' || this.mySlot < 0 || this.sim.gameOver) return false;
    const reason = this.sim.validate(cmd);
    if (reason) {
      const now = performance.now();
      if (now - this.lastRejectT > 400) { this.lastRejectT = now; this.toast(rejectText(reason), 'error'); this.audio.play('error'); }
      return false;
    }
    this.session.submit(cmd);
    if (cmd.ids && MOVE_COMMANDS.has(cmd.type)) this.renderer.flashPath(cmd.ids);
    return true;
  }

  centerOn(x: number, y: number): void { this.renderer.cam.lookAt(x, y); }

  toggleMenu(): void {
    this.menuOpen = !this.menuOpen;
    if (this.session.kind === 'local') this.session.paused = this.menuOpen;
    this.publish();
  }
  closeMenu(): void { if (this.menuOpen) this.toggleMenu(); }

  surrender(): void { this.issue({ type: CommandType.Surrender, player: this.mySlot }); this.closeMenu(); }
  voteDraw(): void { this.issue({ type: CommandType.VoteDraw, player: this.mySlot }); this.closeMenu(); }

  sendChat(text: string): void {
    const s = text.trim();
    this.chatOpen = false; this.input.chatOpen = false;
    if (s) {
      if (this.net && this.session.kind === 'net') this.net.send({ t: 'chat', text: s });
      else this.pushMessage({ id: msgId++, text: s, from: getSettings().name, color: this.mySlot >= 0 ? this.sim.players[this.mySlot].color : 0xffffff, t: performance.now() });
    }
    this.publish();
  }
  openChat(): void { this.chatOpen = true; this.input.chatOpen = true; this.publish(); }

  setSpeed(s: number): void { this.session.speed = s; }
  togglePause(): void { this.session.paused = !this.session.paused; this.publish(); }
  setPerspective(p: number): void {
    this.perspective = p;
    this.renderer.perspective = p;
    this.renderer.revealAll = p < 0;
    this.input.setSelection([]);
    this.minimapFog = null;
  }

  // ---------------------------------------------------------------- events

  private onEvents(events: SimEvent[]): void {
    const cues = this.renderer.handleEvents(events, this.sim);
    const camX = this.renderer.cam.target.x;
    let played = 0;
    for (const c of cues) {
      if (played >= 4) break;
      const pan = Math.max(-1, Math.min(1, (c.x - camX) / 30));
      const name = c.name === 'boulderLaunch' ? null : c.name;
      if (name) { this.audio.play(name as never, pan); played++; }
    }
    const me = this.mySlot;
    for (const e of events) {
      switch (e.type) {
        case EventType.PlayerEliminated: {
          const p = this.sim.players[e.v];
          this.statuses.set(e.v, { status: 'eliminated' });
          this.pushMessage({ id: msgId++, text: t('msgEliminated', { name: p.name }), system: true, t: performance.now() });
          if (e.v === me && !this.sim.gameOver) {
            // we're out but the match goes on: show the defeat screen, allow watching the rest with full vision
            this.buildGameOver('defeat', true);
            this.audio.play('defeat');
            this.setPerspective(-1);
            this.input.setSelection([]);
          }
          break;
        }
        case EventType.LastCastleWarning: {
          if (me < 0) break;
          if (e.owner === me || this.sim.sameTeam(e.owner, me)) {
            if (performance.now() - this.lastWarnT > 8000) {
              this.lastWarnT = performance.now();
              this.toast(t(e.owner === me ? 'msgLastCastle' : 'msgAllyLastCastle'), 'warn');
              this.audio.play('warning');
            }
          }
          break;
        }
        case EventType.BuildingComplete: case EventType.ResearchComplete: if (e.owner === me) this.audio.play('complete'); break;
        case EventType.AgeUp: {
          // everyone learns who moved on to stone
          if (e.owner >= 0) this.toast(t('msgAgeUp', { name: this.sim.players[e.owner].name }), e.owner === me ? 'info' : 'warn');
          if (e.owner === me) { this.audio.play('complete'); this.panelCache = this.buildPanel(); }
          break;
        }
        case EventType.Rejected: if (e.owner === me) { this.toast(rejectText(REJECT_NAMES[e.v] ?? 'rejGeneric'), 'error'); } break;
        case EventType.GameOver: this.onGameOver(); break;
      }
    }
  }

  private onGameOver(): void {
    const sim = this.sim;
    const me = this.mySlot;
    let result: HudGameOver['result'] = 'spectator';
    if (me >= 0) result = sim.winnerTeam < 0 ? 'draw' : sim.players[me].team === sim.winnerTeam ? 'victory' : 'defeat';
    const wasEliminatedEarlier = this.gameOver?.canContinue;
    this.buildGameOver(result, false);
    if (!wasEliminatedEarlier) { if (result === 'victory') this.audio.play('victory'); else if (result === 'defeat') this.audio.play('defeat'); }
    this.publish();
  }

  private buildGameOver(result: HudGameOver['result'], canContinue: boolean): void {
    const sim = this.sim;
    this.gameOver = {
      winnerTeam: sim.winnerTeam, result, duration: formatTime(sim.tick), canContinue, dismissed: false,
      rows: sim.players.map((p) => ({ name: p.name, color: p.color, team: p.team, alive: p.alive, trained: p.unitsTrained, lost: p.unitsLost, killed: p.unitsKilled, razed: p.buildingsRazed, gold: p.goldMined })),
    };
  }

  /** eliminated player chose to keep watching */
  dismissGameOver(): void {
    if (this.gameOver) { this.gameOver.dismissed = true; this.publish(); }
  }

  private onNetChat(from: number, name: string, text: string, system: boolean): void {
    if (system) {
      const [kind, slotS, secs] = text.split(':');
      const slot = Number(slotS);
      const pname = this.sim.players[slot]?.name ?? '?';
      if (kind === 'disconnected') text = t('msgDisconnected', { name: pname, time: formatTime(Number(secs) * 20) });
      else if (kind === 'reconnected') text = t('msgReconnected', { name: pname });
      this.pushMessage({ id: msgId++, text, system: true, t: performance.now() });
      return;
    }
    const color = from >= 0 && from < this.sim.players.length ? this.sim.players[from].color : 0xffffff;
    this.pushMessage({ id: msgId++, text, from: name, color, t: performance.now() });
  }

  private pushMessage(m: HudMessage): void {
    this.messages.push(m);
    if (this.messages.length > 8) this.messages.shift();
  }
  toast(text: string, kind: HudToast['kind']): void {
    this.toasts.push({ id: msgId++, text, kind, t: performance.now() });
    if (this.toasts.length > 4) this.toasts.shift();
    this.publish();
  }

  // ---------------------------------------------------------------- panel

  panelHotkey(key: string): boolean {
    const b = this.panelCache.find((x) => x.key.toLowerCase() === key.toLowerCase() && !x.disabled);
    if (!b) return false;
    this.panelAction(b.id);
    return true;
  }

  panelAction(id: string): void {
    const inp = this.input;
    const me = this.mySlot;
    const units = inp.selectedUnits();
    const b = inp.selectedBuilding();
    const [kind, arg] = id.split(':');
    switch (kind) {
      case 'cancel': inp.setMode('normal'); inp.buildMenu = false; break;
      case 'attackMove': inp.setMode('attackMove'); break;
      case 'patrol': inp.setMode('patrol'); break;
      case 'stop': this.issue({ type: CommandType.Stop, player: me, ids: units }); this.audio.play('order'); break;
      case 'hold': this.issue({ type: CommandType.Hold, player: me, ids: units }); this.audio.play('order'); break;
      case 'build': inp.buildMenu = true; break;
      case 'buildType': inp.buildMenu = false; inp.setMode('build', Number(arg) as BuildingType); break;
      case 'ability': {
        const ab = Number(arg) as AbilityId;
        if (ABILITIES[ab].targeted) inp.setMode('ability', -1, ab);
        else { if (this.issue({ type: CommandType.Ability, player: me, ids: units, v: ab })) this.audio.play('ability'); }
        break;
      }
      case 'militia': if (b >= 0 && this.issue({ type: CommandType.Ability, player: me, ids: [b], v: AbilityId.Militia })) this.audio.play('ability'); break;
      case 'train': if (b >= 0) { if (this.issue({ type: CommandType.Train, player: me, ids: [b], v: Number(arg) })) this.audio.play('coin'); } break;
      case 'research': if (b >= 0) { if (this.issue({ type: CommandType.Research, player: me, ids: [b], v: Number(arg) })) this.audio.play('coin'); } break;
      case 'ageUp': if (b >= 0) { if (this.issue({ type: CommandType.AgeUp, player: me, ids: [b] })) this.audio.play('coin'); } break;
      case 'rally': inp.setMode('rally'); break;
      case 'dismantle': inp.setMode('dismantle'); break;
      case 'cancelBuild': if (b >= 0) this.issue({ type: CommandType.CancelBuilding, player: me, ids: [b] }); break;
      case 'eject': if (b >= 0 && this.issue({ type: CommandType.Ungarrison, player: me, ids: [b] })) this.audio.play('order'); break;
      case 'cancelQueue': if (b >= 0) this.issue({ type: CommandType.CancelQueue, player: me, ids: [b], v: Number(arg) }); break;
    }
    this.panelCache = this.buildPanel();
    this.publish();
  }

  /**
   * The command panel. Every button carries its own tooltip: price, time, the numbers that matter and -
   * the point of the exercise - every requirement, ticked off or not, so "why is this greyed out?" is
   * always answered on the card itself (the second age needs a forge, the catapult needs the second age,
   * this house needs 40 more gold).
   */
  private buildPanel(): PanelButton[] {
    if (this.mySlot < 0 || this.session.kind === 'replay') return [];
    const hk = getSettings().hotkeys;
    const inp = this.input;
    const w = this.sim.world;
    const p = this.sim.players[this.mySlot];
    const out: PanelButton[] = [];
    const cancel: PanelButton = { id: 'cancel', key: 'Escape', icon: '✖', label: t('cancel'), desc: t('cancelDesc') };
    if (inp.mode !== 'normal') return [cancel];
    const gold = (cost: number): PanelReq => ({ text: `${t('cost')}: ${cost} 💰`, ok: p.gold >= cost });
    /** the button gets the short name when there is one, the tooltip always the full one */
    const named = (key: TKey): { label: string; title: string } => {
      const full = t(key);
      return { label: t(`${key}Short` as TKey, undefined, true) ?? full, title: full };
    };
    const ageReq = (age: number): PanelReq => ({ text: `${t('requires')}: ${t('ageUp')}`, ok: p.age >= age });
    const units = inp.selectedUnits();
    if (units.length > 0) {
      const workers = units.filter((id) => w.type[id] === UnitType.Worker);
      const fighters = units.filter((id) => w.type[id] !== UnitType.Worker);
      if (inp.buildMenu) {
        for (let bt = 0; bt < BUILDING_TYPE_COUNT; bt++) {
          const def = BUILDINGS[bt as BuildingType];
          const key = hk[BUILDING_KEYS[bt]] ?? '';
          const hasReq = def.requires < 0 || this.sim.hasBuilding(this.mySlot, def.requires as BuildingType);
          const reqs: PanelReq[] = [];
          if (def.requires >= 0) reqs.push({ text: `${t('requires')}: ${t(BUILDING_KEYS[def.requires as number])}`, ok: hasReq });
          if (def.age > 0) reqs.push(ageReq(def.age));
          reqs.push(gold(def.cost));
          const stats: { k: string; v: string }[] = [
            { k: t('hp'), v: `${buildingMaxHp(bt as BuildingType, p.age)}` },
            { k: t('size'), v: `${def.size}×${def.size}` },
          ];
          if (def.popCap) stats.push({ k: t('pop'), v: `+${def.popCap}` });
          if (def.damage) stats.push({ k: t('damage'), v: `${buildingDamage(bt as BuildingType, p.upgrades[UpgradeId.RangedAttack], p.age, 0)}` }, { k: t('rangeStat'), v: `${def.range}` });
          if (garrisonCapacity(bt as BuildingType) > 0) stats.push({ k: t('workersInside'), v: `${garrisonCapacity(bt as BuildingType)}` });
          out.push({
            id: `buildType:${bt}`, key, icon: BUILDING_ICONS[bt], ...named(BUILDING_KEYS[bt]),
            cost: def.cost, costOk: p.gold >= def.cost, time: def.buildTime,
            disabled: p.gold < def.cost || !hasReq || def.age > p.age,
            desc: t(`${BUILDING_KEYS[bt]}Desc` as TKey), stats, reqs,
          });
        }
        out.push(cancel);
        return out;
      }
      if (fighters.length) out.push({ id: 'attackMove', key: hk.attackMove, icon: '⚔️', ...named('attackMove'), desc: t('attackMoveDesc') });
      out.push({ id: 'stop', key: hk.stop, icon: '🛑', label: t('stop'), desc: t('stopDesc') });
      if (fighters.length) out.push({ id: 'hold', key: hk.hold, icon: '🧱', label: t('hold'), desc: t('holdDesc') });
      if (fighters.length) out.push({ id: 'patrol', key: hk.patrol, icon: '🔁', label: t('patrol'), desc: t('patrolDesc') });
      if (workers.length) out.push({ id: 'build', key: hk.buildMenu, icon: '🏗️', label: t('build'), desc: t('buildDesc') });
      if (workers.length) out.push({ id: 'dismantle', key: hk.dismantle, icon: '🪓', label: t('dismantle'), desc: t('dismantleDesc') });
      // ability of the dominant fighter type
      if (fighters.length) {
        const counts = new Map<number, number>();
        for (const id of fighters) counts.set(w.type[id], (counts.get(w.type[id]) ?? 0) + 1);
        const types = [...counts.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
        for (const ty of types) {
          const ab = UNITS[ty as UnitType].ability as AbilityId;
          if (ab < 0) continue;
          let minCd = 1e9;
          for (const id of fighters) if (w.type[id] === ty) minCd = Math.min(minCd, w.abilityCd[id]);
          out.push({
            id: `ability:${ab}`, key: hk.ability, icon: ABILITY_ICONS[ab], ...named(ABILITY_KEYS[ab]),
            cooldown: minCd > 0 ? minCd / ABILITIES[ab].cooldown : 0, disabled: minCd > 0,
            desc: t(ABILITY_DESC_KEYS[ab]), stats: this.abilityStats(ab, minCd),
          });
          break;
        }
      }
      return out;
    }
    const b = inp.selectedBuilding();
    if (b >= 0) {
      const bt = w.type[b] as BuildingType;
      const def = BUILDINGS[bt];
      if (w.state[b] === BuildingState.Constructing) return [{ id: 'cancelBuild', key: 'x', icon: '✖', label: t('cancelBuild'), desc: t('cancelBuildDesc') }];
      const trainKeys: Record<number, string> = { [UnitType.Worker]: hk.worker, [UnitType.Soldier]: hk.soldier, [UnitType.Archer]: hk.archer, [UnitType.Catapult]: hk.catapult, [UnitType.Cavalry]: hk.cavalry };
      const armorNames: Record<ArmorType, TKey> = { [ArmorType.Light]: 'light', [ArmorType.Heavy]: 'heavy', [ArmorType.Siege]: 'siegeArmor', [ArmorType.Building]: 'building' };
      const dmgNames: Record<DamageType, TKey> = { [DamageType.Slash]: 'slash', [DamageType.Pierce]: 'pierce', [DamageType.Siege]: 'siege' };
      for (const ut of def.trains) {
        const u = UNITS[ut];
        const locked = u.age > p.age; // waits for the next age
        const noPop = p.popUsed + u.pop > p.popCap;
        const reqs: PanelReq[] = [];
        if (u.age > 0) reqs.push(ageReq(u.age));
        reqs.push(gold(u.cost), { text: `${t('pop')}: ${u.pop} (${p.popUsed}/${p.popCap})`, ok: !noPop });
        out.push({
          id: `train:${ut}`, key: trainKeys[ut], icon: UNIT_ICONS[ut], label: t(UNIT_KEYS[ut]),
          cost: u.cost, costOk: p.gold >= u.cost, time: u.trainTime,
          disabled: locked || p.gold < u.cost || noPop,
          desc: t(`${UNIT_KEYS[ut]}Desc` as TKey),
          stats: [
            { k: t('hp'), v: `${u.hp}` },
            { k: t('damage'), v: `${u.damage} (${t(dmgNames[u.damageType])})` },
            { k: t('armorType'), v: t(armorNames[u.armor]) },
            { k: t('rangeStat'), v: `${u.range}${u.minRange ? ` (min ${u.minRange})` : ''}` },
            { k: t('speedStat'), v: `${u.speed}` },
          ],
          reqs,
        });
      }
      if (bt === BuildingType.Forge) {
        const keys = [hk.upgMelee, hk.upgRanged, hk.upgArmor, hk.upgSpeed, hk.upgRange, hk.upgGather];
        for (let u = 0; u < 6; u++) {
          const lvl = p.upgrades[u];
          const max = UPGRADES[u as UpgradeId].levels;
          const ageMax = maxUpgradeLevel(u as UpgradeId, p.age); // deeper levels open with the next age
          const maxed = lvl >= max;
          const cost = maxed ? 0 : upgradeCost(u as UpgradeId, lvl + 1);
          const reqs: PanelReq[] = [];
          if (maxed) reqs.push({ text: t('rejMaxLevel'), ok: false });
          else if (lvl >= ageMax) reqs.push(ageReq(1));
          if (!maxed) reqs.push(gold(cost));
          const name = named(UPGRADE_KEYS[u]);
          out.push({
            id: `research:${u}`, key: keys[u], icon: UPGRADE_ICONS[u], label: `${name.label} ${lvl}/${max}`, title: `${name.title} ${lvl}/${max}`,
            cost: maxed ? undefined : cost, costOk: p.gold >= cost, time: maxed ? undefined : UPGRADES[u as UpgradeId].time[lvl],
            disabled: lvl >= ageMax || p.gold < cost,
            desc: t(`${UPGRADE_KEYS[u]}Desc` as TKey),
            stats: [{ k: t('level'), v: `${lvl} → ${Math.min(lvl + 1, max)} (${t('max')} ${max})` }],
            reqs,
          });
        }
      }
      if (bt === BuildingType.Castle && p.age < AGE_COUNT - 1) {
        const hasForge = AGE_UP.requires < 0 || this.sim.hasBuilding(this.mySlot, AGE_UP.requires as BuildingType);
        out.push({
          id: 'ageUp', key: hk.ageUp, icon: '🏛️', label: t('ageUp'),
          cost: AGE_UP.cost, costOk: p.gold >= AGE_UP.cost, time: AGE_UP.time,
          disabled: !hasForge || p.gold < AGE_UP.cost,
          desc: t('ageUpDesc'),
          reqs: [{ text: `${t('requires')}: ${t('forge')}`, ok: hasForge }, gold(AGE_UP.cost)],
        });
      }
      if (bt === BuildingType.Castle) {
        const cd = w.abilityCd[b];
        out.push({
          id: 'militia', key: hk.militia, icon: ABILITY_ICONS[AbilityId.Militia], ...named('militiaCall'),
          cooldown: cd > 0 ? cd / ABILITIES[AbilityId.Militia].cooldown : 0, disabled: cd > 0,
          desc: t('militiaDesc'), stats: this.abilityStats(AbilityId.Militia, cd),
        });
      }
      if (garrisonCapacity(bt) > 0 && w.carry[b] > 0) out.push({ id: 'eject', key: hk.eject, icon: '🚪', label: t('eject'), desc: t('ejectDesc') });
      if (def.trains.length) out.push({ id: 'rally', key: hk.rally, icon: '🚩', label: t('rally'), desc: t('hintRally') });
      return out;
    }
    return out;
  }

  /** cooldown / duration lines shared by every ability button */
  private abilityStats(ab: AbilityId, cdLeft: number): { k: string; v: string }[] {
    const def = ABILITIES[ab];
    const stats = [{ k: t('cooldown'), v: `${Math.round(def.cooldown / TICK_RATE)} ${t('sec')}` }];
    if (def.duration) stats.push({ k: t('durationStat'), v: `${Math.round(def.duration / TICK_RATE)} ${t('sec')}` });
    if (cdLeft > 0) stats.push({ k: t('ready'), v: `${Math.ceil(cdLeft / TICK_RATE)} ${t('sec')}` });
    return stats;
  }

  // ---------------------------------------------------------------- HUD state

  subscribe(fn: (h: HudState) => void): () => void {
    this.listeners.add(fn);
    fn(this.buildHud());
    return () => { this.listeners.delete(fn); };
  }
  private publish(): void {
    if (this.listeners.size === 0) return;
    const h = this.buildHud();
    for (const l of this.listeners) l(h);
  }

  private buildHud(): HudState {
    const sim = this.sim;
    const me = this.perspective;
    const now = performance.now();
    this.toasts = this.toasts.filter((x) => now - x.t < 4000);
    this.messages = this.messages.filter((x) => now - x.t < 15000 || this.chatOpen);
    const w = sim.world;
    let idle = 0;
    if (me >= 0) for (let id = 0; id < w.maxId; id++) if (w.alive[id] && w.kind[id] === Kind.Unit && w.owner[id] === me && w.type[id] === UnitType.Worker && w.order[id] === 0) idle++;
    const p = me >= 0 ? sim.players[me] : null;
    this.panelCache = this.buildPanel();
    const drag = this.input.drag;
    const rect = this.canvas.getBoundingClientRect();
    return {
      tick: sim.tick, time: formatTime(sim.tick), gold: p?.gold ?? 0, popUsed: p?.popUsed ?? 0, popCap: p?.popCap ?? 0, mySlot: this.mySlot, perspective: me, age: p?.age ?? 0,
      players: sim.players.map((pl) => {
        const st = this.statuses.get(pl.id);
        return { slot: pl.id, name: pl.name, color: pl.color, team: pl.team, alive: pl.alive, isBot: pl.isBot, status: !pl.alive ? 'eliminated' : st?.status ?? 'ok', secondsLeft: st?.secondsLeft, gold: this.mySlot < 0 ? pl.gold : undefined, pop: this.mySlot < 0 ? `${pl.popUsed}/${pl.popCap}` : undefined };
      }),
      selection: this.selectionInfo(), panel: this.panelCache, mode: this.input.mode, hint: this.hint(),
      messages: this.messages.slice(), toasts: this.toasts.slice(), gameOver: this.gameOver, menuOpen: this.menuOpen, chatOpen: this.chatOpen,
      replay: this.session.kind === 'replay' ? { speed: this.session.speed, paused: this.session.paused, total: (this.session as unknown as { totalTicks: number }).totalTicks, kind: 'replay' } : null,
      fps: this.fps, ping: this.net?.ping ?? 0, behind: (this.session as unknown as { behind?: number }).behind ?? 0, drawCalls: this.renderer.drawCalls,
      idleWorkers: idle, desync: this.desync, connected: this.session.kind !== 'net' || !!this.net?.connected, catchingUp: this.session.catchingUp,
      drag: drag ? { x: Math.min(drag.x0, drag.x1) - rect.left, y: Math.min(drag.y0, drag.y1) - rect.top, w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) } : null,
      voteDraw: p?.votedDraw ?? false,
    };
  }

  private hint(): string {
    const m = this.input.mode;
    if (m === 'build' && this.input.buildType === BuildingType.Wall) return t('hintBuildLine');
    if (m === 'build' && this.input.buildType >= 0) return t('hintBuild', { name: t(BUILDING_KEYS[this.input.buildType]) });
    if (m === 'attackMove') return t('hintAttack');
    if (m === 'patrol') return t('hintPatrol');
    if (m === 'ability') return t('hintAbility');
    if (m === 'rally') return t('hintRally');
    if (m === 'dismantle') return t('hintDismantle');
    return '';
  }

  private selectionInfo(): SelectionInfo | null {
    const ids = this.input.selected;
    if (ids.length === 0) return null;
    const sim = this.sim, w = sim.world;
    const first = ids[0];
    if (!w.alive[first]) return null;
    const k = w.kind[first];
    const owner = w.owner[first];
    const foreign = owner !== this.perspective;
    const ownerName = owner >= 0 ? sim.players[owner].name : '—';
    const color = owner >= 0 ? sim.players[owner].color : 0xbbbbbb;
    const groups: SelectionGroup[] = [];
    if (k === Kind.Unit) {
      const byType = new Map<number, number[]>();
      for (const id of ids) { if (!w.alive[id]) continue; const l = byType.get(w.type[id]) ?? []; l.push(id); byType.set(w.type[id], l); }
      for (const [type, list] of byType) {
        let hp = 0; for (const id of list) hp += w.hp[id] / w.maxHp[id];
        groups.push({ type, count: list.length, icon: UNIT_ICONS[type], label: t(UNIT_KEYS[type]), hp: hp / list.length, ids: list });
      }
      groups.sort((a, b) => a.type - b.type);
    }
    let primary: SelectionInfo['primary'];
    if (k === Kind.Unit) {
      const def = UNITS[w.type[first] as UnitType];
      const pl = owner >= 0 ? sim.players[owner] : null;
      const dmg = owner >= 0 ? sim.unitDamage(first) : def.damage;
      const armorNames: Record<ArmorType, TKey> = { [ArmorType.Light]: 'light', [ArmorType.Heavy]: 'heavy', [ArmorType.Siege]: 'siegeArmor', [ArmorType.Building]: 'building' };
      const dmgNames: Record<DamageType, TKey> = { [DamageType.Slash]: 'slash', [DamageType.Pierce]: 'pierce', [DamageType.Siege]: 'siege' };
      primary = {
        id: first, kind: 'unit', type: w.type[first], name: t(UNIT_KEYS[w.type[first]]), icon: UNIT_ICONS[w.type[first]], hp: w.hp[first], maxHp: w.maxHp[first], owner, ownerName, color,
        carry: w.type[first] === UnitType.Worker ? w.carry[first] : undefined,
        abilityCd: def.ability >= 0 ? w.abilityCd[first] : undefined, abilityName: def.ability >= 0 ? t(ABILITY_KEYS[def.ability]) : undefined, buff: w.buff[first],
        stats: [
          { k: t('damage'), v: `${dmg} (${t(dmgNames[def.damageType])})` },
          { k: t('armorType'), v: `${t(armorNames[def.armor])}${pl && pl.upgrades[UpgradeId.Armor] ? ` +${pl.upgrades[UpgradeId.Armor]}` : ''}` },
          { k: t('rangeStat'), v: `${owner >= 0 ? toFloat(sim.unitRange(first)) : def.range}${def.minRange ? ` (min ${def.minRange})` : ''}` },
          { k: t('speedStat'), v: `${def.speed}` },
        ],
      };
    } else if (k === Kind.Building) {
      const bt = w.type[first] as BuildingType;
      const def = BUILDINGS[bt];
      const constructing = w.state[first] === BuildingState.Constructing;
      const dismantling = !constructing && w.progress[first] < def.buildTime * 10;
      const queue: QueueItem[] = [];
      const pl = owner >= 0 ? sim.players[owner] : null;
      for (let i = 0; i < w.queueLen[first]; i++) {
        const item = w.qGet(first, i);
        if (queueItemIsAgeUp(item)) {
          queue.push({ icon: '🏛️', label: t('ageUp'), progress: i === 0 ? w.prodProgress[first] / AGE_UP.time : 0 });
        } else if (queueItemIsUpgrade(item)) {
          const u = queueItemUpgrade(item);
          const need = UPGRADES[u].time[Math.min((pl?.upgrades[u] ?? 0), UPGRADES[u].levels - 1)];
          queue.push({ icon: UPGRADE_ICONS[u], label: t(UPGRADE_KEYS[u]), progress: i === 0 ? w.prodProgress[first] / need : 0 });
        } else queue.push({ icon: UNIT_ICONS[item], label: t(UNIT_KEYS[item]), progress: i === 0 ? w.prodProgress[first] / UNITS[item as UnitType].trainTime : 0 });
      }
      primary = {
        id: first, kind: 'building', type: bt, name: t(BUILDING_KEYS[bt]), icon: BUILDING_ICONS[bt], hp: w.hp[first], maxHp: w.maxHp[first], owner, ownerName, color,
        progress: constructing || dismantling ? w.progress[first] / (def.buildTime * 10) : undefined, dismantling, queue, rally: w.rallyX[first] >= 0,
        buff: constructing ? w.buff[first] : undefined,
        abilityCd: bt === BuildingType.Castle ? w.abilityCd[first] : undefined,
        garrison: garrisonCapacity(bt) > 0 && !constructing ? { n: w.carry[first], max: garrisonCapacity(bt) } : undefined,
        hint: !constructing && !foreign && w.lifetime[first] === 1 ? t('popBlocked')
          : bt === BuildingType.Mine && !constructing && !foreign && w.carry[first] < MINE_CAPACITY ? t('mineHint')
          : bt === BuildingType.Tower && !constructing && !foreign && w.carry[first] < TOWER_CAPACITY ? t('towerHint') : undefined,
        stats: def.damage ? [{ k: t('damage'), v: `${buildingDamage(bt, pl?.upgrades[UpgradeId.RangedAttack] ?? 0, pl?.age ?? 0, w.carry[first])}` }, { k: t('rangeStat'), v: `${toFloat(sim.buildingRange(first))}` }] // from the walls, like a unit's range
          : bt === BuildingType.Mine && !constructing ? [{ k: t('income'), v: `+${Math.round((w.carry[first] * MINE_GOLD_PER_WORKER * 60 * TICK_RATE) / MINE_INCOME_TICKS)}${t('perMin')}` }]
          : [],
        upgrades: pl && bt === BuildingType.Forge ? UPGRADE_KEYS.map((key, i) => `${UPGRADE_ICONS[i]}${pl.upgrades[i]}`).join(' ') : undefined,
      };
    } else {
      primary = { id: first, kind: 'mine', type: 0, name: t('mine'), icon: '⛰️', hp: w.hp[first], maxHp: w.maxHp[first], owner: -1, ownerName: '—', color: 0xe0b53a, goldLeft: w.hp[first] };
    }
    return { ids: ids.slice(), foreign, primary, groups };
  }

  selectGroup(ids: number[]): void { this.input.setSelection(ids); this.publish(); }

  // ---------------------------------------------------------------- minimap

  setMinimapCanvas(c: HTMLCanvasElement | null): void {
    this.minimap = c;
    if (c) this.drawMinimap();
  }

  private ensureMinimapTerrain(): HTMLCanvasElement {
    if (this.minimapTerrain) return this.minimapTerrain;
    const map = this.sim.map;
    const c = document.createElement('canvas'); c.width = map.w; c.height = map.h;
    const g = c.getContext('2d')!;
    const img = g.createImageData(map.w, map.h);
    const cols: Record<number, [number, number, number]> = { [Tile.Grass]: [96, 150, 70], [Tile.Water]: [58, 111, 158], [Tile.Rock]: [110, 112, 108], [Tile.Forest]: [58, 105, 45], [Tile.Dirt]: [150, 125, 85] };
    for (let i = 0; i < map.tiles.length; i++) {
      const [r, gg, b] = cols[map.tiles[i]] ?? cols[0];
      img.data[i * 4] = r; img.data[i * 4 + 1] = gg; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    this.minimapTerrain = c;
    return c;
  }

  private drawMinimap(): void {
    const c = this.minimap;
    if (!c) return;
    const map = this.sim.map, sim = this.sim, w = sim.world;
    const size = c.width;
    const g = c.getContext('2d')!;
    const sx = size / map.w, sy = size / map.h;
    g.imageSmoothingEnabled = false;
    g.drawImage(this.ensureMinimapTerrain(), 0, 0, size, size);
    const persp = this.perspective;
    const reveal = persp < 0;
    if (!reveal) {
      if (!this.minimapFog) this.minimapFog = new ImageData(map.w, map.h);
      const vis = sim.fog.vis[persp];
      const d = this.minimapFog.data;
      for (let i = 0; i < vis.length; i++) { d[i * 4] = 0; d[i * 4 + 1] = 0; d[i * 4 + 2] = 0; d[i * 4 + 3] = vis[i] === FOG_UNEXPLORED ? 225 : vis[i] === FOG_EXPLORED ? 110 : 0; }
      const tmp = this.fogCanvas ?? (this.fogCanvas = document.createElement('canvas'));
      tmp.width = map.w; tmp.height = map.h;
      tmp.getContext('2d')!.putImageData(this.minimapFog, 0, 0);
      g.drawImage(tmp, 0, 0, size, size);
    }
    const cb = getSettings().colorblind;
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id]) continue;
      const k = w.kind[id];
      if (k !== Kind.Unit && k !== Kind.Building && k !== Kind.Mine) continue;
      if (!reveal && !sim.visibleTo(persp, id) && !(k !== Kind.Unit && sim.fog.isExplored(persp, w.x[id], w.y[id]))) continue;
      const x = toFloat(w.x[id]) * sx, y = toFloat(w.y[id]) * sy;
      if (k === Kind.Mine) { g.fillStyle = '#e0b53a'; g.fillRect(x - 2, y - 2, 4, 4); continue; }
      const o = w.owner[id];
      const col = '#' + sim.players[o].color.toString(16).padStart(6, '0');
      g.fillStyle = col;
      if (k === Kind.Building) { const s = w.size[id] * sx; g.fillRect(x - s / 2, y - s / 2, s, s); if (cb && persp >= 0 && !sim.sameTeam(o, persp)) { g.strokeStyle = '#fff'; g.strokeRect(x - s / 2, y - s / 2, s, s); } }
      else if (cb && persp >= 0 && !sim.sameTeam(o, persp)) { g.beginPath(); g.moveTo(x, y - 2.5); g.lineTo(x + 2.5, y + 2); g.lineTo(x - 2.5, y + 2); g.closePath(); g.fill(); }
      else g.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
    // camera frustum
    const cam = this.renderer.cam;
    const corners = [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([nx, ny]) => cam.groundPoint(nx, ny, new (Object.getPrototypeOf(cam.target).constructor)()));
    g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 1;
    g.beginPath();
    corners.forEach((p, i) => { if (!p) return; const px = Math.min(map.w, Math.max(0, p.x)) * sx, py = Math.min(map.h, Math.max(0, p.z)) * sy; if (i === 0) g.moveTo(px, py); else g.lineTo(px, py); });
    g.closePath(); g.stroke();
  }
  private fogCanvas: HTMLCanvasElement | null = null;

  minimapClick(px: number, py: number, button: number, shift: boolean): void {
    const map = this.sim.map;
    const x = px * map.w, y = py * map.h;
    if (button === 2) {
      const units = this.input.selectedUnits();
      if (units.length) { this.issue({ type: CommandType.Move, player: this.mySlot, ids: units, x: fp(x), y: fp(y), queue: shift }); this.audio.play('order'); }
    } else this.centerOn(x, y);
  }
}

function rejectText(reason: string): string {
  const map: Record<string, TKey> = {
    noGold: 'rejNoGold', noPop: 'rejNoPop', requires: 'rejRequires', blocked: 'rejBlocked', unexplored: 'rejUnexplored', mineFull: 'rejMineFull', lastCastle: 'rejLastCastle', age: 'rejAge',
    cooldown: 'rejCooldown', range: 'rejRange', queueFull: 'rejQueueFull', maxLevel: 'rejMaxLevel', alreadyQueued: 'rejAlreadyQueued',
  };
  return t(map[reason] ?? 'rejGeneric');
}

export const _keys = { FOG_EXPLORED, FOG_UNEXPLORED };
