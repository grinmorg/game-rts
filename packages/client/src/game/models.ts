import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { AGE_COUNT, Age, BUILDINGS, BUILDING_TYPE_COUNT, BuildingType, MINE_SIZE, UNIT_TYPE_COUNT, UnitType } from '@rookfall/sim';

/**
 * Geometry conventions used by the renderer's instanced shader:
 *  - `color`    vec3 per-vertex base color
 *  - `teamMask` 1.0 where the player color replaces the base color
 *  - `part`     animation part id: 0 static body, 1 left leg, 2 right leg, 3 right arm/weapon, 4 left arm/shield, 5 wheel, 6 catapult arm
 */
export interface ModelGeo {
  geometry: THREE.BufferGeometry;
  height: number;
  /** pivots used by the vertex animation (y values) */
  hipY: number;
  shoulderY: number;
}

/**
 * Every building has three construction stages (Level1 -> Level2 -> Level3 of the asset pack); the
 * finished building is always the Level3 model. There is one set per age: wood for the first, stone for the
 * second (`_SecondAge_` files). `banner` adds a team-coloured flag to the last stage for models whose
 * materials carry no team colour of their own.
 */
interface BuildingFiles { files: [string, string, string]; team: string[]; banner?: [number, number] }
const BUILDING_FILES: Record<Age, Record<BuildingType, BuildingFiles>> = {
  [Age.First]: {
    [BuildingType.Castle]: { files: ['Wonder_FirstAge_Level1', 'Wonder_FirstAge_Level2', 'Wonder_FirstAge_Level3'], team: ['Main'] },
    [BuildingType.House]: { files: ['Houses_FirstAge_1_Level1', 'Houses_FirstAge_1_Level2', 'Houses_FirstAge_1_Level3'], team: [], banner: [0.5, 0.05] },
    [BuildingType.Barracks]: { files: ['Barracks_FirstAge_Level1', 'Barracks_FirstAge_Level2', 'Barracks_FirstAge_Level3'], team: ['Main'] },
    [BuildingType.Forge]: { files: ['Storage_FirstAge_Level1', 'Storage_FirstAge_Level2', 'Storage_FirstAge_Leve3'], team: [], banner: [1.5, 1.35] }, // flagpole beside the barn: the model itself has no team material
    [BuildingType.Tower]: { files: ['WatchTower_FirstAge_Level1', 'WatchTower_FirstAge_Level2', 'WatchTower_FirstAge_Level3'], team: ['Main'] },
    // the fence has a single model in the pack: all three stages share it and only the build-up scale differs
    [BuildingType.Wall]: { files: ['Wall_FirstAge', 'Wall_FirstAge', 'Wall_FirstAge'], team: [] },
    [BuildingType.Mine]: { files: ['Mine', 'Mine', 'Mine'], team: [], banner: [1.05, 0.95] },
  },
  [Age.Second]: {
    [BuildingType.Castle]: { files: ['Wonder_SecondAge_Level1', 'Wonder_SecondAge_Level2', 'Wonder_SecondAge_Level3'], team: ['Main'] },
    [BuildingType.House]: { files: ['Houses_SecondAge_1_Level1', 'Houses_SecondAge_1_Level2', 'Houses_SecondAge_1_Level3'], team: ['Main'] },
    [BuildingType.Barracks]: { files: ['Barracks_SecondAge_Level1', 'Barracks_SecondAge_Level2', 'Barracks_SecondAge_Level3'], team: ['Main'] },
    [BuildingType.Forge]: { files: ['Storage_SecondAge_Level1', 'Storage_SecondAge_Level2', 'Storage_SecondAge_Level3'], team: ['Main'] },
    [BuildingType.Tower]: { files: ['WatchTower_SecondAge_Level1', 'WatchTower_SecondAge_Level2', 'WatchTower_SecondAge_Level3'], team: ['Main'] },
    [BuildingType.Wall]: { files: ['Wall_SecondAge', 'Wall_SecondAge', 'Wall_SecondAge'], team: [] },
    // the mine has no aged variant in the pack
    [BuildingType.Mine]: { files: ['Mine', 'Mine', 'Mine'], team: [], banner: [1.05, 0.95] },
  },
};
/**
 * Units are modelled in Blender rather than assembled from boxes here: see scripts/blender/units.py and
 * scripts/blender/catapult.py, which export these files (`pnpm assets` copies them next to the pack's
 * models). Every unit exists once per age - cloth and plain steel in the first, iron in the second.
 *
 * Each model is authored facing +z, standing on y = 0 and at the scale the renderer draws it, and carries
 * its animation parts in its material names (see PART_PREFIX). The catapult's throwing arm additionally
 * pivots around the axle at (y 0.30, z 0.20) that the vertex shader hard-codes for part 6; the ram's log
 * (part 9) is thrust forward along +z instead, so it needs no pivot at all.
 */
const UNIT_FILES: Record<UnitType, string> = {
  [UnitType.Worker]: 'Worker',
  [UnitType.Soldier]: 'Soldier',
  [UnitType.Archer]: 'Archer',
  [UnitType.Catapult]: 'Catapult',
  [UnitType.Militia]: 'Militia',
  [UnitType.Cavalry]: 'Cavalry',
  [UnitType.Ram]: 'Ram',
};
const AGE_SUFFIX: Record<Age, string> = { [Age.First]: 'FirstAge', [Age.Second]: 'SecondAge' };
const unitFile = (type: UnitType, age: Age): string => `${UNIT_FILES[type]}_${AGE_SUFFIX[age]}`;

/** material name prefix -> animation part id for the shader; see the header of scripts/blender/common.py */
const PART_PREFIX: [string, number][] = [
  ['LegA', 1], ['LegB', 2], ['Right', 3], ['Left', 4], ['Wheel', 5], ['Arm', 6],
  // 7 and 8 both ride the right arm: the tool it holds when empty-handed, and the load it holds instead
  ['Tool', 7], ['Load', 8],
  // 9 is the ram's log, which slides forward along its own axis instead of turning around a pivot
  ['Log', 9],
];
const unitPart = (material: string): number => {
  for (const [prefix, id] of PART_PREFIX) if (material.startsWith(prefix)) return id;
  return 0;
};
/** `Team` is the player's colour - on a moving part it is suffixed, as in `Left_Team` on a shield */
const TEAM_MATERIALS = ['Team'];

/** the neutral gold deposit comes in three shapes; the renderer picks one per deposit by position */
const GOLD_FILES = ['Resource_Gold_1', 'Resource_Gold_2', 'Resource_Gold_3'];

/** construction stages per building type */
export const BUILD_STAGES = 3;
/** fence height in cells; the pack's wall panel spans ~3 cells, so it is squashed to one */
const WALL_HEIGHT = 0.85;
/**
 * The gatehouse of a fence line (see GATE_LENGTH): a two-tower section with a door, drawn across the two middle
 * cells of the run in place of their panels. Per age, the open-door model and the closed-door one - the owner's
 * team sees its gate standing open, everyone else sees it barred, which is exactly what the rule is.
 */
const GATE_FILES: Record<Age, [string, string]> = {
  [Age.First]: ['WallTowers_Door_FirstAge', 'WallTowers_DoorClosed_FirstAge'],
  [Age.Second]: ['WallTowers_Door_SecondAge', 'WallTowers_DoorClosed_SecondAge'],
};
/**
 * Cells the gatehouse spans, and how tall it stands - a little above the fence line, the towers higher still.
 * It covers the two middle cells of the run whole and half of each cell beside them, which those two draw around
 * (see Renderer.addGate): squeezed into two cells the section came out a third narrower than the pack modelled it,
 * and the doorway with it.
 */
export const GATE_WIDTH = 3;
const GATE_HEIGHT = 1.12;
/**
 * How much wider the doorway is cut than the pack modelled it. The gate opens a passage one map cell wide and a
 * catapult has to drive through it, while the model's door is barely wider than a man; the opening is stretched by
 * this much and the wall to either side squeezed by as much, so the gatehouse still spans GATE_WIDTH cells.
 */
const DOOR_WIDEN = 2;
/** how far a leaf swings when the gate stands open, radians */
export const DOOR_SWING = Math.PI * 0.55;

/** Stage index (0..2) to draw for a building at `progress` (0..1). */
export function buildStage(progress: number): number {
  if (progress >= 1) return BUILD_STAGES - 1;
  const st = Math.floor(progress * BUILD_STAGES);
  return st < 0 ? 0 : st > BUILD_STAGES - 1 ? BUILD_STAGES - 1 : st;
}
const DECOR_FILES = ['Resource_Tree1', 'Resource_Tree2', 'Resource_PineTree', 'Rock', 'Resource_Rock_1'];

export class Models {
  /** buildings[age][type][stage], stage 0..2 (see `buildStage`) */
  buildings: ModelGeo[][][] = [];
  /** per age: half-cell fence panel running from the cell centre toward +x; corners and junctions are built from these */
  wallHalf: ModelGeo[] = [];
  /** gates[age][0 = doorway empty, 1 = barred]: the gatehouse spanning the middle of a fence run, see GATE_FILES */
  gates: ModelGeo[][] = [];
  /**
   * gateLeaves[age][0 = left, 1 = right]: the two door leaves cut out of the barred model, each with its hinge at
   * the origin so the renderer can swing it. Empty if the two gate models did not line up (see doorLeaves), and
   * then the gate just swaps between the two whole models instead of animating.
   */
  gateLeaves: ModelGeo[][] = [];
  /** gateHinge[age][0 = left, 1 = right]: where that leaf's hinge sits, in cells from the middle of the gatehouse */
  gateHinge: number[][] = [];
  /** units[age][type]: the second age dresses everyone in iron and gives the worker a feathered hat */
  units: ModelGeo[][] = [];
  /** gold deposit variants, see GOLD_FILES */
  mines: ModelGeo[] = [];
  decor: ModelGeo[] = [];
  private loader = newLoader();

  async load(base = '/models/'): Promise<void> {
    const loads: Promise<void>[] = [];
    for (let age = 0; age < AGE_COUNT; age++) {
      this.buildings[age] = [];
      for (let t = 0; t < BUILDING_TYPE_COUNT; t++) {
        const bt = t as BuildingType;
        const def = BUILDING_FILES[age as Age][bt];
        // the same file may serve several stages (the fence), so load each distinct one once
        const unique = [...new Set(def.files)];
        loads.push(Promise.all(unique.map((f) => loadGltf(this.loader, `${base}${f}.glb`, def.team))).then((loaded) => {
          const byFile = new Map(unique.map((f, i) => [f, loaded[i]]));
          const stages = def.files.map((f, i) => (i === def.files.indexOf(f) ? byFile.get(f)! : cloneGeo(byFile.get(f)!)));
          const size = BUILDINGS[bt].size;
          if (bt === BuildingType.Wall) {
            // clone before fitWall mutates stage 0, which is the raw model itself
            this.wallHalf[age] = fitWall(cloneGeo(stages[0]), 0.5, WALL_HEIGHT);
            this.wallHalf[age].geometry.translate(0.25, 0, 0);
          }
          // one scale for all stages (taken from the finished model) so the building grows instead of jumping
          this.buildings[age][t] = bt === BuildingType.Wall
            ? stages.map((g) => fitWall(g, 1, WALL_HEIGHT))
            : fitFootprintStages(stages, size * 0.92);
          if (def.banner) addBanner(this.buildings[age][t][BUILD_STAGES - 1], def.banner[0], def.banner[1]);
        }));
      }
    }
    for (let age = 0; age < AGE_COUNT; age++) {
      this.units[age] = [];
      for (let t = 0; t < UNIT_TYPE_COUNT; t++) {
        loads.push(loadGltf(this.loader, `${base}${unitFile(t as UnitType, age as Age)}.glb`, TEAM_MATERIALS, unitPart)
          .then((g) => { this.units[age][t] = g; }));
      }
    }
    for (let age = 0; age < AGE_COUNT; age++) {
      loads.push(Promise.all(GATE_FILES[age as Age].map((f) => loadGltf(this.loader, `${base}${f}.glb`, ['Main'])))
        .then(([frame, barred]) => {
          const leaves = doorLeaves(frame.geometry, barred.geometry);
          if (leaves) {
            const jamb = Math.max(...leaves.map((g) => extentX(g)));
            widenDoorway([frame.geometry, barred.geometry, ...leaves], jamb, DOOR_WIDEN);
          }
          // one transform for all of them, taken from the frame, so the leaves land exactly in its doorway
          const t = wallFit(frame.geometry, GATE_WIDTH, GATE_HEIGHT);
          this.gates[age] = [applyFit(frame, t), applyFit(barred, t)];
          this.gateLeaves[age] = []; this.gateHinge[age] = [];
          leaves?.forEach((g, i) => {
            const leaf = applyFit({ geometry: g, height: 0, hipY: 0, shoulderY: 0 }, t);
            // the hinge is the leaf's outer edge: the left one hangs on the left jamb, the right one on the right
            const hinge = i === 0 ? leaf.geometry.boundingBox!.min.x : leaf.geometry.boundingBox!.max.x;
            leaf.geometry.translate(-hinge, 0, 0);
            leaf.geometry.computeBoundingBox();
            this.gateLeaves[age][i] = leaf; this.gateHinge[age][i] = hinge;
          });
        }));
    }
    GOLD_FILES.forEach((f, i) => loads.push(loadGltf(this.loader, `${base}${f}.glb`, []).then((g) => { this.mines[i] = fitFootprint(g, MINE_SIZE * 0.95); })));
    DECOR_FILES.forEach((f, i) => loads.push(loadGltf(this.loader, `${base}${f}.glb`, []).then((g) => { this.decor[i] = fitFootprint(g, i < 3 ? 1.1 : 0.9, 1); })));
    await Promise.all(loads);
  }
}

/**
 * The asset pipeline (scripts/copy-models.mjs) ships meshopt-compressed, quantised .glb, so every loader
 * needs the decoder; it is a couple of dozen kilobytes and comes with three.
 */
function newLoader(): GLTFLoader {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

/**
 * Widen quantised attributes back to plain floats.
 *
 * Positions arrive as 14-bit and normals as 8-bit integers (KHR_mesh_quantization), which three keeps as
 * *normalized* integer attributes with the scale folded into the node's matrix. `applyMatrix4` writes the
 * world-space result straight back through `setXYZ`, and on a normalized attribute that renormalises it
 * into the integer range - every vertex of the model would clamp to the edge of its bounding box. So the
 * attributes are widened before any matrix is allowed near them. Float attributes pass through untouched.
 */
function deQuantize(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of Object.keys(geo.attributes)) {
    const a = geo.attributes[name];
    if (a instanceof THREE.BufferAttribute && a.array instanceof Float32Array && !a.normalized) continue;
    const items = a.itemSize;
    const out = new Float32Array(a.count * items);
    for (let i = 0; i < a.count; i++) {
      out[i * items] = a.getX(i);
      if (items > 1) out[i * items + 1] = a.getY(i);
      if (items > 2) out[i * items + 2] = a.getZ(i);
      if (items > 3) out[i * items + 3] = a.getW(i);
    }
    geo.setAttribute(name, new THREE.BufferAttribute(out, items));
  }
  return geo;
}

/**
 * Load one glTF file and flatten every mesh in it into a single geometry, baking each material's colour and
 * its team flag into the vertex attributes the instanced shader expects. `partOf` maps a material name onto
 * an animation part id, which is how a modelled unit tells the shader what moves. The two pivots those parts
 * turn around come with the model as well, as nodes named `Hip` and `Shoulder`; a model without them (every
 * building, and the catapult, whose arm has its own pivot in the shader) simply reports zero.
 */
function loadGltf(loader: GLTFLoader, url: string, teamMaterials: string[], partOf?: (material: string) => number): Promise<ModelGeo> {
  return new Promise((resolve, reject) => {
    loader.load(url, (gltf) => {
      const parts: THREE.BufferGeometry[] = [];
      gltf.scene.updateMatrixWorld(true);
      const jointY = (name: string): number => gltf.scene.getObjectByName(name)?.getWorldPosition(new THREE.Vector3()).y ?? 0;
      gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const geo = deQuantize(mesh.geometry.clone()).applyMatrix4(mesh.matrixWorld);
        const groups = geo.groups.length ? geo.groups : [{ start: 0, count: geo.index ? geo.index.count : geo.attributes.position.count, materialIndex: 0 }];
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const n = geo.attributes.position.count;
        const color = new Float32Array(n * 3);
        const team = new Float32Array(n);
        const part = new Float32Array(n);
        const idx = geo.index;
        for (const gr of groups) {
          const m = mats[gr.materialIndex ?? 0] as THREE.MeshStandardMaterial;
          const c = m?.color ?? new THREE.Color(0.6, 0.6, 0.6);
          const name = m?.name ?? '';
          const isTeam = teamMaterials.some((t) => name === t || name.endsWith(`_${t}`));
          const pid = partOf ? partOf(name) : 0;
          for (let i = gr.start; i < gr.start + gr.count; i++) {
            const v = idx ? idx.getX(i) : i;
            color[v * 3] = c.r; color[v * 3 + 1] = c.g; color[v * 3 + 2] = c.b;
            team[v] = isTeam ? 1 : 0;
            part[v] = pid;
          }
        }
        geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
        geo.setAttribute('teamMask', new THREE.BufferAttribute(team, 1));
        geo.setAttribute('part', new THREE.BufferAttribute(part, 1));
        geo.clearGroups();
        for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'color', 'teamMask', 'part'].includes(k)) geo.deleteAttribute(k);
        parts.push(geo.toNonIndexed());
      });
      const merged = mergeGeometries(parts, false);
      if (!merged) { reject(new Error(`empty model ${url}`)); return; }
      merged.computeBoundingBox();
      resolve({
        geometry: merged,
        height: merged.boundingBox!.max.y - merged.boundingBox!.min.y,
        hipY: jointY('Hip'),
        shoulderY: jointY('Shoulder'),
      });
    }, undefined, reject);
  });
}

/**
 * The pack's fence panel is one long segment; a wall entity is a single cell, so the panel is squashed
 * along its length to span exactly one cell while height and thickness stay at the scene's scale.
 * Assumes the panel runs along X (true for `Wall_FirstAge`).
 */
function fitWall(g: ModelGeo, width: number, height: number): ModelGeo {
  return applyFit(g, wallFit(g.geometry, width, height));
}
/** The move and scale `fitWall` would apply, so several geometries of one model can share the frame's. */
function wallFit(geo: THREE.BufferGeometry, width: number, height: number): { tx: number; ty: number; tz: number; sx: number; sy: number } {
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  return {
    tx: -(bb.min.x + bb.max.x) / 2, ty: -bb.min.y, tz: -(bb.min.z + bb.max.z) / 2,
    sx: width / (bb.max.x - bb.min.x), sy: height / (bb.max.y - bb.min.y),
  };
}
function applyFit(g: ModelGeo, t: { tx: number; ty: number; tz: number; sx: number; sy: number }): ModelGeo {
  const geo = g.geometry;
  geo.translate(t.tx, t.ty, t.tz);
  geo.scale(t.sx, t.sy, t.sy);
  geo.computeBoundingBox();
  geo.computeVertexNormals();
  return { geometry: geo, height: geo.boundingBox!.max.y, hipY: 0, shoulderY: 0 };
}

/** half the width of a geometry along x, measured from x = 0 */
function extentX(g: THREE.BufferGeometry): number {
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  return Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x));
}

/**
 * The two door leaves of the gatehouse. The pack ships the same section twice, once with the doorway empty and once
 * with it barred, and the barred mesh is the empty one plus the leaves - so the triangles the barred mesh has and
 * the other does not are exactly those leaves. They are matched by centroid (both models are quantised against the
 * same bounding box, so the numbers line up) and split into the left and right leaf. Null when the two meshes do
 * not line up like that, which leaves the renderer swapping whole models as before rather than drawing nonsense.
 */
function doorLeaves(frame: THREE.BufferGeometry, barred: THREE.BufferGeometry): [THREE.BufferGeometry, THREE.BufferGeometry] | null {
  const fa = frame.attributes.position as THREE.BufferAttribute, ba = barred.attributes.position as THREE.BufferAttribute;
  if (!fa || !ba || fa.count % 3 || ba.count % 3) return null;
  const key = (a: THREE.BufferAttribute, t: number): string => {
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 3; k++) { x += a.getX(t + k); y += a.getY(t + k); z += a.getZ(t + k); }
    return `${Math.round(x * 3e4)},${Math.round(y * 3e4)},${Math.round(z * 3e4)}`;
  };
  const known = new Set<string>();
  for (let t = 0; t < fa.count; t += 3) known.add(key(fa, t));
  const sides: [number[], number[]] = [[], []];
  for (let t = 0; t < ba.count; t += 3) {
    if (known.has(key(ba, t))) continue;
    sides[(ba.getX(t) + ba.getX(t + 1) + ba.getX(t + 2)) / 3 < 0 ? 0 : 1].push(t);
  }
  // a leaf on each side, and together a small part of the mesh - anything else means the models are not a pair
  if (!sides[0].length || !sides[1].length || (sides[0].length + sides[1].length) * 3 > ba.count / 3) return null;
  const pick = (starts: number[]): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry();
    for (const name of Object.keys(barred.attributes)) {
      const a = barred.attributes[name] as THREE.BufferAttribute;
      const n = a.itemSize, out = new Float32Array(starts.length * 3 * n);
      let o = 0;
      for (const t of starts) for (let k = 0; k < 3; k++) for (let c = 0; c < n; c++) out[o++] = a.array[(t + k) * n + c] as number;
      g.setAttribute(name, new THREE.BufferAttribute(out, n));
    }
    return g;
  };
  return [pick(sides[0]), pick(sides[1])];
}

/**
 * Cut the doorway wider. Everything within `jamb` of the middle - the doorway and the lintel over it - is stretched
 * by `k`, and the wall and towers to either side are squeezed towards the ends by as much, so the section still
 * spans exactly the width it is fitted to and only the opening grows.
 */
function widenDoorway(geos: THREE.BufferGeometry[], jamb: number, k: number): void {
  const half = Math.max(...geos.map(extentX));
  if (!(jamb > 0) || jamb * k >= half) return;
  const m = (half - jamb * k) / (half - jamb);
  for (const g of geos) {
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), ax = Math.abs(x);
      p.setX(i, ax <= jamb ? x * k : Math.sign(x) * (half - (half - ax) * m));
    }
    p.needsUpdate = true;
    g.computeBoundingBox();
  }
}

function cloneGeo(g: ModelGeo): ModelGeo {
  return { geometry: g.geometry.clone(), height: g.height, hipY: g.hipY, shoulderY: g.shoulderY };
}

function fitFootprint(g: ModelGeo, footprint: number, _heightScale = 1): ModelGeo {
  const geo = g.geometry;
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const w = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z);
  const s = footprint / w;
  geo.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  geo.scale(s, s, s);
  geo.computeBoundingBox();
  geo.computeVertexNormals();
  return { geometry: geo, height: geo.boundingBox!.max.y, hipY: 0, shoulderY: 0 };
}

/**
 * Centre every construction stage on the footprint and scale them all by the factor that makes the
 * *last* stage fit. Earlier stages are smaller models, so they read as an unfinished building.
 */
function fitFootprintStages(stages: ModelGeo[], footprint: number): ModelGeo[] {
  const last = stages[stages.length - 1].geometry;
  last.computeBoundingBox();
  const bb = last.boundingBox!;
  const s = footprint / Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z);
  return stages.map((g) => {
    const geo = g.geometry;
    geo.computeBoundingBox();
    const b = geo.boundingBox!;
    geo.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
    geo.scale(s, s, s);
    geo.computeBoundingBox();
    geo.computeVertexNormals();
    return { geometry: geo, height: geo.boundingBox!.max.y, hipY: 0, shoulderY: 0 };
  });
}

// ------------------------------------------------------------------ flags on pack buildings

interface PartSpec { geo: THREE.BufferGeometry; color: number; team?: boolean }

/** Bake a handful of boxes into one geometry with the attributes the instanced shader expects. */
function assemble(parts: PartSpec[]): THREE.BufferGeometry {
  const geos: THREE.BufferGeometry[] = [];
  for (const p of parts) {
    const g = p.geo.toNonIndexed();
    const n = g.attributes.position.count;
    const c = new THREE.Color(p.color);
    const col = new Float32Array(n * 3), team = new Float32Array(n), part = new Float32Array(n);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; team[i] = p.team ? 1 : 0; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('teamMask', new THREE.BufferAttribute(team, 1));
    g.setAttribute('part', new THREE.BufferAttribute(part, 1));
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color', 'teamMask', 'part'].includes(k)) g.deleteAttribute(k);
    geos.push(g);
  }
  const merged = mergeGeometries(geos, false)!;
  merged.computeVertexNormals();
  return merged;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

const DARK_WOOD = 0x5b3a1e;

function addBanner(m: ModelGeo, x: number, z: number): void {
  const pole = box(0.04, 1.1, 0.04, x, 0.55, z);
  const flag = box(0.02, 0.3, 0.32, x, 0.95, z + 0.17);
  const extra = assemble([{ geo: pole, color: DARK_WOOD }, { geo: flag, color: 0xffffff, team: true }]);
  const merged = mergeGeometries([m.geometry, extra], false)!;
  merged.computeBoundingBox();
  m.geometry = merged;
  m.height = Math.max(m.height, merged.boundingBox!.max.y);
}

// ------------------------------------------------------------------ menu background

/** Trees, rocks and catapults tumbling behind the menus. */
export const MENU_PROP_FILES = ['Resource_Tree1', 'Resource_Tree2', 'Resource_PineTree', 'Rock', 'Resource_Rock_1'];

/**
 * Props for the animated menu background: the pack's trees and rocks plus the modelled catapult of each age.
 * Every geometry is normalised to roughly one unit across its longest side and centred on its own middle so
 * it tumbles about itself - by the longest side rather than by height, so the wide catapult does not end up
 * dwarfing the trees. The team mask is baked into the vertex colours so a plain material can draw it: the
 * menu has no instanced shader and no player colours.
 */
export async function loadMenuProps(teamColor = 0xd8a13a, base = '/models/'): Promise<THREE.BufferGeometry[]> {
  const loader = newLoader();
  const loaded = await Promise.all([
    ...MENU_PROP_FILES.map((f) => loadGltf(loader, `${base}${f}.glb`, [])),
    ...[Age.First, Age.Second].map((age) => loadGltf(loader, `${base}${unitFile(UnitType.Catapult, age)}.glb`, TEAM_MATERIALS)),
  ]);
  const geos = loaded.map((g) => g.geometry);
  for (const geo of geos) bakeMenuProp(geo, teamColor);
  return geos;
}

function bakeMenuProp(geo: THREE.BufferGeometry, teamColor: number): void {
  const mask = geo.getAttribute('teamMask');
  const color = geo.getAttribute('color');
  if (mask && color) {
    const c = new THREE.Color(teamColor);
    for (let i = 0; i < mask.count; i++) if (mask.getX(i) > 0.5) color.setXYZ(i, c.r, c.g, c.b);
  }
  geo.deleteAttribute('teamMask');
  geo.deleteAttribute('part');
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const s = 1 / Math.max(0.001, bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z);
  geo.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, -(bb.min.z + bb.max.z) / 2);
  geo.scale(s, s, s);
  geo.computeBoundingBox();
  geo.computeVertexNormals();
}
