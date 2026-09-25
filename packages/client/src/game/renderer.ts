import * as THREE from 'three';
import {
  ABILITIES, AGE_COUNT, AbilityId, Age, BUILDINGS, BUILDING_TYPE_COUNT, BuildingState, BuildingType, EventType, FOG_VISIBLE, Kind, MapData, SimEvent, Simulation, Tile,
  FINE_SHIFT, GATE_LENGTH, GATE_TUNNEL, GOLD_PER_TRIP, MAX_ENTITIES, MAX_POP, Order, Pathfinder, SUB, SUB_SHIFT, UNITS, UNIT_TYPE_COUNT, UNREACHABLE, UnitState, UnitType, UpgradeId, buildingRangeCells, fp, isHeavy, toFloat,
} from '@rookfall/sim';
import { CameraController } from './camera';
import { Decals, Particles } from './effects';
import { BUILD_STAGES, DOOR_SWING, ModelGeo, Models, buildStage } from './models';

const PLAYER_COLOR_OBJS: THREE.Color[] = [];
function playerColor(c: number): THREE.Color {
  let o = PLAYER_COLOR_OBJS.find((x) => x.getHex() === c);
  if (!o) { o = new THREE.Color(c); PLAYER_COLOR_OBJS.push(o); }
  return o;
}
const NEUTRAL = new THREE.Color(0xbbbbbb);
const GHOST = new THREE.Color(0x777777);
/** fence neighbour bits, see Renderer.wallLinks */
const WALL_N = 1, WALL_E = 2, WALL_S = 4, WALL_W = 8;
/** how close one of its own units has to come for a gate to open, in cells, and how long the leaves take to swing */
const GATE_SWING_R = 2.4;
const GATE_SWING_TIME = 0.45;
/** ground palette: each tile blends between two tones by a slow noise, edges fade across one cell */
const GRASS_A = new THREE.Color(0x6aa845), GRASS_B = new THREE.Color(0x86c25c);
const FOREST_A = new THREE.Color(0x3f7530), FOREST_B = new THREE.Color(0x55913d);
const ROCK_A = new THREE.Color(0x76786f), ROCK_B = new THREE.Color(0x8e918a);
const DIRT_A = new THREE.Color(0x9c7f52), DIRT_B = new THREE.Color(0xb5975f);
const WATER_C = new THREE.Color(0x3a6f9e);
/** at most this many unit routes are drawn per frame, dashes every DASH_STEP cells */
const PATH_LINE_CAP = 24;

/**
 * Instance-set sizes. They are hard caps - anything past them is silently not drawn - so they are derived from
 * what the match can actually field rather than guessed (see rendererCaps).
 */
export interface RendererCaps { units: number; buildings: number; walls: number; mines: number }
const DEFAULT_CAPS: RendererCaps = { units: 600, buildings: 96, walls: 512, mines: 32 };
/**
 * Caps for a match: every player at the population cap, all of one type, plus room for a builder's fences.
 * `alreadyAlive` covers a world that starts out populated (the load-test harness), where the population cap
 * says nothing about how many units are actually on the field.
 */
export function rendererCaps(players: number, mines: number, alreadyAlive = 0): RendererCaps {
  const units = Math.min(MAX_ENTITIES, Math.max(600, players * MAX_POP * 2, Math.ceil(alreadyAlive * 1.3)));
  return { units, buildings: Math.max(96, players * 24), walls: Math.max(512, players * 96), mines: Math.max(32, mines * 2) };
}
const DASH_STEP = 0.7;
/** seconds the catapult arm swing plays after a launch event */
const SWING_DUR = 0.75;
/** arrows one archer puts into the sky on a volley */
const VOLLEY_ARROWS = 5;

/** status badges drawn once into canvases: 0 = red figure (empty mine), 1 = red "population full" badge */
const ICON_WORKER = 0, ICON_POP = 1;
function makeIconTexture(kind: number): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d')!;
  const figure = (cx: number, top: number, sc: number) => {
    g.beginPath(); g.arc(cx, top + 10 * sc, 10 * sc, 0, Math.PI * 2); g.closePath();
    g.moveTo(cx - 18 * sc, top + 54 * sc); g.lineTo(cx - 18 * sc, top + 34 * sc); g.quadraticCurveTo(cx - 18 * sc, top + 22 * sc, cx, top + 22 * sc);
    g.quadraticCurveTo(cx + 18 * sc, top + 22 * sc, cx + 18 * sc, top + 34 * sc); g.lineTo(cx + 18 * sc, top + 54 * sc); g.closePath();
  };
  if (kind === ICON_WORKER) {
    g.lineWidth = 6; g.strokeStyle = 'rgba(40, 8, 8, 0.9)'; g.fillStyle = '#e8453c';
    figure(32, 6, 1); g.stroke(); figure(32, 6, 1); g.fill();
  } else {
    // red rounded badge, two white figures, a plus in the corner: "population is full, build a house"
    g.fillStyle = '#e8453c'; g.strokeStyle = 'rgba(40, 8, 8, 0.9)'; g.lineWidth = 4;
    g.beginPath(); g.roundRect(4, 4, 56, 56, 12); g.fill(); g.stroke();
    g.fillStyle = '#fff';
    figure(22, 16, 0.6); g.fill(); figure(40, 16, 0.6); g.fill();
    g.fillRect(44, 8, 14, 4); g.fillRect(49, 3, 4, 14);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
/** units are drawn larger than their collision footprint for readability (PRD §4.9: >= 24 px at max zoom) */
const UNIT_SCALE = 1.3;

export interface GroundPoint { x: number; y: number }

/** Shared fog uniforms injected into every lit material. */
interface FogUniforms { fogTex: { value: THREE.DataTexture }; mapSize: { value: THREE.Vector2 }; fogOn: { value: number } }

function injectFog(mat: THREE.Material, u: FogUniforms, extraVertex?: (s: THREE.WebGLProgramParametersWithUniforms) => void) {
  mat.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, u);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n{ vec4 wp = vec4(transformed, 1.0);\n#ifdef USE_INSTANCING\n wp = instanceMatrix * wp;\n#endif\n vWPos = (modelMatrix * wp).xyz; }');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; uniform sampler2D fogTex; uniform vec2 mapSize; uniform float fogOn;')
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
      { float f = texture2D(fogTex, vWPos.xz / mapSize).r;
        float vis = smoothstep(0.55, 0.95, f); float expl = smoothstep(0.05, 0.4, f);
        vec3 grey = vec3(dot(gl_FragColor.rgb, vec3(0.3, 0.59, 0.11)));
        vec3 dim = mix(gl_FragColor.rgb, grey, 0.45) * 0.5;
        vec3 dark = gl_FragColor.rgb * 0.08;
        vec3 fogged = mix(mix(dark, dim, expl), gl_FragColor.rgb, vis);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, fogged, fogOn); }`);
    extraVertex?.(s);
  };
}

/** Vertex-color + team-color + procedural animation material for instanced sets. */
function makeInstancedMaterial(u: FogUniforms, anim: boolean, hipY: number, shoulderY: number, transparentGhost = false): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: transparentGhost, opacity: transparentGhost ? 0.55 : 1 });
  const own = { hipY: { value: hipY }, shoulderY: { value: shoulderY } };
  injectFog(mat, u, (s) => {
    Object.assign(s.uniforms, own);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float teamMask; attribute float part; attribute vec4 aAnim; uniform float hipY; uniform float shoulderY;
        vec2 rot2(vec2 v, float a){ float c = cos(a), s = sin(a); return vec2(v.x * c - v.y * s, v.x * s + v.y * c); }`)
      .replace('#include <color_vertex>', `
        vColor = vec3(1.0);
        #ifdef USE_COLOR
          vColor = color;
        #endif
        #ifdef USE_INSTANCING_COLOR
          vColor = mix(vColor, instanceColor.xyz, teamMask);
        #endif`)
      .replace('#include <begin_vertex>', anim ? `
        vec3 transformed = vec3(position);
        { int st = int(aAnim.x + 0.5); float ph = aAnim.y; float dth = aAnim.w; int p = int(part + 0.5);
          if (p == 1 || p == 2) { float sw = (st == 1) ? sin(ph * 6.2831 + (p == 2 ? 3.1416 : 0.0)) * 0.6 : 0.0;
            transformed.yz = rot2(transformed.yz - vec2(hipY, 0.0), sw) + vec2(hipY, 0.0); }
          // aAnim.z = hauling a load: both arms brace around it instead of swinging
          float load = aAnim.z;
          if (p == 3 || p == 7) { float a = 0.0; if (st == 1) a = sin(ph * 6.2831) * 0.4;
            else if (st >= 2 && st <= 4) { float t = fract(ph); a = (t < 0.35) ? -1.7 * sin(t / 0.35 * 3.1416) : 0.0; }
            if (load > 0.5) a = 0.0;
            transformed.yz = rot2(transformed.yz - vec2(shoulderY, 0.0), a) + vec2(shoulderY, 0.0); }
          if (p == 4) { float a = (st == 1) ? -sin(ph * 6.2831) * 0.4 : ((st == 2) ? -0.3 : 0.0);
            if (load > 0.5) a = 0.0;
            transformed.yz = rot2(transformed.yz - vec2(shoulderY, 0.0), a) + vec2(shoulderY, 0.0); }
          // the tool in the hands (7) and the load in their place (8) are never drawn at the same time
          if ((p == 7 && load > 0.5) || (p == 8 && load < 0.5)) transformed = vec3(0.0);
          if (p == 6) { float a = 0.0; if (st == 2) { float t = fract(ph); a = (t < 0.25) ? 1.4 * sin(t / 0.25 * 3.1416) : 0.0; }
            transformed.yz = rot2(transformed.yz - vec2(0.3, 0.2), a) + vec2(0.3, 0.2); }
          // 9 = the ram's log: it does not turn on a pivot, it runs forward on its ropes and comes back
          if (p == 9 && st == 2) { float t = fract(ph); transformed.z += (t < 0.3 ? sin(t / 0.3 * 3.1416) : 0.0) * 0.3; }
          if (st == 0) transformed.y += sin(ph * 3.1416) * 0.008;
          if (st == 1 && p == 0) transformed.y += abs(sin(ph * 6.2831)) * 0.03;
          if (st == 5) { transformed.yz = rot2(transformed.yz, -min(dth, 1.0) * 1.45); transformed.y -= max(0.0, dth - 0.8) * 0.5; }
        }` : `
        vec3 transformed = vec3(position);
        { float prog = aAnim.y; if (prog < 1.0) { transformed.y *= 0.12 + 0.88 * prog; } }`);
  });
  mat.customProgramCacheKey = () => (anim ? 'inst-anim' : 'inst-static') + (transparentGhost ? '-ghost' : '');
  return mat;
}

class InstanceSet {
  readonly mesh: THREE.InstancedMesh;
  private anim: THREE.InstancedBufferAttribute;
  private mat4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private sc = new THREE.Vector3();
  private axisY = new THREE.Vector3(0, 1, 0);
  private axisX = new THREE.Vector3(1, 0, 0);
  private qPitch = new THREE.Quaternion();
  count = 0;
  readonly cap: number;
  constructor(geo: THREE.BufferGeometry, material: THREE.Material, cap: number, shadows: boolean) {
    this.cap = cap;
    const g = geo.clone();
    this.anim = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.anim.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aAnim', this.anim);
    this.mesh = new THREE.InstancedMesh(g, material, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = shadows; this.mesh.receiveShadow = shadows;
    this.mesh.setColorAt(0, NEUTRAL);
    this.mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
  }
  begin() { this.count = 0; }
  /** `pitch` tips the instance nose-down around its own X axis; arrows use it to follow their arc */
  add(x: number, y: number, z: number, rotY: number, scale: number, color: THREE.Color, a0: number, a1: number, a2: number, a3: number, pitch = 0) {
    if (this.count >= this.cap) return;
    const i = this.count++;
    this.q.setFromAxisAngle(this.axisY, rotY);
    if (pitch) this.q.multiply(this.qPitch.setFromAxisAngle(this.axisX, pitch));
    this.v.set(x, y, z); this.sc.set(scale, scale, scale);
    this.mat4.compose(this.v, this.q, this.sc);
    this.mesh.setMatrixAt(i, this.mat4);
    this.mesh.setColorAt(i, color);
    this.anim.setXYZW(i, a0, a1, a2, a3);
  }
  end() {
    this.mesh.count = this.count;
    // an empty set must cost nothing: three.js skips an invisible object before it uploads its buffers, while a
    // visible one re-uploads all of them whatever its count - most sets are empty most of the time (docs/PERF.md §4.1)
    this.mesh.visible = this.count > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
    this.anim.needsUpdate = true;
  }
}

interface Corpse { type: number; owner: number; x: number; z: number; rot: number; t: number; /** owner's age at death: which model set the body comes from */ age: number }
/** Visual-only arrow on a parabola: `lift` is the height of the arc, `puff` kicks up dust where it sticks.
 *  A negative `t` staggers a volley so the flight does not leave every bow at the same instant. */
interface Arrow { fx: number; fy: number; fz: number; tx: number; ty: number; tz: number; t: number; dur: number; lift: number; puff: boolean }
interface Marker { x: number; z: number; t: number; color: THREE.Color }
interface KnownBuilding { id: number; gen: number; type: number; owner: number; x: number; z: number; progress: number; links: number; /** owner's age when last seen: the model set it is drawn from */ age: number; /** gate slot of a fence cell when last seen, see Pathfinder.gateAt */ gate: number }

export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly cam: CameraController;
  readonly particles: Particles;
  readonly decals: Decals;
  perspective = 0;
  revealAll = false;
  private fogTex: THREE.DataTexture;
  private fogData: Uint8Array;
  private fogRevision = -1;
  private fogU: FogUniforms;
  private heights: Float32Array;
  private W: number; private H: number;
  /** [type][stage] - each construction stage is its own model, so it needs its own instance set */
  /** [age][type][stage] - wood in the first age, stone in the second */
  private buildingSets: InstanceSet[][][] = [];
  private ghostSets: InstanceSet[][][] = [];
  private wallHalfSet: InstanceSet[] = [];
  private wallHalfGhost: InstanceSet[] = [];
  /** gateSets[age][0 = open, 1 = barred], see Models.gates */
  private gateSets: InstanceSet[][] = [];
  private gateGhost: InstanceSet[][] = [];
  /** gateLeafSets[age][0 = left, 1 = right]: the door leaves, drawn at the swing angle (see Models.gateLeaves) */
  private gateLeafSets: InstanceSet[][] = [];
  private gateLeafGhost: InstanceSet[][] = [];
  /** how far each gate stands open, 0..1, by the id of the fence cell that carries the gatehouse */
  private gateSwings = new Map<number, number>();
  /** [age][type]: iron-clad variants in the second age */
  private unitSets: InstanceSet[][] = [];
  /** gold deposit variants, one set per model (see Models.mines) */
  private mineSets: InstanceSet[] = [];
  private iconMeshes: THREE.InstancedMesh[] = [];
  private iconCounts = [0, 0];
  /** ghost cells of a fence line being dragged out */
  private placementLine: THREE.InstancedMesh;
  private decorSets: InstanceSet[] = [];
  private terrainChunks: { mesh: THREE.Mesh; cx0: number; cy0: number; w: number; h: number }[] = [];
  private terrainRevision = -1;
  /** building health rings: fraction in aAnim.x, alpha in aAnim.y */
  private hpRingSet: InstanceSet;
  /** view-only copy of the pathfinder for drawing routes - never touches the sim's field budget */
  private viewPath: Pathfinder;
  private viewPathVersion = -1;
  /** route dashes: flat quads laid along traced paths */
  private dashSet: InstanceSet;
  private routeColor = new THREE.Color(0xe8f0ff);
  /** units whose route is shown briefly after an order, id -> time (s) until */
  private pathFlash = new Map<number, number>();
  private ringSet: InstanceSet;
  private barSet: InstanceSet;
  private arrowSet: InstanceSet;
  private boulderSet: InstanceSet;
  private markerSet: InstanceSet;
  private fireSet: InstanceSet;
  private rangeSet: InstanceSet;
  private placementRange: THREE.Mesh;
  private facing = new Float32Array(MAX_ENTITIES);
  private phase = new Float32Array(MAX_ENTITIES);
  /** seconds left of a catapult arm swing triggered by a launch event (view only) */
  private swing = new Float32Array(MAX_ENTITIES);
  private corpses: Corpse[] = [];
  private arrows: Arrow[] = [];
  private markers: Marker[] = [];
  private known = new Map<number, KnownBuilding>();
  /** per-frame scratch of sync(), kept so a frame does not allocate them */
  private wallCells = new Set<number>();
  private seenBuildings = new Set<number>();
  private camRight = new THREE.Vector3();
  private camUp = new THREE.Vector3();
  private camFwd = new THREE.Vector3();
  private barM = new THREE.Matrix4();
  /** x,z pairs of the route being traced: 600 flow steps plus both ends */
  private routePts = new Float32Array(2 * 602);
  /** everything that takes the sun's shadow when shadows are on, see setShadows */
  private shadowReceivers: THREE.Object3D[] = [];
  private sun: THREE.DirectionalLight;
  private placement: THREE.Mesh;
  private tmpV = new THREE.Vector3();
  private tmpDir = new THREE.Vector3();
  private lastTime = performance.now();
  private white = new THREE.Color(0xffffff);
  private rangeDim = new THREE.Color(0x8a8a8a);
  private selColor = new THREE.Color(0x7fe08a);
  private placeOkColor = new THREE.Color(0x4ad35a);
  private placeBadColor = new THREE.Color(0xe04a4a);
  private enemySel = new THREE.Color(0xff6b6b);
  private allySel = new THREE.Color(0x7fb8ff);
  private hpGreen = new THREE.Color(0x4ad35a);
  private hpOrange = new THREE.Color(0xf0a030);
  private hpRed = new THREE.Color(0xe04a4a);
  private buildRing = new THREE.Color(0xe3c576);
  private hpDark = new THREE.Color(0x3a1414);
  private mapW: number;
  private mapH: number;
  private map: MapData;
  shadows = true;
  drawCalls = 0;

  constructor(readonly canvas: HTMLCanvasElement, map: MapData, readonly models: Models, shadows: boolean, caps: RendererCaps = DEFAULT_CAPS) {
    this.map = map;
    this.mapW = map.w; this.mapH = map.h;
    this.shadows = shadows;
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.gl.shadowMap.enabled = shadows;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color(0x0e131c);
    this.cam = new CameraController(canvas.clientWidth / Math.max(1, canvas.clientHeight));
    this.cam.setBounds(map.w, map.h);

    // fog texture
    this.fogData = new Uint8Array(map.w * map.h);
    this.fogTex = new THREE.DataTexture(this.fogData, map.w, map.h, THREE.RedFormat, THREE.UnsignedByteType);
    this.fogTex.minFilter = THREE.LinearFilter; this.fogTex.magFilter = THREE.LinearFilter;
    this.fogTex.wrapS = THREE.ClampToEdgeWrapping; this.fogTex.wrapT = THREE.ClampToEdgeWrapping;
    this.fogTex.needsUpdate = true;
    this.fogU = { fogTex: { value: this.fogTex }, mapSize: { value: new THREE.Vector2(map.w, map.h) }, fogOn: { value: 1 } };

    // lights
    this.scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x6b7a4a, 0.75));
    this.sun = new THREE.DirectionalLight(0xfff1d6, 1.6);
    this.sun.castShadow = shadows;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 10; this.sun.shadow.camera.far = 220;
    this.sun.shadow.bias = -0.0008; this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun); this.scene.add(this.sun.target);

    // terrain
    this.W = map.w; this.H = map.h;
    this.heights = buildHeightmap(map);
    this.buildTerrain(map);
    this.viewPath = new Pathfinder(map);

    // instanced sets
    for (let age = 0; age < AGE_COUNT; age++) {
      this.buildingSets[age] = []; this.ghostSets[age] = [];
      for (let t = 0; t < BUILDING_TYPE_COUNT; t++) {
        // walls are cheap and get spammed along a base perimeter, so they need a much bigger cap
        const cap = t === BuildingType.Wall ? caps.walls : caps.buildings;
        this.buildingSets[age][t] = []; this.ghostSets[age][t] = [];
        for (let st = 0; st < BUILD_STAGES; st++) {
          const m = models.buildings[age][t][st];
          this.buildingSets[age][t][st] = new InstanceSet(m.geometry, makeInstancedMaterial(this.fogU, false, 0, 0), cap, true);
          this.ghostSets[age][t][st] = new InstanceSet(m.geometry, makeInstancedMaterial(this.fogU, false, 0, 0, true), cap, false);
          this.scene.add(this.buildingSets[age][t][st].mesh, this.ghostSets[age][t][st].mesh);
        }
      }
      this.wallHalfSet[age] = new InstanceSet(models.wallHalf[age].geometry, makeInstancedMaterial(this.fogU, false, 0, 0), caps.walls * 2, true);
      this.wallHalfGhost[age] = new InstanceSet(models.wallHalf[age].geometry, makeInstancedMaterial(this.fogU, false, 0, 0, true), caps.walls * 2, false);
      this.scene.add(this.wallHalfSet[age].mesh, this.wallHalfGhost[age].mesh);
      // one gate per straight run, so a fraction of the fence budget is plenty
      const gateCap = Math.max(8, caps.walls >> 2);
      this.gateSets[age] = []; this.gateGhost[age] = [];
      for (let d = 0; d < 2; d++) {
        this.gateSets[age][d] = new InstanceSet(models.gates[age][d].geometry, makeInstancedMaterial(this.fogU, false, 0, 0), gateCap, true);
        this.gateGhost[age][d] = new InstanceSet(models.gates[age][d].geometry, makeInstancedMaterial(this.fogU, false, 0, 0, true), gateCap, false);
        this.scene.add(this.gateSets[age][d].mesh, this.gateGhost[age][d].mesh);
      }
      this.gateLeafSets[age] = []; this.gateLeafGhost[age] = [];
      (models.gateLeaves[age] ?? []).forEach((leaf, d) => {
        this.gateLeafSets[age][d] = new InstanceSet(leaf.geometry, makeInstancedMaterial(this.fogU, false, 0, 0), gateCap, true);
        this.gateLeafGhost[age][d] = new InstanceSet(leaf.geometry, makeInstancedMaterial(this.fogU, false, 0, 0, true), gateCap, false);
        this.scene.add(this.gateLeafSets[age][d].mesh, this.gateLeafGhost[age][d].mesh);
      });
    }
    // every unit of the match could be of one type, so each set carries the whole budget
    const unitCaps = new Array(UNIT_TYPE_COUNT).fill(caps.units);
    for (let age = 0; age < AGE_COUNT; age++) {
      this.unitSets[age] = [];
      for (let t = 0; t < UNIT_TYPE_COUNT; t++) {
        const m = models.units[age][t];
        this.unitSets[age][t] = new InstanceSet(m.geometry, makeInstancedMaterial(this.fogU, true, m.hipY, m.shoulderY), unitCaps[t], true);
        this.scene.add(this.unitSets[age][t].mesh);
      }
    }
    for (const m of models.mines) {
      const set = new InstanceSet(m.geometry, makeInstancedMaterial(this.fogU, false, 0, 0), caps.mines, true);
      this.mineSets.push(set);
      this.scene.add(set.mesh);
    }
    // decor (static, rebuilt when a forest burns down)
    const decorCounts = [0, 0, 0, 0, 0];
    for (const d of map.decor) decorCounts[d.type]++;
    for (let t = 0; t < 5; t++) {
      const m = models.decor[t];
      const set = new InstanceSet(m.geometry, makeInstancedMaterial(this.fogU, false, 0, 0), Math.max(1, decorCounts[t]), t < 3);
      this.decorSets[t] = set;
      this.scene.add(set.mesh);
    }
    this.rebuildDecor(map);
    // selection rings; they keep the depth test, so units and walls in front of one still cover it, and
    // instead ride above the highest ground inside the circle (see `markingY`) so no rise can swallow them
    const ring = new THREE.RingGeometry(0.8, 1, 24).rotateX(-Math.PI / 2);
    addStaticAttrs(ring);
    const ringMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false });
    ringMat.onBeforeCompile = (s) => { s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float teamMask;').replace('#include <color_vertex>', 'vColor = instanceColor.xyz;'); };
    this.ringSet = new InstanceSet(ring, ringMat, caps.units, false);
    this.ringSet.mesh.renderOrder = 2;
    this.scene.add(this.ringSet.mesh);
    // building health ring: a partial arc (fraction = hp), semi-transparent when damaged, solid when selected
    const hpRing = new THREE.RingGeometry(0.84, 1, 64).rotateX(-Math.PI / 2);
    addStaticAttrs(hpRing);
    const hpRingMat = new THREE.ShaderMaterial({
      transparent: true, depthTest: false, depthWrite: false,
      vertexShader: `attribute vec4 aAnim; varying vec2 vLocal; varying vec4 vA; varying vec3 vC;
        void main(){ vLocal = position.xz; vA = aAnim; vC = instanceColor; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying vec2 vLocal; varying vec4 vA; varying vec3 vC;
        void main(){ float t = (atan(vLocal.x, -vLocal.y) + 3.14159265) / 6.2831853; if (t > vA.x) discard; gl_FragColor = vec4(vC, vA.y); }`,
    });
    this.hpRingSet = new InstanceSet(hpRing, hpRingMat, caps.buildings * BUILDING_TYPE_COUNT, false);
    this.hpRingSet.mesh.renderOrder = 2;
    this.scene.add(this.hpRingSet.mesh);
    // route dashes (semi-transparent, drawn over everything)
    const dash = new THREE.PlaneGeometry(0.42, 0.13).rotateX(-Math.PI / 2);
    addStaticAttrs(dash);
    const dashMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5, depthTest: false, depthWrite: false });
    dashMat.onBeforeCompile = (sh) => { sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float teamMask;').replace('#include <color_vertex>', 'vColor = instanceColor.xyz;'); };
    this.dashSet = new InstanceSet(dash, dashMat, 2048, false);
    this.dashSet.mesh.renderOrder = 3;
    this.scene.add(this.dashSet.mesh);
    // health bars (billboards)
    const bar = new THREE.PlaneGeometry(1, 1);
    addStaticAttrs(bar);
    const barMat = new THREE.ShaderMaterial({
      transparent: true, depthTest: false, depthWrite: false,
      vertexShader: `attribute vec4 aAnim; varying vec2 vUv; varying vec4 vA; varying vec3 vC;
        void main(){ vUv = uv; vA = aAnim; vC = instanceColor; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying vec2 vUv; varying vec4 vA; varying vec3 vC;
        void main(){ float hp = vA.x; vec3 c = (vUv.x <= hp) ? mix(vec3(0.85,0.2,0.15), vec3(0.3,0.85,0.35), smoothstep(0.25,0.6,hp)) : vec3(0.12,0.05,0.05);
          if (vA.y > 0.5 && vUv.x <= hp) { float stripe = step(0.5, fract(vUv.x * 12.0)); c = mix(c, vec3(1.0), stripe * 0.35 * (1.0 - step(0.6, hp))); }
          if (vUv.y < 0.12 || vUv.y > 0.88) c *= 0.3; gl_FragColor = vec4(c, 0.95); }`,
    });
    this.barSet = new InstanceSet(bar, barMat, caps.units, false);
    this.barSet.mesh.renderOrder = 3;
    this.scene.add(this.barSet.mesh);
    // status badges (empty mine, population full): camera-facing textured quads, matrices set by hand like the bars
    for (const kind of [ICON_WORKER, ICON_POP]) {
      const mat = new THREE.MeshBasicMaterial({ map: makeIconTexture(kind), transparent: true, depthTest: false, depthWrite: false });
      const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, 64);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.renderOrder = 4;
      mesh.count = 0;
      this.iconMeshes[kind] = mesh;
      this.scene.add(mesh);
    }
    // arrows & boulders & markers & fire
    const arrowGeo = new THREE.BoxGeometry(0.03, 0.03, 0.55); addStaticAttrs(arrowGeo, 0xd8c8a0);
    this.arrowSet = new InstanceSet(arrowGeo, makeInstancedMaterial(this.fogU, false, 0, 0), 1024, false);
    const boulderGeo = new THREE.DodecahedronGeometry(0.22, 0); addStaticAttrs(boulderGeo, 0x6d6a66);
    this.boulderSet = new InstanceSet(boulderGeo, makeInstancedMaterial(this.fogU, false, 0, 0), 120, true);
    const markerGeo = new THREE.RingGeometry(0.3, 0.42, 20).rotateX(-Math.PI / 2); addStaticAttrs(markerGeo);
    const markerMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false });
    markerMat.onBeforeCompile = (s) => { s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float teamMask;').replace('#include <color_vertex>', 'vColor = instanceColor.xyz;'); };
    this.markerSet = new InstanceSet(markerGeo, markerMat, 32, false);
    const fireGeo = new THREE.ConeGeometry(0.25, 0.7, 6).translate(0, 0.35, 0); addStaticAttrs(fireGeo, 0xff7a1a);
    const fireMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 });
    fireMat.onBeforeCompile = (s) => { s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float teamMask; attribute vec4 aAnim;').replace('#include <begin_vertex>', 'vec3 transformed = position; transformed.y *= 0.7 + 0.5 * sin(aAnim.y * 9.0 + position.x * 5.0); transformed.xz *= 1.0 - transformed.y * 0.4;'); };
    this.fireSet = new InstanceSet(fireGeo, fireMat, 512, false);
    this.scene.add(this.arrowSet.mesh, this.boulderSet.mesh, this.markerSet.mesh, this.fireSet.mesh);
    // attack-range circles (thin white line, always visible on top of terrain)
    const rangeGeo = new THREE.RingGeometry(0.985, 1.0, 96).rotateX(-Math.PI / 2); addStaticAttrs(rangeGeo);
    const rangeMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.32, depthTest: false, depthWrite: false });
    rangeMat.onBeforeCompile = (s) => { s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float teamMask;').replace('#include <color_vertex>', 'vColor = instanceColor.xyz;'); };
    this.rangeSet = new InstanceSet(rangeGeo, rangeMat, 64, false);
    this.rangeSet.mesh.renderOrder = 4;
    this.scene.add(this.rangeSet.mesh);
    this.placementRange = new THREE.Mesh(new THREE.RingGeometry(0.985, 1.0, 96).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthTest: false, depthWrite: false }));
    this.placementRange.renderOrder = 4;
    this.placementRange.visible = false;
    this.scene.add(this.placementRange);

    // effects
    this.particles = new Particles(2500);
    this.scene.add(this.particles.points);
    this.decals = new Decals(200, (x, z) => this.heightAt(x, z));
    this.scene.add(this.decals.mesh);

    // placement ghost
    const pg = new THREE.BoxGeometry(1, 0.3, 1).translate(0, 0.15, 0);
    this.placement = new THREE.Mesh(pg, new THREE.MeshBasicMaterial({ color: 0x4ad35a, transparent: true, opacity: 0.35, depthWrite: false }));
    this.placement.visible = false;
    this.scene.add(this.placement);
    // several ghosts at once for a dragged fence line; same flat quad, colour per cell
    this.placementLine = new THREE.InstancedMesh(this.placement.geometry, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }), 64);
    this.placementLine.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.placementLine.frustumCulled = false;
    this.placementLine.count = 0;
    this.placementLine.setColorAt(0, this.white);
    this.scene.add(this.placementLine);

    // every set above was made casting and taking shadows as its part calls for; the setting only says whether
    // that is drawn right now
    this.scene.traverse((o) => { if (o.receiveShadow) this.shadowReceivers.push(o); });
    this.setShadows(shadows);
    this.resize();
    this.warmUp();
  }

  /**
   * Compile every program and draw every set once, before the first frame of the match (docs/PERF.md §3.2, §3.4).
   * Linking is only part of the cost: the GPU process also builds a pipeline the first time a program is drawn
   * with a given vertex layout, and a set that first shows up mid-match - the first corpse, the first boulder,
   * the first remembered building - would pay for both on the spot. Each set gets one instance scaled to
   * nothing, so the draw happens and nothing reaches the screen.
   */
  private warmUp(): void {
    const sets = [
      ...this.buildingSets.flat(2), ...this.ghostSets.flat(2), ...this.wallHalfSet, ...this.wallHalfGhost,
      ...this.gateSets.flat(), ...this.gateGhost.flat(), ...this.gateLeafSets.flat(), ...this.gateLeafGhost.flat(),
      ...this.unitSets.flat(), ...this.mineSets,
      this.ringSet, this.hpRingSet, this.dashSet, this.barSet, this.arrowSet, this.boulderSet, this.markerSet, this.fireSet, this.rangeSet,
    ];
    this.gl.compile(this.scene, this.cam.camera);
    for (const s of sets) { s.begin(); s.add(0, -50, 0, 0, 0, NEUTRAL, 0, 1, 0, 0); s.end(); }
    // one particle too, far below the ground where the terrain hides it; the next update overwrites both
    const pg = this.particles.points.geometry;
    pg.attributes.position.setXYZ(0, 0, -50, 0);
    pg.attributes.position.needsUpdate = true;
    pg.setDrawRange(0, 1);
    this.particles.points.visible = true;
    this.gl.render(this.scene, this.cam.camera);
    for (const s of sets) { s.begin(); s.end(); }
    pg.setDrawRange(0, 0);
    this.particles.points.visible = false;
  }

  // ---------------------------------------------------------------- terrain

  /**
   * Height for a flat marking of radius `r` drawn around (x, z) - a selection ring, a building's health
   * ring. A marking laid at the height of its own centre sinks into ground that rises beside it (a deposit
   * against a hillside loses half its ring), so it is lifted onto the highest ground it spans instead.
   */
  markingY(x: number, z: number, r: number): number {
    let top = this.heightAt(x, z);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const h = this.heightAt(x + Math.cos(a) * r, z + Math.sin(a) * r);
      if (h > top) top = h;
    }
    return top + 0.03;
  }

  heightAt(x: number, z: number): number {
    const W = this.W + 1;
    let cx = Math.floor(x), cz = Math.floor(z);
    if (cx < 0) cx = 0; if (cz < 0) cz = 0; if (cx >= this.W) cx = this.W - 1; if (cz >= this.H) cz = this.H - 1;
    const fx = Math.min(1, Math.max(0, x - cx)), fz = Math.min(1, Math.max(0, z - cz));
    const h = this.heights;
    const h00 = h[cz * W + cx], h10 = h[cz * W + cx + 1], h01 = h[(cz + 1) * W + cx], h11 = h[(cz + 1) * W + cx + 1];
    return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
  }

  /** ground colour of one cell: base tile colour with a slow noise drift so grass is not one flat tone */
  private cellColor(map: MapData, x: number, y: number, out: THREE.Color): THREE.Color {
    const t = x < 0 || y < 0 || x >= map.w || y >= map.h ? Tile.Rock : map.tiles[y * map.w + x];
    const n = this.groundNoise(x, y);
    if (t === Tile.Grass) out.copy(GRASS_A).lerp(GRASS_B, n);
    else if (t === Tile.Forest) out.copy(FOREST_A).lerp(FOREST_B, n);
    else if (t === Tile.Rock) out.copy(ROCK_A).lerp(ROCK_B, n);
    else if (t === Tile.Dirt) out.copy(DIRT_A).lerp(DIRT_B, n);
    else out.copy(WATER_C);
    return out;
  }
  /** smooth 0..1 value noise over the cell grid (lattice every 5 cells, seeded from the map) */
  private groundNoise(x: number, y: number): number {
    const l = this.noiseLattice, gw = this.noiseW;
    const gx = x / 5, gy = y / 5;
    const ix = Math.floor(gx), iy = Math.floor(gy);
    const fx = gx - ix, fy = gy - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = l[iy * gw + ix], b = l[iy * gw + ix + 1], c = l[(iy + 1) * gw + ix], d = l[(iy + 1) * gw + ix + 1];
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
  }
  private noiseLattice!: Float32Array;
  private noiseW = 0;

  /**
   * Vertex colour = blend of the up-to-four cells meeting at that corner, so tile edges fade instead of
   * stepping. Water cells do not take part while any land cell does: the water plane covers the pond
   * anyway, and a bank the colour of the land beside it reads better than a blue-grey rim.
   */
  private vertexColor(map: MapData, vx: number, vy: number, out: THREE.Color, tmp: THREE.Color): THREE.Color {
    let r = 0, g = 0, b = 0, n = 0, water = 0;
    for (let dy = -1; dy <= 0; dy++) for (let dx = -1; dx <= 0; dx++) {
      const x = vx + dx, y = vy + dy;
      if (x < 0 || y < 0 || x >= map.w || y >= map.h) continue;
      if (map.tiles[y * map.w + x] === Tile.Water) { water++; continue; }
      this.cellColor(map, x, y, tmp);
      r += tmp.r; g += tmp.g; b += tmp.b; n++;
    }
    if (n === 0) return out.copy(water > 0 ? WATER_C : ROCK_A);
    return out.setRGB(r / n, g / n, b / n);
  }

  private buildTerrain(map: MapData) {
    const CH = 16;
    const W = map.w + 1;
    // noise lattice for the ground colour drift
    const rnd = mulberry(map.visualSeed ^ 0x77a1);
    this.noiseW = Math.ceil(map.w / 5) + 2;
    this.noiseLattice = new Float32Array(this.noiseW * (Math.ceil(map.h / 5) + 2));
    for (let i = 0; i < this.noiseLattice.length; i++) this.noiseLattice[i] = rnd();

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    injectFog(mat, this.fogU);
    // fine surface detail: two octaves of smooth value noise in the fragment shader, so the ground has
    // texture without any texture - and without falling back to per-cell colour steps
    const fogHook = mat.onBeforeCompile;
    mat.onBeforeCompile = (sh, r) => {
      fogHook(sh, r);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          float gHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float gNoise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(mix(gHash(i), gHash(i + vec2(1.0, 0.0)), u.x), mix(gHash(i + vec2(0.0, 1.0)), gHash(i + vec2(1.0, 1.0)), u.x), u.y); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          { float n = gNoise(vWPos.xz * 1.7) * 0.6 + gNoise(vWPos.xz * 5.3) * 0.4; diffuseColor.rgb *= 0.9 + 0.18 * n; }`);
    };
    mat.customProgramCacheKey = () => 'terrain-noise';

    const tmp = new THREE.Color(), col = new THREE.Color();
    for (let cy = 0; cy < map.h; cy += CH) for (let cx = 0; cx < map.w; cx += CH) {
      const w = Math.min(CH, map.w - cx), h = Math.min(CH, map.h - cy);
      const vw = w + 1, vh = h + 1;
      const pos = new Float32Array(vw * vh * 3), colors = new Float32Array(vw * vh * 3), norm = new Float32Array(vw * vh * 3);
      const idx: number[] = [];
      for (let y = 0; y < vh; y++) for (let x = 0; x < vw; x++) {
        const gx = cx + x, gy = cy + y, i = y * vw + x;
        pos[i * 3] = gx; pos[i * 3 + 1] = this.heights[gy * W + gx]; pos[i * 3 + 2] = gy;
        this.vertexColor(map, gx, gy, col, tmp);
        colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
        // normal from the global heightmap so chunk seams shade identically on both sides
        const hl = this.heights[gy * W + Math.max(0, gx - 1)], hr = this.heights[gy * W + Math.min(map.w, gx + 1)];
        const hd = this.heights[Math.max(0, gy - 1) * W + gx], hu = this.heights[Math.min(map.h, gy + 1) * W + gx];
        const nx = (hl - hr) * 0.5, nz = (hd - hu) * 0.5, len = Math.hypot(nx, 1, nz);
        norm[i * 3] = nx / len; norm[i * 3 + 1] = 1 / len; norm[i * 3 + 2] = nz / len;
      }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const a = y * vw + x, b = a + 1, c = a + vw, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
      g.setIndex(idx);
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, mat);
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this.terrainChunks.push({ mesh, cx0: cx, cy0: cy, w, h });
    }
    // water plane
    const water = new THREE.Mesh(new THREE.PlaneGeometry(map.w, map.h).rotateX(-Math.PI / 2).translate(map.w / 2, -0.28, map.h / 2),
      (() => { const m = new THREE.MeshLambertMaterial({ color: 0x3f86c4, transparent: true, opacity: 0.8 }); injectFog(m, this.fogU); return m; })());
    this.scene.add(water);
    // dark ground outside the map
    const outer = new THREE.Mesh(new THREE.PlaneGeometry(map.w * 4, map.h * 4).rotateX(-Math.PI / 2).translate(map.w / 2, -1.2, map.h / 2), new THREE.MeshBasicMaterial({ color: 0x0b0f16 }));
    this.scene.add(outer);
  }

  /** recolour every chunk from the current tiles (a burnt forest turns to scorched dirt) */
  private refreshTerrainColors(map: MapData): void {
    const tmp = new THREE.Color(), col = new THREE.Color();
    for (const ch of this.terrainChunks) {
      const attr = ch.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
      const vw = ch.w + 1;
      for (let y = 0; y <= ch.h; y++) for (let x = 0; x <= ch.w; x++) {
        this.vertexColor(map, ch.cx0 + x, ch.cy0 + y, col, tmp);
        attr.setXYZ(y * vw + x, col.r, col.g, col.b);
      }
      attr.needsUpdate = true;
    }
  }

  /** trees only stand on forest cells, rocks only on rock cells - rebuilt when tiles change */
  private rebuildDecor(map: MapData): void {
    for (let t = 0; t < 5; t++) {
      const set = this.decorSets[t];
      set.begin();
      for (const d of map.decor) {
        if (d.type !== t) continue;
        const tile = map.tiles[Math.floor(d.y) * map.w + Math.floor(d.x)];
        if (t < 3 ? tile !== Tile.Forest : tile !== Tile.Rock) continue;
        set.add(d.x, this.heightAt(d.x, d.y) - 0.05, d.y, d.rot, d.scale, NEUTRAL, 0, 1, 0, 0);
      }
      set.end();
    }
  }

  // ---------------------------------------------------------------- routes

  /** show the routes of these units for a moment (called when the player gives a move-type order) */
  flashPath(ids: number[]): void {
    const until = performance.now() / 1000 + 1.5;
    for (const id of ids) this.pathFlash.set(id, until);
  }

  /** where a unit is heading, in fixed map coords, or null when it is not going anywhere */
  private unitDestination(sim: Simulation, id: number): [number, number] | null {
    const w = sim.world;
    switch (w.order[id] as Order) {
      case Order.Move: case Order.AttackMove: case Order.Patrol: return [w.orderX[id], w.orderY[id]];
      case Order.Attack: case Order.Build: case Order.Repair: case Order.Garrison: {
        const t = w.orderTarget[id];
        return t >= 0 && w.alive[t] ? [w.x[t], w.y[t]] : null;
      }
      case Order.Gather: {
        const t = w.carry[id] >= GOLD_PER_TRIP ? w.target[id] : w.orderTarget[id];
        return t >= 0 && w.alive[t] ? [w.x[t], w.y[t]] : null;
      }
      default: return null;
    }
  }

  /**
   * Cell-by-cell route from the unit to its destination, traced on the view's own flow field copy. The points go
   * into `routePts` as x,z pairs; returns how many there are.
   */
  private tracePath(sim: Simulation, id: number, dest: [number, number]): number {
    const w = sim.world, path = this.viewPath, W = path.w;
    const heavy = isHeavy(w.type[id] as UnitType);
    const pts = this.routePts;
    let n = 0;
    pts[n++] = toFloat(w.x[id]); pts[n++] = toFloat(w.y[id]);
    // destination is a map cell, the route is walked on the fine grid (half cells) like the units do
    const dcx = dest[0] >> 16, dcy = dest[1] >> 16;
    let fx = w.x[id] >> FINE_SHIFT, fy = w.y[id] >> FINE_SHIFT;
    // force: this is the view's own pathfinder copy, so it never eats the simulation's per-tick budget.
    // Settling our own cell settles everything nearer the destination, which is all the trace walks over.
    const field = path.fieldFor(dcx, dcy, fx, fy, heavy, sim.team(w.owner[id]));
    if (field && path.distAt(field, fy * W + fx) !== UNREACHABLE) {
      for (let step = 0; step < 600; step++) {
        if ((fx >> SUB_SHIFT) === dcx && (fy >> SUB_SHIFT) === dcy) break;
        const k = path.flowStep(field, fx, fy);
        if (k < 0) break;
        fx += path.stepDX(k); fy += path.stepDY(k);
        pts[n++] = (fx + 0.5) / SUB; pts[n++] = (fy + 0.5) / SUB;
      }
    }
    pts[n++] = toFloat(dest[0]); pts[n++] = toFloat(dest[1]);
    return n >> 1;
  }

  private drawPaths(sim: Simulation, selected: Set<number>, time: number): void {
    const w = sim.world;
    if (this.viewPathVersion !== sim.path.version) {
      this.viewPath.copyFrom(sim.path);
      this.viewPathVersion = sim.path.version;
    }
    // Routes are decoration: they get a frame's worth of pathing work and no more. A field that is not ready
    // yet simply leaves its route undrawn for a frame or two rather than stalling the frame to finish it.
    this.viewPath.beginTick();
    const want: number[] = [];
    for (const id of selected) if (w.alive[id] && w.kind[id] === Kind.Unit && w.owner[id] === this.perspective) want.push(id);
    for (const [id, until] of this.pathFlash) {
      if (until < time || !w.alive[id]) { this.pathFlash.delete(id); continue; }
      if (!selected.has(id)) want.push(id);
    }
    let n = 0;
    for (const id of want) {
      if (n >= PATH_LINE_CAP) break;
      const dest = this.unitDestination(sim, id);
      if (!dest) continue;
      const count = this.tracePath(sim, id, dest);
      if (count < 2) continue;
      this.layDashes(this.routePts, count);
      n++;
    }
  }

  /** one flat dash every DASH_STEP along the polyline (`count` x,z pairs), each turned along its segment */
  private layDashes(pts: Float32Array, count: number): void {
    let carry = DASH_STEP * 0.5;
    for (let i = 0; i + 1 < count; i++) {
      const ax = pts[i * 2], az = pts[i * 2 + 1];
      const dx = pts[i * 2 + 2] - ax, dz = pts[i * 2 + 3] - az;
      const len = Math.hypot(dx, dz);
      if (len < 1e-4) continue;
      const rot = Math.atan2(-dz, dx);
      let d = carry;
      while (d <= len) {
        const t = d / len;
        const x = ax + dx * t, z = az + dz * t;
        this.dashSet.add(x, this.heightAt(x, z) + 0.06, z, rot, 1, this.routeColor, 0, 0, 0, 0);
        d += DASH_STEP;
      }
      carry = d - len;
    }
  }

  // ---------------------------------------------------------------- frame

  resize(): void {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.gl.setSize(w, h, false);
    this.cam.setAspect(w / h);
    this.particles.setViewportHeight(h);
  }

  screenToGround(clientX: number, clientY: number): GroundPoint | null {
    const r = this.canvas.getBoundingClientRect();
    const nx = ((clientX - r.left) / r.width) * 2 - 1, ny = -((clientY - r.top) / r.height) * 2 + 1;
    const p = this.cam.groundPoint(nx, ny);
    if (!p) return null;
    // one refinement step for terrain height
    const hgt = this.heightAt(p.x, p.z);
    const p2 = this.cam.groundPoint(nx, ny, this.tmpV);
    if (!p2) return { x: p.x, y: p.z };
    const dir = this.tmpDir.copy(this.cam.camera.position).sub(p2).normalize();
    const k = hgt / Math.max(0.05, dir.y);
    return { x: p2.x + dir.x * k, y: p2.z + dir.z * k };
  }

  /** world (cells, height) -> css pixels relative to the canvas */
  worldToScreen(x: number, y: number, h: number, out: { sx: number; sy: number; visible: boolean }): void {
    const v = this.cam.project(x, h, y, this.tmpV);
    out.visible = v.z < 1;
    out.sx = (v.x + 1) / 2 * this.canvas.clientWidth;
    out.sy = (1 - v.y) / 2 * this.canvas.clientHeight;
  }

  /** Ghosts for a fence line being dragged: one flat quad per cell, green where it can go, red where it can't. */
  setPlacementLine(type: BuildingType, cells: { cx: number; cy: number; ok: boolean }[]): void {
    this.placement.visible = false; this.placementRange.visible = false;
    const size = BUILDINGS[type].size;
    const m = new THREE.Matrix4(), v = new THREE.Vector3(), sc = new THREE.Vector3(size, 1, size);
    const n = Math.min(cells.length, 64);
    for (let i = 0; i < n; i++) {
      const c = cells[i];
      v.set(c.cx + size / 2, this.heightAt(c.cx + size / 2, c.cy + size / 2) + 0.02, c.cy + size / 2);
      m.compose(v, new THREE.Quaternion(), sc);
      this.placementLine.setMatrixAt(i, m);
      this.placementLine.setColorAt(i, c.ok ? this.placeOkColor : this.placeBadColor);
    }
    this.placementLine.count = n;
    this.placementLine.visible = n > 0;
    this.placementLine.instanceMatrix.needsUpdate = true;
    if (this.placementLine.instanceColor) this.placementLine.instanceColor.needsUpdate = true;
  }

  setPlacement(type: BuildingType | -1, cx: number, cy: number, ok: boolean, rangeBonus = 0): void {
    this.placementLine.count = 0; this.placementLine.visible = false;
    if (type < 0) { this.placement.visible = false; this.placementRange.visible = false; return; }
    const def = BUILDINGS[type as BuildingType];
    const size = def.size;
    this.placement.visible = true;
    this.placement.scale.set(size, 1, size);
    const y = this.heightAt(cx + size / 2, cy + size / 2);
    this.placement.position.set(cx + size / 2, y, cy + size / 2);
    (this.placement.material as THREE.MeshBasicMaterial).color.setHex(ok ? 0x4ad35a : 0xe04a4a);
    // defensive buildings: preview their attack range
    if (def.range > 0) {
      const r = buildingRangeCells(type as BuildingType, rangeBonus);
      this.placementRange.visible = true;
      this.placementRange.scale.set(r, 1, r);
      this.placementRange.position.set(cx + size / 2, y + 0.06, cy + size / 2);
    } else this.placementRange.visible = false;
  }

  addMarker(x: number, y: number, color: number): void {
    this.markers.push({ x, z: y, t: 0, color: new THREE.Color(color) });
  }

  private cellKey(fx: number, fy: number): number {
    return Math.floor(toFloat(fy)) * this.mapW + Math.floor(toFloat(fx));
  }

  /** Which of the four neighbouring cells also hold a fence: bits N=1, E=2, S=4, W=8. */
  private wallLinks(fx: number, fy: number, wallCells: Set<number>): number {
    const key = this.cellKey(fx, fy);
    return (wallCells.has(key - this.mapW) ? WALL_N : 0) | (wallCells.has(key + 1) ? WALL_E : 0)
      | (wallCells.has(key + this.mapW) ? WALL_S : 0) | (wallCells.has(key - 1) ? WALL_W : 0);
  }

  /**
   * Draw one fence cell. A straight run, a loose end or a lone post is the full one-cell panel turned
   * along its line. A corner or junction is assembled from half panels, one toward each neighbour,
   * so nothing sticks out past the turn and the perpendicular arm meets it without a gap.
   */
  /**
   * A fence cell that is part of a gate. The gatehouse spans the two middle cells of the run, so it is drawn once,
   * from the first of them, centred on the seam between the two; the second draws nothing, and the cells at either
   * end keep their ordinary panel with the gatehouse's towers standing on the joins. `open` picks the model: the
   * team that may walk through sees the door standing open, everyone else sees it barred.
   * Returns false when the caller should draw a plain fence panel instead.
   */
  private addGate(sets: InstanceSet[][], leaves: InstanceSet[][], half: InstanceSet, age: number, slot: number, open: boolean, swing: number, x: number, z: number, col: THREE.Color, progress: number): boolean {
    if (slot >= GATE_TUNNEL) {
      // A row of a thicker wall the corridor runs through. Its whole panel would wall the passage back up and
      // leaving it out would look like a hole, so it keeps the half facing away from the doorway: the wall runs
      // on unbroken and the gap it leaves is exactly the width of the door in front of it.
      const d = (slot - GATE_TUNNEL) >> 1, side = (slot - GATE_TUNNEL) & 1;
      const rot = d === 0 ? (side ? 0 : Math.PI) : (side ? -Math.PI / 2 : Math.PI / 2);
      half.add(x, this.heightAt(x, z), z, rot, 1, col, 0, progress, 0, 0);
      return true;
    }
    const dir = ((slot - 1) >> 2) & 1, pos = (slot - 1) & 3;
    if (pos === 0 || pos === GATE_LENGTH - 1) {
      // the gatehouse reaches half way across this cell, so it keeps only the half of its panel that faces away
      const away = pos === 0;
      const rot = dir === 0 ? (away ? Math.PI : 0) : (away ? Math.PI / 2 : -Math.PI / 2);
      half.add(x, this.heightAt(x, z), z, rot, 1, col, 0, progress, 0, 0);
      return true;
    }
    if (pos === 2) return true; // the gatehouse drawn from the cell before it already covers this one
    const gx = dir === 0 ? x + 0.5 : x, gz = dir === 0 ? z : z + 0.5;
    const rot = dir === 0 ? 0 : Math.PI / 2;
    const gy = this.heightAt(gx, gz);
    const leafGeo = this.models.gateLeaves[age];
    if (!leafGeo?.length) { sets[age][open ? 0 : 1].add(gx, gy, gz, rot, 1, col, 0, progress, 0, 0); return true; }
    // doorway empty, and the two leaves hung in it at whatever angle they have swung to
    sets[age][0].add(gx, gy, gz, rot, 1, col, 0, progress, 0, 0);
    const a = swing * DOOR_SWING;
    for (let i = 0; i < leafGeo.length; i++) {
      const lx = this.models.gateHinge[age][i];
      const px = gx + Math.cos(rot) * lx, pz = gz - Math.sin(rot) * lx;
      leaves[age][i].add(px, gy, pz, rot + (i === 0 ? -a : a), 1, col, 0, progress, 0, 0);
    }
    return true;
  }

  /**
   * How far a gate stands open, 0..1, eased towards its target so the leaves swing instead of snapping. A gate
   * whose door is open to us throws them wide as soon as one of its own units comes within reach of the doorway
   * and shuts again behind the last of them; a gate that is a wall to us stays barred.
   */
  private gateSwing(sim: Simulation, id: number, team: number, open: boolean, gx: number, gz: number, dt: number): number {
    const w = sim.world;
    let want = 0;
    if (open) {
      sim.grid.query(fp(gx), fp(gz), fp(GATE_SWING_R), (o) => {
        if (!w.alive[o] || w.kind[o] !== Kind.Unit || sim.team(w.owner[o]) !== team) return;
        want = 1;
        return true;
      });
    }
    const cur = this.gateSwings.get(id) ?? 0;
    const step = dt / GATE_SWING_TIME;
    const next = want > cur ? Math.min(want, cur + step) : Math.max(want, cur - step);
    this.gateSwings.set(id, next);
    return next;
  }

  private addWall(full: InstanceSet, half: InstanceSet, links: number, x: number, y: number, z: number, col: THREE.Color, progress: number): void {
    const ew = links & (WALL_E | WALL_W), ns = links & (WALL_N | WALL_S);
    if (ew && ns) {
      // half panel model runs from the centre toward +x; rotate it toward each linked neighbour
      if (links & WALL_E) half.add(x, y, z, 0, 1, col, 0, progress, 0, 0);
      if (links & WALL_N) half.add(x, y, z, Math.PI / 2, 1, col, 0, progress, 0, 0);
      if (links & WALL_W) half.add(x, y, z, Math.PI, 1, col, 0, progress, 0, 0);
      if (links & WALL_S) half.add(x, y, z, -Math.PI / 2, 1, col, 0, progress, 0, 0);
    } else full.add(x, y, z, ns ? Math.PI / 2 : 0, 1, col, 0, progress, 0, 0);
  }

  /** Update all instanced sets from the simulation state. */
  sync(sim: Simulation, alpha: number, selected: Set<number>, hover: number, bars: 'damaged' | 'always' | 'selected', dt: number): void {
    const w = sim.world;
    const persp = this.perspective;
    const reveal = this.revealAll || persp < 0;
    this.fogU.fogOn.value = reveal ? 0 : 1;
    if (!reveal && sim.fog.revision !== this.fogRevision) {
      this.fogRevision = sim.fog.revision;
      const vis = sim.fog.vis[persp];
      for (let i = 0; i < vis.length; i++) this.fogData[i] = vis[i] * 127;
      this.fogTex.needsUpdate = true;
    }
    for (const byAge of this.unitSets) for (const s of byAge) s.begin();
    for (const byAge of this.buildingSets) for (const set of byAge) for (const s of set) s.begin();
    for (const byAge of this.ghostSets) for (const set of byAge) for (const s of set) s.begin();
    for (const s of this.wallHalfSet) s.begin();
    for (const s of this.wallHalfGhost) s.begin();
    for (const byAge of this.gateSets) for (const s of byAge) s.begin();
    for (const byAge of this.gateGhost) for (const s of byAge) s.begin();
    for (const byAge of this.gateLeafSets) for (const s of byAge) s.begin();
    for (const byAge of this.gateLeafGhost) for (const s of byAge) s.begin();
    for (const s of this.mineSets) s.begin();
    this.iconCounts[0] = 0; this.iconCounts[1] = 0;
    this.ringSet.begin(); this.hpRingSet.begin(); this.dashSet.begin(); this.barSet.begin(); this.boulderSet.begin(); this.fireSet.begin(); this.rangeSet.begin();
    // forest burnt down since last frame: recolour the ground and drop the trees
    if (sim.terrainRevision !== this.terrainRevision) { this.terrainRevision = sim.terrainRevision; this.refreshTerrainColors(sim.map); this.rebuildDecor(sim.map); }
    const time = performance.now() / 1000;
    const camYaw = this.cam.yaw;
    // camera basis for billboards
    const camQ = this.cam.camera.quaternion;
    const right = this.camRight.set(1, 0, 0).applyQuaternion(camQ), up = this.camUp.set(0, 1, 0).applyQuaternion(camQ);
    this.camFwd.copy(right).cross(up);
    const barM = this.barM;

    // wall cells, so each fence segment can be turned to line up with its neighbours (view only)
    const wallCells = this.wallCells;
    wallCells.clear();
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id] || w.kind[id] !== Kind.Building) continue;
      if (w.type[id] === BuildingType.Wall) wallCells.add(this.cellKey(w.x[id], w.y[id]));
      else if (w.type[id] === BuildingType.Tower) {
        // fences run up to a tower as if it were part of the line
        const [tx, ty] = sim.footprintTopLeft(id);
        for (let yy = ty; yy < ty + w.size[id]; yy++) for (let xx = tx; xx < tx + w.size[id]; xx++) wallCells.add(yy * this.mapW + xx);
      }
    }

    const seenBuildings = this.seenBuildings;
    seenBuildings.clear();
    for (let id = 0; id < w.maxId; id++) {
      if (!w.alive[id]) continue;
      const k = w.kind[id];
      const owner = w.owner[id];
      const visible = reveal || sim.visibleTo(persp, id);
      const x = toFloat(w.px[id] + (w.x[id] - w.px[id]) * alpha);
      const z = toFloat(w.py[id] + (w.y[id] - w.py[id]) * alpha);
      if (k === Kind.Unit) {
        if (!visible) continue;
        const type = w.type[id];
        const def = UNITS[type as UnitType];
        const col = owner >= 0 ? playerColor(sim.players[owner].color) : NEUTRAL;
        // facing (smoothed)
        const target = Math.atan2(w.fx[id], w.fy[id]);
        let f = this.facing[id];
        let d = target - f; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
        f += d * Math.min(1, dt * 14);
        this.facing[id] = f;
        // animation state/phase
        let st = w.state[id];
        if (this.swing[id] > 0) {
          // launch event: play the arm swing once regardless of what the unit is doing now
          this.swing[id] -= dt;
          st = UnitState.Attacking;
          this.phase[id] = (1 - Math.max(0, this.swing[id]) / SWING_DUR) * 0.25;
        } else if (st === UnitState.Moving) this.phase[id] += dt * def.speed * 0.9;
        else if (st === UnitState.Attacking) this.phase[id] = 1 - w.cooldown[id] / Math.max(1, def.cooldown);
        else if (st === UnitState.Gathering || st === UnitState.Building) this.phase[id] += dt * 1.2;
        else this.phase[id] += dt * 0.6;
        const y = this.heightAt(x, z);
        const uAge = owner >= 0 ? sim.players[owner].age : Age.First;
        // a worker on his way back from the mine shows the gold instead of the pickaxe (part 7/8 in the shader)
        const load = type === UnitType.Worker && w.carry[id] > 0 ? 1 : 0;
        this.unitSets[uAge][type].add(x, y, z, f, UNIT_SCALE, col, st, this.phase[id], load, 0);
        const sel = selected.has(id);
        if (sel || id === hover) {
          const rc = owner === persp || (owner >= 0 && persp >= 0 && sim.sameTeam(owner, persp)) ? (owner === persp ? this.selColor : this.allySel) : this.enemySel;
          this.ringSet.add(x, this.markingY(x, z, def.radius * 1.6), z, 0, def.radius * 1.6, sel ? rc : this.white, 0, 0, 0, 0);
        }
        // attack range of selected ranged units (reach to a target's edge = range + own radius)
        if (sel && def.range > 1) {
          this.rangeSet.add(x, y + 0.06, z, 0, toFloat(sim.unitRange(id)) + def.radius, this.white, 0, 0, 0, 0);
          if (def.minRange > 0) this.rangeSet.add(x, y + 0.06, z, 0, def.minRange, this.rangeDim, 0, 0, 0, 0);
        }
        const hpF = w.hp[id] / w.maxHp[id];
        if (bars === 'always' || (bars === 'damaged' && (hpF < 0.999 || sel)) || (bars === 'selected' && sel)) {
          this.addBar(barM, right, up, x, y + this.models.units[uAge][type].height * UNIT_SCALE + 0.25, z, 0.9, 0.11, hpF, col);
        }
      } else if (k === Kind.Building) {
        const type = w.type[id];
        const def = BUILDINGS[type as BuildingType];
        // a complete building being dismantled walks its progress (and its model stages) back down
        const total = def.buildTime * 10;
        const progress = w.state[id] === BuildingState.Complete && w.progress[id] >= total ? 1 : w.progress[id] / total;
        const stage = buildStage(progress);
        const links = type === BuildingType.Wall ? this.wallLinks(w.x[id], w.y[id], wallCells) : 0;
        // four fence cells in a line carry a gatehouse; its door is open to the team that built it
        const gate = type === BuildingType.Wall ? sim.path.gateAt(w.x[id] >> 16, w.y[id] >> 16) : 0;
        const gateOpen = gate > 0 && (reveal || sim.sameTeam(owner, persp));
        // the owner's age picks the model set: a player entering the stone age rebuilds every building at once
        const age = owner >= 0 ? sim.players[owner].age : Age.First;
        if (visible) {
          seenBuildings.add(id);
          // rewritten in place: one record per building for the whole match, not a new one every frame
          let kb = this.known.get(id);
          if (!kb) { kb = { id, gen: 0, type: 0, owner: 0, x: 0, z: 0, progress: 0, links: 0, age: 0, gate: 0 }; this.known.set(id, kb); }
          kb.gen = w.gen[id]; kb.type = type; kb.owner = owner; kb.x = x; kb.z = z; kb.progress = progress; kb.links = links; kb.age = age;
          kb.gate = gateOpen ? gate : -gate;
          const col = owner >= 0 ? playerColor(sim.players[owner].color) : NEUTRAL;
          const y = this.heightAt(x, z);
          if (type === BuildingType.Wall) {
            // the cell that carries the gatehouse also drives the swing of its leaves
            const swing = gate > 0 && gate < GATE_TUNNEL && ((gate - 1) & 3) === 1
              ? this.gateSwing(sim, id, sim.team(owner), gateOpen, ((gate - 1) >> 2) & 1 ? x : x + 0.5, ((gate - 1) >> 2) & 1 ? z + 0.5 : z, dt)
              : 0;
            if (!(gate > 0 && this.addGate(this.gateSets, this.gateLeafSets, this.wallHalfSet[age], age, gate, gateOpen, swing, x, z, col, progress))) {
              this.addWall(this.buildingSets[age][type][stage], this.wallHalfSet[age], links, x, y, z, col, progress);
            }
          }
          else this.buildingSets[age][type][stage].add(x, y, z, 0, 1, col, 0, progress, 0, 0);
          const sel = selected.has(id), hov = id === hover;
          const hpF = w.hp[id] / w.maxHp[id];
          // one ring does it all: construction progress while building (gold), health afterwards, coloured
          // green above half, orange down to 35%, red below. A damaged or unfinished building always shows
          // the faint arc, a selected one shows it in full colour (a whole ring when unhurt), hover is white
          const frac = progress < 1 ? progress : hpF;
          const ringCol = progress < 1 ? this.buildRing : hpF > 0.5 ? this.hpGreen : hpF > 0.35 ? this.hpOrange : this.hpRed;
          if (sel) this.hpRingSet.add(x, this.markingY(x, z, def.size * 0.72), z, 0, def.size * 0.72, ringCol, frac, 1, 0, 0);
          else if (hov) this.hpRingSet.add(x, this.markingY(x, z, def.size * 0.72), z, 0, def.size * 0.72, this.white, frac, 0.6, 0, 0);
          else if (progress < 1 || hpF < 0.999) this.hpRingSet.add(x, this.markingY(x, z, def.size * 0.72), z, 0, def.size * 0.72, ringCol, frac, 0.45, 0, 0);
          // attack range of selected defensive buildings (castle, tower), incl. the range upgrade
          if (sel && def.range > 0 && progress >= 1) {
            this.rangeSet.add(x, y + 0.06, z, 0, buildingRangeCells(type as BuildingType, owner >= 0 ? sim.players[owner].upgrades[UpgradeId.Range] : 0), this.white, 0, 0, 0, 0);
          }
          const mh = this.models.buildings[age][type][stage].height;
          if (progress < 1 && Math.random() < dt * 3) this.particles.emit(x + (Math.random() - 0.5) * def.size, y + 0.3 + Math.random() * mh * progress, z + (Math.random() - 0.5) * def.size, 1, 0xc9b28a, { speed: 0.4, up: 0.6, life: 0.5, size: 0.12, gravity: 1 });
          if (type === BuildingType.Mine && progress >= 1) {
            const inside = w.carry[id];
            if (inside > 0) {
              // working: coins drift up out of the shaft, more of them with more workers
              if (Math.random() < dt * (2 + inside * 2)) this.particles.emit(x + (Math.random() - 0.5) * 0.8, y + 0.9, z + (Math.random() - 0.5) * 0.8, 1, 0xffd54a, { speed: 0.15, up: 1.4, life: 1.1, size: 0.22, gravity: 0.2 });
            } else if (owner === persp || (owner >= 0 && persp >= 0 && sim.sameTeam(owner, persp))) {
              // nobody inside: a blinking red figure asks for workers (own team only - it's a to-do, not intel)
              if (Math.sin(time * 5) > -0.3) this.addIcon(ICON_WORKER, barM, right, up, x, y + mh + 0.9, z, 0.8);
            }
          }
          // a trained unit is waiting inside because the population cap is full (own team only)
          if (progress >= 1 && w.lifetime[id] === 1 && (owner === persp || (owner >= 0 && persp >= 0 && sim.sameTeam(owner, persp))) && Math.sin(time * 5) > -0.3) {
            this.addIcon(ICON_POP, barM, right, up, x, y + mh + 0.9, z, 0.8);
          }
        }
      } else if (k === Kind.Mine) {
        if (!(reveal || sim.fog.isExplored(persp, w.x[id], w.y[id]))) continue;
        const y = this.heightAt(x, z);
        const frac = w.hp[id] / Math.max(1, w.maxHp[id]);
        // three shapes of deposit; the pick depends on the cell so it is stable and varies across the map
        const variant = (Math.floor(x) * 7 + Math.floor(z) * 13) % this.mineSets.length;
        this.mineSets[variant].add(x, y, z, 0, 0.75 + 0.25 * frac, NEUTRAL, 0, 1, 0, 0);
        if (selected.has(id) || id === hover) this.ringSet.add(x, this.markingY(x, z, 2.1), z, 0, 2.1, this.white, 0, 0, 0, 0);
      } else if (k === Kind.Projectile) {
        if (!visible) continue;
        if (w.carry[id] > 0) continue; // still in the bucket
        const total = Math.max(1, w.timer[id]);
        const t = Math.min(1, (total - w.lifetime[id] + alpha) / total);
        const dist = Math.hypot(toFloat(w.orderX[id] - w.patrolX[id]), toFloat(w.orderY[id] - w.patrolY[id]));
        const arc = 4 * Math.min(6, dist * 0.35) * t * (1 - t);
        const py = this.heightAt(x, z) + 0.6 + arc;
        this.boulderSet.add(x, py, z, time * 3, 1, NEUTRAL, 0, 1, 0, 0);
        if (w.buff[id] && Math.random() < dt * 45) this.particles.emit(x, py, z, 1, Math.random() < 0.5 ? 0xff8a2a : 0xffd54a, { speed: 0.4, up: 0.8, life: 0.45, size: 0.26, gravity: -0.5 });
      } else if (k === Kind.Zone) {
        if (!visible) continue;
        const r = toFloat(w.orderV[id]);
        const y = this.heightAt(x, z);
        const n = 10;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + id, rr = r * (0.25 + 0.65 * ((i * 7) % 5) / 5);
          this.fireSet.add(x + Math.cos(a) * rr, y, z + Math.sin(a) * rr, a, 0.6 + 0.3 * Math.sin(time * 5 + i), this.white, 0, time + i * 0.7, 0, 0);
        }
        if (Math.random() < dt * 25) this.particles.emit(x + (Math.random() - 0.5) * r * 1.6, y + 0.3, z + (Math.random() - 0.5) * r * 1.6, 1, 0xff8a2a, { speed: 0.3, up: 1.6, life: 0.7, size: 0.28, gravity: -1.5 });
      }
    }
    // ghosts of buildings we remember but can't see now
    for (const [id, kb] of this.known) {
      if (seenBuildings.has(id)) continue;
      const cellVisible = reveal || sim.fog.vis[persp][Math.floor(kb.z) * this.mapW + Math.floor(kb.x)] === FOG_VISIBLE;
      const gone = !w.alive[id] || w.gen[id] !== kb.gen;
      if (cellVisible && gone) { this.known.delete(id); continue; }
      if (cellVisible) continue; // alive & visible handled above
      const col = kb.owner >= 0 ? playerColor(sim.players[kb.owner].color) : GHOST;
      const gy = this.heightAt(kb.x, kb.z);
      if (kb.type === BuildingType.Wall) {
        // a remembered gate keeps the face it had when we last saw it (the sign of `gate` says which)
        // a remembered gate is drawn shut: what we saw is a gate, not who was walking through it
        if (!(kb.gate !== 0 && this.addGate(this.gateGhost, this.gateLeafGhost, this.wallHalfGhost[kb.age], kb.age, Math.abs(kb.gate), kb.gate > 0, 0, kb.x, kb.z, col, kb.progress))) {
          this.addWall(this.ghostSets[kb.age][kb.type][buildStage(kb.progress)], this.wallHalfGhost[kb.age], kb.links, kb.x, gy, kb.z, col, kb.progress);
        }
      } else this.ghostSets[kb.age][kb.type][buildStage(kb.progress)].add(kb.x, gy, kb.z, 0, 1, col, 0, kb.progress, 0, 0);
    }
    for (const id of this.gateSwings.keys()) if (!seenBuildings.has(id)) this.gateSwings.delete(id);
    // forest on fire: flames on every burning cell (visible ones), a little smoke
    const fogVis = persp >= 0 ? sim.fog.vis[persp] : null;
    for (const cell of sim.burning) {
      const bx = cell % this.mapW, bz = (cell - bx) / this.mapW;
      if (fogVis && fogVis[cell] !== FOG_VISIBLE) continue;
      const fx = bx + 0.5, fz = bz + 0.5, fy = this.heightAt(fx, fz);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + cell;
        this.fireSet.add(fx + Math.cos(a) * 0.28, fy + 0.15, fz + Math.sin(a) * 0.28, a, 0.7 + 0.3 * Math.sin(time * 6 + i + cell), this.white, 0, time + i * 0.7 + cell, 0, 0);
      }
      if (Math.random() < dt * 4) this.particles.emit(fx + (Math.random() - 0.5) * 0.6, fy + 0.9, fz + (Math.random() - 0.5) * 0.6, 1, 0x4a4540, { speed: 0.2, up: 1.2, life: 1.4, size: 0.4, gravity: -0.6 });
    }
    this.drawPaths(sim, selected, time);
    // corpses (death animation)
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      c.t += dt;
      if (c.t > 2.6) { this.corpses[i] = this.corpses[this.corpses.length - 1]; this.corpses.pop(); continue; }
      const col = c.owner >= 0 ? playerColor(sim.players[c.owner].color) : NEUTRAL;
      this.unitSets[c.age][c.type].add(c.x, this.heightAt(c.x, c.z), c.z, c.rot, UNIT_SCALE, col, 5, 0, 0, c.t);
    }
    for (const byAge of this.unitSets) for (const s of byAge) s.end();
    for (const byAge of this.buildingSets) for (const set of byAge) for (const s of set) s.end();
    for (const byAge of this.ghostSets) for (const set of byAge) for (const s of set) s.end();
    for (const s of this.wallHalfSet) s.end();
    for (const s of this.wallHalfGhost) s.end();
    for (const byAge of this.gateSets) for (const s of byAge) s.end();
    for (const byAge of this.gateGhost) for (const s of byAge) s.end();
    for (const byAge of this.gateLeafSets) for (const s of byAge) s.end();
    for (const byAge of this.gateLeafGhost) for (const s of byAge) s.end();
    for (const s of this.mineSets) s.end();
    for (let kind = 0; kind < this.iconMeshes.length; kind++) {
      const mesh = this.iconMeshes[kind];
      mesh.count = this.iconCounts[kind]; mesh.visible = mesh.count > 0; mesh.instanceMatrix.needsUpdate = true;
    }
    this.ringSet.end(); this.hpRingSet.end(); this.dashSet.end(); this.barSet.end(); this.boulderSet.end(); this.fireSet.end(); this.rangeSet.end();

    // arrows (visual only)
    this.arrowSet.begin();
    for (let i = this.arrows.length - 1; i >= 0; i--) {
      const a = this.arrows[i];
      a.t += dt;
      const t = a.t / a.dur;
      if (t >= 1) {
        if (a.puff) this.particles.emit(a.tx, a.ty, a.tz, 3, 0xb9a98a, { speed: 0.7, up: 0.5, life: 0.35, size: 0.12, gravity: 3 });
        this.arrows[i] = this.arrows[this.arrows.length - 1]; this.arrows.pop();
        continue;
      }
      if (t < 0) continue; // still on the string: a staggered volley arrow waiting its turn
      const x = a.fx + (a.tx - a.fx) * t, z = a.fz + (a.tz - a.fz) * t;
      const y = a.fy + (a.ty - a.fy) * t + a.lift * Math.sin(t * Math.PI);
      const rot = Math.atan2(a.tx - a.fx, a.tz - a.fz);
      // nose along the arc: climbing at the start, diving at the end
      const climb = (a.ty - a.fy) + a.lift * Math.PI * Math.cos(t * Math.PI);
      const pitch = -Math.atan2(climb, Math.max(0.001, Math.hypot(a.tx - a.fx, a.tz - a.fz)));
      this.arrowSet.add(x, y, z, rot, 1, NEUTRAL, 0, 1, 0, 0, pitch);
    }
    this.arrowSet.end();
    // click markers
    this.markerSet.begin();
    for (let i = this.markers.length - 1; i >= 0; i--) {
      const m = this.markers[i];
      m.t += dt;
      if (m.t > 0.6) { this.markers[i] = this.markers[this.markers.length - 1]; this.markers.pop(); continue; }
      const s = 1.6 - m.t * 1.8;
      this.markerSet.add(m.x, this.heightAt(m.x, m.z) + 0.05, m.z, 0, Math.max(0.2, s), m.color, 0, 0, 0, 0);
    }
    this.markerSet.end();
    void camYaw;
  }

  private addIcon(kind: number, m: THREE.Matrix4, right: THREE.Vector3, up: THREE.Vector3, x: number, y: number, z: number, size: number): void {
    if (this.iconCounts[kind] >= 64) return;
    const fwd = this.camFwd;
    m.set(right.x * size, up.x * size, fwd.x, x, right.y * size, up.y * size, fwd.y, y, right.z * size, up.z * size, fwd.z, z, 0, 0, 0, 1);
    this.iconMeshes[kind].setMatrixAt(this.iconCounts[kind]++, m);
  }

  private addBar(m: THREE.Matrix4, right: THREE.Vector3, up: THREE.Vector3, x: number, y: number, z: number, w: number, h: number, hp: number, col: THREE.Color): void {
    // build a camera-facing quad matrix: columns = right*w, up*h, forward
    const fwd = this.camFwd; // right x up, worked out once per frame in sync()
    m.set(right.x * w, up.x * h, fwd.x, x, right.y * w, up.y * h, fwd.y, y, right.z * w, up.z * h, fwd.z, z, 0, 0, 0, 1);
    const set = this.barSet;
    if (set.count >= set.cap) return;
    const i = set.count++;
    set.mesh.setMatrixAt(i, m);
    set.mesh.setColorAt(i, col);
    (set.mesh.geometry.getAttribute('aAnim') as THREE.InstancedBufferAttribute).setXYZW(i, hp, this.colorblind ? 1 : 0, 0, 0);
  }
  colorblind = false;

  /** Feed simulation events into effects. Returns sound cues. */
  handleEvents(events: SimEvent[], sim: Simulation): { name: string; x: number; y: number }[] {
    const cues: { name: string; x: number; y: number }[] = [];
    const w = sim.world;
    const persp = this.perspective;
    const reveal = this.revealAll || persp < 0;
    for (const e of events) {
      const x = toFloat(e.x), z = toFloat(e.y);
      const vis = reveal || sim.fog.isVisible(persp, e.x, e.y);
      switch (e.type) {
        case EventType.Death: {
          if (!vis) break;
          const def = UNITS[e.v as UnitType];
          this.corpses.push({ type: e.v, owner: e.owner, x, z, rot: this.facing[e.a] ?? 0, t: 0, age: e.owner >= 0 ? sim.players[e.owner].age : Age.First });
          if (def.bleeds) {
            this.decals.add(x, z, 0.8 + Math.random() * 0.6, 0x5a0d0d, 20);
            this.particles.emit(x, this.heightAt(x, z) + 0.4, z, 10, 0x8a1515, { speed: 1.5, up: 1.6, life: 0.5, size: 0.14 });
          } else {
            this.particles.emit(x, this.heightAt(x, z) + 0.4, z, 16, 0x8a5a2b, { speed: 2.5, up: 2.5, life: 0.8, size: 0.2 });
            this.particles.emit(x, this.heightAt(x, z) + 0.2, z, 10, 0xb9a98a, { speed: 1.5, up: 1, life: 0.9, size: 0.3, gravity: 1 });
          }
          cues.push({ name: 'death', x, y: z });
          break;
        }
        case EventType.Attack: {
          if (!vis) break;
          const src = e.a;
          if (w.alive[src]) {
            const ranged = e.v >= 100 || (e.v < UNIT_TYPE_COUNT && UNITS[e.v as UnitType].range > 1);
            const fx = toFloat(w.x[src]), fz = toFloat(w.y[src]);
            if (ranged) {
              const h0 = this.heightAt(fx, fz) + (e.v >= 100 ? 2.4 : 0.6);
              this.arrows.push({ fx, fy: h0, fz, tx: x, ty: this.heightAt(x, z) + 0.5, tz: z, t: 0, dur: 0.22 + Math.hypot(x - fx, z - fz) * 0.03, lift: 1.2, puff: false });
              cues.push({ name: 'arrow', x, y: z });
            } else {
              this.particles.emit(x, this.heightAt(x, z) + 0.5, z, 4, 0xfff0b0, { speed: 1, up: 1, life: 0.25, size: 0.1 });
              cues.push({ name: 'hit', x, y: z });
            }
          }
          break;
        }
        case EventType.ProjectileLand: {
          if (!vis) break;
          this.particles.emit(x, this.heightAt(x, z) + 0.1, z, 24, 0xb9a98a, { speed: 3, up: 2.2, life: 0.9, size: 0.35, gravity: 3 });
          this.particles.emit(x, this.heightAt(x, z) + 0.1, z, 10, 0x6d6a66, { speed: 3, up: 3, life: 0.7, size: 0.16 });
          this.decals.add(x, z, 1.2, 0x3a3630, 12);
          cues.push({ name: 'boulder', x, y: z });
          break;
        }
        case EventType.ProjectileLaunch: {
          if (e.a >= 0 && w.alive[e.a]) this.swing[e.a] = SWING_DUR;
          if (vis && e.b >= 0 && w.alive[e.b] && w.buff[e.b]) this.particles.emit(x, this.heightAt(x, z) + 0.9, z, 10, 0xff8a2a, { speed: 1.2, up: 1.5, life: 0.5, size: 0.22, gravity: -0.5 });
          cues.push({ name: 'boulderLaunch', x, y: z });
          break;
        }
        case EventType.Bounty: {
          if (!vis) break;
          this.particles.emit(x, this.heightAt(x, z) + 0.6, z, 6, 0xffd54a, { speed: 0.4, up: 1.6, life: 0.7, size: 0.14, gravity: 0.5 });
          if (e.owner === persp) cues.push({ name: 'coin', x, y: z });
          break;
        }
        case EventType.Garrison: if (vis) this.particles.emit(x, this.heightAt(x, z) + 0.5, z, 6, 0xc9b28a, { speed: 0.6, up: 0.6, life: 0.4, size: 0.14, gravity: 1 }); break;
        case EventType.ForestBurnt: if (vis) { this.particles.emit(x, this.heightAt(x, z) + 0.6, z, 12, 0x3a3532, { speed: 0.6, up: 1.4, life: 1.6, size: 0.45, gravity: -0.4 }); this.decals.add(x, z, 1.1, 0x2a2420, 40); } break;
        case EventType.BuildingDestroyed: {
          if (!vis) break;
          const size = BUILDINGS[e.v as BuildingType].size;
          this.particles.emit(x, this.heightAt(x, z) + 0.5, z, 60, 0x5a4a3a, { speed: 3, up: 3, life: 1.6, size: 0.5, gravity: 2, spread: size });
          this.particles.emit(x, this.heightAt(x, z) + 1, z, 30, 0xff8a2a, { speed: 2, up: 3, life: 0.8, size: 0.35, gravity: -1, spread: size * 0.6 });
          this.decals.add(x, z, size * 1.3, 0x2a2622, 30);
          this.known.delete(e.a);
          cues.push({ name: 'boulder', x, y: z });
          break;
        }
        case EventType.AgeUp: {
          // every building of the player is rebuilt in stone at once: a puff of dust on each, gold over the castle
          for (let id = 0; id < w.maxId; id++) {
            if (!w.alive[id] || w.kind[id] !== Kind.Building || w.owner[id] !== e.owner) continue;
            if (!reveal && !sim.fog.isVisible(persp, w.x[id], w.y[id])) continue;
            const bx = toFloat(w.x[id]), bz = toFloat(w.y[id]);
            this.particles.emit(bx, this.heightAt(bx, bz) + 0.5, bz, 16, 0xc8c0b2, { speed: 1.4, up: 1.2, life: 1.0, size: 0.2, gravity: 2, spread: 1.5 });
          }
          if (vis) this.particles.emit(x, this.heightAt(x, z) + 1.5, z, 36, 0xffe08a, { speed: 2, up: 2, life: 0.8, size: 0.2, gravity: 2, spread: 1.5 });
          break;
        }
        case EventType.BuildingComplete: if (vis) this.particles.emit(x, this.heightAt(x, z) + 1, z, 20, 0xffe08a, { speed: 2, up: 2, life: 0.8, size: 0.2, gravity: 2, spread: 1.5 }); break;
        case EventType.Fire: if (vis) { this.decals.add(x, z, 4.2, 0x3a2a1a, 8); cues.push({ name: 'ability', x, y: z }); } break;
        case EventType.Ability: {
          if (e.v === AbilityId.Volley) {
            // one event per archer: he plays the shot and sends his own handful of arrows up over the target
            if (e.a >= 0 && w.alive[e.a]) this.swing[e.a] = SWING_DUR;
            if (vis && e.a >= 0 && w.alive[e.a]) {
              const fx = toFloat(w.x[e.a]), fz = toFloat(w.y[e.a]);
              const fy = this.heightAt(fx, fz) + 0.7;
              const spread = ABILITIES[AbilityId.Volley].radius;
              for (let k = 0; k < VOLLEY_ARROWS; k++) {
                const ang = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * spread;
                const tx = x + Math.cos(ang) * r, tz = z + Math.sin(ang) * r;
                this.arrows.push({
                  fx, fy, fz, tx, ty: this.heightAt(tx, tz) + 0.1, tz,
                  t: -k * 0.06, dur: 0.9, lift: 3.4, puff: true,
                });
              }
            }
            // a volley into the fog is not heard either: the sound alone would say where the enemy's archers are
            if (vis) cues.push({ name: 'ability', x, y: z });
            break;
          }
          if (vis) { this.particles.emit(x, this.heightAt(x, z) + 0.6, z, 14, 0xa0d8ff, { speed: 1.5, up: 2, life: 0.6, size: 0.18, gravity: 1 }); cues.push({ name: 'ability', x, y: z }); }
          break;
        }
        case EventType.Deposit: if (vis && Math.random() < 0.5) this.particles.emit(x, this.heightAt(x, z) + 0.9, z, 3, 0xffd54a, { speed: 0.5, up: 1.2, life: 0.5, size: 0.12 }); break;
        case EventType.MineDepleted: if (vis) this.particles.emit(x, this.heightAt(x, z) + 0.3, z, 30, 0x9a8a6a, { speed: 2, up: 1.5, life: 1, size: 0.4, spread: 2 }); break;
      }
    }
    return cues;
  }

  render(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.cam.update(dt);
    this.particles.update(dt);
    this.decals.update(dt);
    // sun follows the camera target so the shadow map covers the view
    const t = this.cam.target;
    this.sun.position.set(t.x + 40, 70, t.z + 25);
    this.sun.target.position.set(t.x, 0, t.z);
    this.sun.target.updateMatrixWorld();
    const sc = this.sun.shadow.camera;
    const ext = 22 + this.cam.distance * 0.9;
    sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.updateProjectionMatrix();
    this.gl.render(this.scene, this.cam.camera);
    this.drawCalls = this.gl.info.render.calls;
  }

  /**
   * Shadows on or off without flipping the shadow map's own switch: that changes the defines of every lit material,
   * and the next frame relinks all their programs - a 35-370 ms freeze (docs/PERF.md §3.2). Off skips the depth
   * pass and tells every receiver not to sample it, both of which are per-frame state, not program state. The
   * switch is thrown only the first time shadows are wanted in a match that started without them; that one
   * time does relink.
   */
  setShadows(on: boolean): void {
    this.shadows = on;
    if (on && !this.gl.shadowMap.enabled) { this.gl.shadowMap.enabled = true; this.sun.castShadow = true; }
    this.gl.shadowMap.autoUpdate = on;
    this.gl.shadowMap.needsUpdate = on;
    for (const o of this.shadowReceivers) o.receiveShadow = on;
  }

  dispose(): void {
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
    });
    this.fogTex.dispose();
    this.gl.dispose();
  }
}

function addStaticAttrs(g: THREE.BufferGeometry, color = 0xffffff): void {
  const n = g.attributes.position.count;
  const c = new THREE.Color(color);
  const col = new Float32Array(n * 3), team = new Float32Array(n), part = new Float32Array(n);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('teamMask', new THREE.BufferAttribute(team, 1));
  g.setAttribute('part', new THREE.BufferAttribute(part, 1));
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Visual-only heightmap: smooth value noise with cliffs for rock and basins for water (interior vertices only). */
function buildHeightmap(map: MapData): Float32Array {
  const W = map.w + 1, H = map.h + 1;
  const h = new Float32Array(W * H);
  const rnd = mulberry(map.visualSeed ^ 0x51ed);
  // coarse noise lattice
  const cs = 6;
  const gw = Math.ceil(map.w / cs) + 2, gh = Math.ceil(map.h / cs) + 2;
  const lattice = new Float32Array(gw * gh);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rnd();
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const isTile = (x: number, y: number, t: number) => x >= 0 && y >= 0 && x < map.w && y < map.h && map.tiles[y * map.w + x] === t;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const gx = x / cs, gy = y / cs;
    const ix = Math.floor(gx), iy = Math.floor(gy);
    const fx = smooth(gx - ix), fy = smooth(gy - iy);
    const a = lattice[iy * gw + ix], b = lattice[iy * gw + ix + 1], c = lattice[(iy + 1) * gw + ix], d = lattice[(iy + 1) * gw + ix + 1];
    let v = ((a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy - 0.5) * 0.7;
    // tile modifiers: only when all 4 cells around the vertex agree
    const rock = isTile(x, y, Tile.Rock) && isTile(x - 1, y, Tile.Rock) && isTile(x, y - 1, Tile.Rock) && isTile(x - 1, y - 1, Tile.Rock);
    const water = isTile(x, y, Tile.Water) && isTile(x - 1, y, Tile.Water) && isTile(x, y - 1, Tile.Water) && isTile(x - 1, y - 1, Tile.Water);
    const anyWater = isTile(x, y, Tile.Water) || isTile(x - 1, y, Tile.Water) || isTile(x, y - 1, Tile.Water) || isTile(x - 1, y - 1, Tile.Water);
    if (rock) v += 1.1 + rnd() * 0.5;
    else if (water) v = -0.9;
    else if (anyWater) v = Math.min(v, -0.15);
    h[y * W + x] = v;
  }
  return h;
}
