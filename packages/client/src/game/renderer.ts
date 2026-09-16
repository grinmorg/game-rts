import * as THREE from 'three';
import {
  BUILDINGS, BUILDING_TYPE_COUNT, BuildingState, BuildingType, EventType, FOG_VISIBLE, Kind, MapData, SimEvent, Simulation, Tile,
  UNITS, UnitState, UnitType, UpgradeId, buildingRangeCells, toFloat,
} from '@warlets/sim';
import { CameraController } from './camera';
import { Decals, Particles } from './effects';
import { BUILD_STAGES, ModelGeo, Models, buildStage } from './models';

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
/** seconds the catapult arm swing plays after a launch event */
const SWING_DUR = 0.75;

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
          if (p == 3) { float a = 0.0; if (st == 1) a = sin(ph * 6.2831) * 0.4;
            else if (st >= 2 && st <= 4) { float t = fract(ph); a = (t < 0.35) ? -1.7 * sin(t / 0.35 * 3.1416) : 0.0; }
            transformed.yz = rot2(transformed.yz - vec2(shoulderY, 0.0), a) + vec2(shoulderY, 0.0); }
          if (p == 4) { float a = (st == 1) ? -sin(ph * 6.2831) * 0.4 : ((st == 2) ? -0.3 : 0.0);
            transformed.yz = rot2(transformed.yz - vec2(shoulderY, 0.0), a) + vec2(shoulderY, 0.0); }
          if (p == 6) { float a = 0.0; if (st == 2) { float t = fract(ph); a = (t < 0.25) ? 1.4 * sin(t / 0.25 * 3.1416) : 0.0; }
            transformed.yz = rot2(transformed.yz - vec2(0.3, 0.2), a) + vec2(0.3, 0.2); }
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
  add(x: number, y: number, z: number, rotY: number, scale: number, color: THREE.Color, a0: number, a1: number, a2: number, a3: number) {
    if (this.count >= this.cap) return;
    const i = this.count++;
    this.q.setFromAxisAngle(this.axisY, rotY);
    this.v.set(x, y, z); this.sc.set(scale, scale, scale);
    this.mat4.compose(this.v, this.q, this.sc);
    this.mesh.setMatrixAt(i, this.mat4);
    this.mesh.setColorAt(i, color);
    this.anim.setXYZW(i, a0, a1, a2, a3);
  }
  end() {
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
    this.anim.needsUpdate = true;
  }
}

interface Corpse { type: number; owner: number; x: number; z: number; rot: number; t: number }
interface Arrow { fx: number; fy: number; fz: number; tx: number; ty: number; tz: number; t: number; dur: number }
interface Marker { x: number; z: number; t: number; color: number }
interface KnownBuilding { id: number; gen: number; type: number; owner: number; x: number; z: number; progress: number; links: number }

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
  private buildingSets: InstanceSet[][] = [];
  private ghostSets: InstanceSet[][] = [];
  private wallHalfSet: InstanceSet;
  private wallHalfGhost: InstanceSet;
  private unitSets: InstanceSet[] = [];
  /** gold deposit variants, one set per model (see Models.mines) */
  private mineSets: InstanceSet[] = [];
  private iconMeshes: THREE.InstancedMesh[] = [];
  private iconCounts = [0, 0];
  /** ghost cells of a fence line being dragged out */
  private placementLine: THREE.InstancedMesh;
  private decorSets: InstanceSet[] = [];
  private ringSet: InstanceSet;
  private barSet: InstanceSet;
  private arrowSet: InstanceSet;
  private boulderSet: InstanceSet;
  private markerSet: InstanceSet;
  private fireSet: InstanceSet;
  private rangeSet: InstanceSet;
  private placementRange: THREE.Mesh;
  private facing = new Float32Array(4096);
  private phase = new Float32Array(4096);
  /** seconds left of a catapult arm swing triggered by a launch event (view only) */
  private swing = new Float32Array(4096);
  private corpses: Corpse[] = [];
  private arrows: Arrow[] = [];
  private markers: Marker[] = [];
  private known = new Map<number, KnownBuilding>();
  private sun: THREE.DirectionalLight;
  private placement: THREE.Mesh;
  private tmpV = new THREE.Vector3();
  private lastTime = performance.now();
  private white = new THREE.Color(0xffffff);
  private rangeDim = new THREE.Color(0x8a8a8a);
  private selColor = new THREE.Color(0x7fe08a);
  private placeOkColor = new THREE.Color(0x4ad35a);
  private placeBadColor = new THREE.Color(0xe04a4a);
  private enemySel = new THREE.Color(0xff6b6b);
  private allySel = new THREE.Color(0x7fb8ff);
  private hpGreen = new THREE.Color(0x4ad35a);
  private hpDark = new THREE.Color(0x3a1414);
  private mapW: number;
  private mapH: number;
  private map: MapData;
  shadows = true;
  drawCalls = 0;

  constructor(readonly canvas: HTMLCanvasElement, map: MapData, readonly models: Models, shadows: boolean) {
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

    // instanced sets
    for (let t = 0; t < BUILDING_TYPE_COUNT; t++) {
      // walls are cheap and get spammed along a base perimeter, so they need a much bigger cap
      const cap = t === BuildingType.Wall ? 512 : 96;
      this.buildingSets[t] = []; this.ghostSets[t] = [];
      for (let st = 0; st < BUILD_STAGES; st++) {
        const m = models.buildings[t][st];
        this.buildingSets[t][st] = new InstanceSet(m.geometry, makeInstancedMaterial(this.fogU, false, 0, 0), cap, shadows);
        this.ghostSets[t][st] = new InstanceSet(m.geometry, makeInstancedMaterial(this.fogU, false, 0, 0, true), cap, false);
        this.scene.add(this.buildingSets[t][st].mesh, this.ghostSets[t][st].mesh);
      }
    }
    this.wallHalfSet = new InstanceSet(models.wallHalf.geometry, makeInstancedMaterial(this.fogU, false, 0, 0), 1024, shadows);
    this.wallHalfGhost = new InstanceSet(models.wallHalf.geometry, makeInstancedMaterial(this.fogU, false, 0, 0, true), 1024, false);
    this.scene.add(this.wallHalfSet.mesh, this.wallHalfGhost.mesh);
    const unitCaps = [400, 500, 500, 120, 120];
    for (let t = 0; t < 5; t++) {
      const m = models.units[t];
      this.unitSets[t] = new InstanceSet(m.geometry, makeInstancedMaterial(this.fogU, true, m.hipY, m.shoulderY), unitCaps[t], shadows);
      this.scene.add(this.unitSets[t].mesh);
    }
    for (const m of models.mines) {
      const set = new InstanceSet(m.geometry, makeInstancedMaterial(this.fogU, false, 0, 0), 32, shadows);
      this.mineSets.push(set);
      this.scene.add(set.mesh);
    }
    // decor (static)
    const decorCounts = [0, 0, 0, 0, 0];
    for (const d of map.decor) decorCounts[d.type]++;
    for (let t = 0; t < 5; t++) {
      const m = models.decor[t];
      const set = new InstanceSet(m.geometry, makeInstancedMaterial(this.fogU, false, 0, 0), Math.max(1, decorCounts[t]), shadows && t < 3);
      set.begin();
      for (const d of map.decor) if (d.type === t) set.add(d.x, this.heightAt(d.x, d.y) - 0.05, d.y, d.rot, d.scale, NEUTRAL, 0, 1, 0, 0);
      set.end();
      this.decorSets[t] = set;
      this.scene.add(set.mesh);
    }
    // selection rings
    const ring = new THREE.RingGeometry(0.8, 1, 24).rotateX(-Math.PI / 2);
    addStaticAttrs(ring);
    const ringMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false });
    ringMat.onBeforeCompile = (s) => { s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float teamMask;').replace('#include <color_vertex>', 'vColor = instanceColor.xyz;'); };
    this.ringSet = new InstanceSet(ring, ringMat, 512, false);
    this.ringSet.mesh.renderOrder = 2;
    this.scene.add(this.ringSet.mesh);
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
    this.barSet = new InstanceSet(bar, barMat, 700, false);
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
    this.arrowSet = new InstanceSet(arrowGeo, makeInstancedMaterial(this.fogU, false, 0, 0), 300, false);
    const boulderGeo = new THREE.DodecahedronGeometry(0.22, 0); addStaticAttrs(boulderGeo, 0x6d6a66);
    this.boulderSet = new InstanceSet(boulderGeo, makeInstancedMaterial(this.fogU, false, 0, 0), 120, shadows);
    const markerGeo = new THREE.RingGeometry(0.3, 0.42, 20).rotateX(-Math.PI / 2); addStaticAttrs(markerGeo);
    const markerMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false });
    markerMat.onBeforeCompile = (s) => { s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float teamMask;').replace('#include <color_vertex>', 'vColor = instanceColor.xyz;'); };
    this.markerSet = new InstanceSet(markerGeo, markerMat, 32, false);
    const fireGeo = new THREE.ConeGeometry(0.25, 0.7, 6).translate(0, 0.35, 0); addStaticAttrs(fireGeo, 0xff7a1a);
    const fireMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 });
    fireMat.onBeforeCompile = (s) => { s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float teamMask; attribute vec4 aAnim;').replace('#include <begin_vertex>', 'vec3 transformed = position; transformed.y *= 0.7 + 0.5 * sin(aAnim.y * 9.0 + position.x * 5.0); transformed.xz *= 1.0 - transformed.y * 0.4;'); };
    this.fireSet = new InstanceSet(fireGeo, fireMat, 200, false);
    this.scene.add(this.arrowSet.mesh, this.boulderSet.mesh, this.markerSet.mesh, this.fireSet.mesh);
    // attack-range circles (thin white line, always visible on top of terrain)
    const rangeGeo = new THREE.RingGeometry(0.985, 1.0, 96).rotateX(-Math.PI / 2); addStaticAttrs(rangeGeo);
    const rangeMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.8, depthTest: false, depthWrite: false });
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

    this.resize();
  }

  // ---------------------------------------------------------------- terrain

  heightAt(x: number, z: number): number {
    const W = this.W + 1;
    let cx = Math.floor(x), cz = Math.floor(z);
    if (cx < 0) cx = 0; if (cz < 0) cz = 0; if (cx >= this.W) cx = this.W - 1; if (cz >= this.H) cz = this.H - 1;
    const fx = Math.min(1, Math.max(0, x - cx)), fz = Math.min(1, Math.max(0, z - cz));
    const h = this.heights;
    const h00 = h[cz * W + cx], h10 = h[cz * W + cx + 1], h01 = h[(cz + 1) * W + cx], h11 = h[(cz + 1) * W + cx + 1];
    return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
  }

  private buildTerrain(map: MapData) {
    const CH = 16;
    const W = map.w + 1;
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    injectFog(mat, this.fogU);
    const grass = [new THREE.Color(0x6fae4a), new THREE.Color(0x7bbb52), new THREE.Color(0x66a545), new THREE.Color(0x85c25a)];
    const colors: Record<number, THREE.Color> = { [Tile.Water]: new THREE.Color(0x3a6f9e), [Tile.Rock]: new THREE.Color(0x7d7f7a), [Tile.Forest]: new THREE.Color(0x4a7f35), [Tile.Dirt]: new THREE.Color(0xa88a5a) };
    const rnd = mulberry(map.visualSeed);
    for (let cy = 0; cy < map.h; cy += CH) for (let cx = 0; cx < map.w; cx += CH) {
      const w = Math.min(CH, map.w - cx), h = Math.min(CH, map.h - cy);
      const pos: number[] = [], col: number[] = [], idx: number[] = [];
      // per-cell quads with flat colours (two triangles, 4 unique verts per cell for crisp tile colours)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const gx = cx + x, gy = cy + y;
        const t = map.tiles[gy * map.w + gx];
        let c: THREE.Color;
        if (t === Tile.Grass) c = grass[Math.floor(rnd() * grass.length)];
        else c = colors[t] ?? grass[0];
        const shade = 0.94 + rnd() * 0.12;
        const base = pos.length / 3;
        const corners = [[0, 0], [1, 0], [0, 1], [1, 1]];
        for (const [ox, oy] of corners) {
          pos.push(gx + ox, this.heights[(gy + oy) * W + gx + ox], gy + oy);
          col.push(c.r * shade, c.g * shade, c.b * shade);
        }
        idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, mat);
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    }
    // water plane
    const water = new THREE.Mesh(new THREE.PlaneGeometry(map.w, map.h).rotateX(-Math.PI / 2).translate(map.w / 2, -0.28, map.h / 2),
      (() => { const m = new THREE.MeshLambertMaterial({ color: 0x3f86c4, transparent: true, opacity: 0.8 }); injectFog(m, this.fogU); return m; })());
    this.scene.add(water);
    // dark ground outside the map
    const outer = new THREE.Mesh(new THREE.PlaneGeometry(map.w * 4, map.h * 4).rotateX(-Math.PI / 2).translate(map.w / 2, -1.2, map.h / 2), new THREE.MeshBasicMaterial({ color: 0x0b0f16 }));
    this.scene.add(outer);
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
    const dir = this.cam.camera.position.clone().sub(p2).normalize();
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
    this.placementLine.instanceMatrix.needsUpdate = true;
    if (this.placementLine.instanceColor) this.placementLine.instanceColor.needsUpdate = true;
  }

  setPlacement(type: BuildingType | -1, cx: number, cy: number, ok: boolean, rangeBonus = 0): void {
    this.placementLine.count = 0;
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
    this.markers.push({ x, z: y, t: 0, color });
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
    for (const s of this.unitSets) s.begin();
    for (const set of this.buildingSets) for (const s of set) s.begin();
    for (const set of this.ghostSets) for (const s of set) s.begin();
    this.wallHalfSet.begin(); this.wallHalfGhost.begin();
    for (const s of this.mineSets) s.begin();
    this.iconCounts[0] = 0; this.iconCounts[1] = 0;
    this.ringSet.begin(); this.barSet.begin(); this.boulderSet.begin(); this.fireSet.begin(); this.rangeSet.begin();
    const time = performance.now() / 1000;
    const camYaw = this.cam.yaw;
    // camera basis for billboards
    const camQ = this.cam.camera.quaternion;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camQ), up = new THREE.Vector3(0, 1, 0).applyQuaternion(camQ);
    const barM = new THREE.Matrix4();

    // wall cells, so each fence segment can be turned to line up with its neighbours (view only)
    const wallCells = new Set<number>();
    for (let id = 0; id < w.maxId; id++) {
      if (w.alive[id] && w.kind[id] === Kind.Building && w.type[id] === BuildingType.Wall) wallCells.add(this.cellKey(w.x[id], w.y[id]));
    }

    const seenBuildings = new Set<number>();
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
        this.unitSets[type].add(x, y, z, f, UNIT_SCALE, col, st, this.phase[id], 0, 0);
        const sel = selected.has(id);
        if (sel || id === hover) {
          const rc = owner === persp || (owner >= 0 && persp >= 0 && sim.sameTeam(owner, persp)) ? (owner === persp ? this.selColor : this.allySel) : this.enemySel;
          this.ringSet.add(x, y + 0.03, z, 0, def.radius * 1.6, sel ? rc : this.white, 0, 0, 0, 0);
        }
        // attack range of selected ranged units (reach to a target's edge = range + own radius)
        if (sel && def.range > 1) {
          this.rangeSet.add(x, y + 0.06, z, 0, toFloat(sim.unitRange(id)) + def.radius, this.white, 0, 0, 0, 0);
          if (def.minRange > 0) this.rangeSet.add(x, y + 0.06, z, 0, def.minRange, this.rangeDim, 0, 0, 0, 0);
        }
        const hpF = w.hp[id] / w.maxHp[id];
        if (bars === 'always' || (bars === 'damaged' && (hpF < 0.999 || sel)) || (bars === 'selected' && sel)) {
          this.addBar(barM, right, up, x, y + this.models.units[type].height * UNIT_SCALE + 0.25, z, 0.9, 0.11, hpF, col);
        }
      } else if (k === Kind.Building) {
        const type = w.type[id];
        const def = BUILDINGS[type as BuildingType];
        const progress = w.state[id] === BuildingState.Complete ? 1 : w.progress[id] / (def.buildTime * 10);
        const stage = buildStage(progress);
        const links = type === BuildingType.Wall ? this.wallLinks(w.x[id], w.y[id], wallCells) : 0;
        if (visible) {
          seenBuildings.add(id);
          this.known.set(id, { id, gen: w.gen[id], type, owner, x, z, progress, links });
          const col = owner >= 0 ? playerColor(sim.players[owner].color) : NEUTRAL;
          const y = this.heightAt(x, z);
          if (type === BuildingType.Wall) this.addWall(this.buildingSets[type][stage], this.wallHalfSet, links, x, y, z, col, progress);
          else this.buildingSets[type][stage].add(x, y, z, 0, 1, col, 0, progress, 0, 0);
          const sel = selected.has(id);
          if (sel || id === hover) {
            const rc = owner === persp ? this.selColor : owner >= 0 && persp >= 0 && sim.sameTeam(owner, persp) ? this.allySel : this.enemySel;
            this.ringSet.add(x, y + 0.03, z, 0, def.size * 0.72, sel ? rc : this.white, 0, 0, 0, 0);
          }
          // attack range of selected defensive buildings (castle, tower), incl. the range upgrade
          if (sel && def.range > 0 && progress >= 1) {
            this.rangeSet.add(x, y + 0.06, z, 0, buildingRangeCells(type as BuildingType, owner >= 0 ? sim.players[owner].upgrades[UpgradeId.Range] : 0), this.white, 0, 0, 0, 0);
          }
          const hpF = w.hp[id] / w.maxHp[id];
          const mh = this.models.buildings[type][stage].height;
          if (bars === 'always' || sel || (bars === 'damaged' && (hpF < 0.999 || progress < 1))) {
            this.addBar(barM, right, up, x, y + mh + 0.4, z, def.size * 0.8, 0.14, progress < 1 ? progress : hpF, col);
          }
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
        if (selected.has(id) || id === hover) this.ringSet.add(x, y + 0.03, z, 0, 2.1, selected.has(id) ? this.white : this.white, 0, 0, 0, 0);
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
      if (kb.type === BuildingType.Wall) this.addWall(this.ghostSets[kb.type][buildStage(kb.progress)], this.wallHalfGhost, kb.links, kb.x, gy, kb.z, col, kb.progress);
      else this.ghostSets[kb.type][buildStage(kb.progress)].add(kb.x, gy, kb.z, 0, 1, col, 0, kb.progress, 0, 0);
    }
    // corpses (death animation)
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      c.t += dt;
      if (c.t > 2.6) { this.corpses[i] = this.corpses[this.corpses.length - 1]; this.corpses.pop(); continue; }
      const col = c.owner >= 0 ? playerColor(sim.players[c.owner].color) : NEUTRAL;
      this.unitSets[c.type].add(c.x, this.heightAt(c.x, c.z), c.z, c.rot, UNIT_SCALE, col, 5, 0, 0, c.t);
    }
    for (const s of this.unitSets) s.end();
    for (const set of this.buildingSets) for (const s of set) s.end();
    for (const set of this.ghostSets) for (const s of set) s.end();
    this.wallHalfSet.end(); this.wallHalfGhost.end();
    for (const s of this.mineSets) s.end();
    for (const kind of [ICON_WORKER, ICON_POP]) { this.iconMeshes[kind].count = this.iconCounts[kind]; this.iconMeshes[kind].instanceMatrix.needsUpdate = true; }
    this.ringSet.end(); this.barSet.end(); this.boulderSet.end(); this.fireSet.end(); this.rangeSet.end();

    // arrows (visual only)
    this.arrowSet.begin();
    for (let i = this.arrows.length - 1; i >= 0; i--) {
      const a = this.arrows[i];
      a.t += dt;
      const t = a.t / a.dur;
      if (t >= 1) { this.arrows[i] = this.arrows[this.arrows.length - 1]; this.arrows.pop(); continue; }
      const x = a.fx + (a.tx - a.fx) * t, z = a.fz + (a.tz - a.fz) * t;
      const y = a.fy + (a.ty - a.fy) * t + 1.2 * Math.sin(t * Math.PI);
      const rot = Math.atan2(a.tx - a.fx, a.tz - a.fz);
      this.arrowSet.add(x, y, z, rot, 1, NEUTRAL, 0, 1, 0, 0);
    }
    this.arrowSet.end();
    // click markers
    this.markerSet.begin();
    for (let i = this.markers.length - 1; i >= 0; i--) {
      const m = this.markers[i];
      m.t += dt;
      if (m.t > 0.6) { this.markers[i] = this.markers[this.markers.length - 1]; this.markers.pop(); continue; }
      const s = 1.6 - m.t * 1.8;
      this.markerSet.add(m.x, this.heightAt(m.x, m.z) + 0.05, m.z, 0, Math.max(0.2, s), new THREE.Color(m.color), 0, 0, 0, 0);
    }
    this.markerSet.end();
    void camYaw;
  }

  private addIcon(kind: number, m: THREE.Matrix4, right: THREE.Vector3, up: THREE.Vector3, x: number, y: number, z: number, size: number): void {
    if (this.iconCounts[kind] >= 64) return;
    const fwd = right.clone().cross(up);
    m.set(right.x * size, up.x * size, fwd.x, x, right.y * size, up.y * size, fwd.y, y, right.z * size, up.z * size, fwd.z, z, 0, 0, 0, 1);
    this.iconMeshes[kind].setMatrixAt(this.iconCounts[kind]++, m);
  }

  private addBar(m: THREE.Matrix4, right: THREE.Vector3, up: THREE.Vector3, x: number, y: number, z: number, w: number, h: number, hp: number, col: THREE.Color): void {
    // build a camera-facing quad matrix: columns = right*w, up*h, forward
    const fwd = right.clone().cross(up);
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
          this.corpses.push({ type: e.v, owner: e.owner, x, z, rot: this.facing[e.a] ?? 0, t: 0 });
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
            const ranged = e.v >= 100 || (e.v < 5 && UNITS[e.v as UnitType].range > 1);
            const fx = toFloat(w.x[src]), fz = toFloat(w.y[src]);
            if (ranged) {
              const h0 = this.heightAt(fx, fz) + (e.v >= 100 ? 2.4 : 0.6);
              this.arrows.push({ fx, fy: h0, fz, tx: x, ty: this.heightAt(x, z) + 0.5, tz: z, t: 0, dur: 0.22 + Math.hypot(x - fx, z - fz) * 0.03 });
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
        case EventType.BuildingComplete: if (vis) this.particles.emit(x, this.heightAt(x, z) + 1, z, 20, 0xffe08a, { speed: 2, up: 2, life: 0.8, size: 0.2, gravity: 2, spread: 1.5 }); break;
        case EventType.Fire: if (vis) { this.decals.add(x, z, 4.2, 0x3a2a1a, 8); cues.push({ name: 'ability', x, y: z }); } break;
        case EventType.Ability: if (vis) { this.particles.emit(x, this.heightAt(x, z) + 0.6, z, 14, 0xa0d8ff, { speed: 1.5, up: 2, life: 0.6, size: 0.18, gravity: 1 }); cues.push({ name: 'ability', x, y: z }); } break;
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

  setShadows(on: boolean): void {
    this.shadows = on;
    this.gl.shadowMap.enabled = on;
    this.sun.castShadow = on;
    this.gl.shadowMap.needsUpdate = true;
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
