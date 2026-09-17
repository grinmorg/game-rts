import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
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
 * pivots around the axle at (y 0.30, z 0.20) that the vertex shader hard-codes for part 6.
 */
const UNIT_FILES: Record<UnitType, string> = {
  [UnitType.Worker]: 'Worker',
  [UnitType.Soldier]: 'Soldier',
  [UnitType.Archer]: 'Archer',
  [UnitType.Catapult]: 'Catapult',
  [UnitType.Militia]: 'Militia',
  [UnitType.Cavalry]: 'Cavalry',
};
const AGE_SUFFIX: Record<Age, string> = { [Age.First]: 'FirstAge', [Age.Second]: 'SecondAge' };
const unitFile = (type: UnitType, age: Age): string => `${UNIT_FILES[type]}_${AGE_SUFFIX[age]}`;

/** material name prefix -> animation part id for the shader; see the header of scripts/blender/common.py */
const PART_PREFIX: [string, number][] = [
  ['LegA', 1], ['LegB', 2], ['Right', 3], ['Left', 4], ['Wheel', 5], ['Arm', 6],
  // 7 and 8 both ride the right arm: the tool it holds when empty-handed, and the load it holds instead
  ['Tool', 7], ['Load', 8],
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
  /** units[age][type]: the second age dresses everyone in iron and gives the worker a feathered hat */
  units: ModelGeo[][] = [];
  /** gold deposit variants, see GOLD_FILES */
  mines: ModelGeo[] = [];
  decor: ModelGeo[] = [];
  private loader = new GLTFLoader();

  async load(base = '/models/'): Promise<void> {
    const loads: Promise<void>[] = [];
    for (let age = 0; age < AGE_COUNT; age++) {
      this.buildings[age] = [];
      for (let t = 0; t < BUILDING_TYPE_COUNT; t++) {
        const bt = t as BuildingType;
        const def = BUILDING_FILES[age as Age][bt];
        // the same file may serve several stages (the fence), so load each distinct one once
        const unique = [...new Set(def.files)];
        loads.push(Promise.all(unique.map((f) => loadGltf(this.loader, `${base}${f}.gltf`, def.team))).then((loaded) => {
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
    GOLD_FILES.forEach((f, i) => loads.push(loadGltf(this.loader, `${base}${f}.gltf`, []).then((g) => { this.mines[i] = fitFootprint(g, MINE_SIZE * 0.95); })));
    DECOR_FILES.forEach((f, i) => loads.push(loadGltf(this.loader, `${base}${f}.gltf`, []).then((g) => { this.decor[i] = fitFootprint(g, i < 3 ? 1.1 : 0.9, 1); })));
    await Promise.all(loads);
  }
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
        const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
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
  const geo = g.geometry;
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const sx = width / (bb.max.x - bb.min.x);
  const sy = height / (bb.max.y - bb.min.y);
  geo.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  geo.scale(sx, sy, sy);
  geo.computeBoundingBox();
  geo.computeVertexNormals();
  return { geometry: geo, height: geo.boundingBox!.max.y, hipY: 0, shoulderY: 0 };
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
  const loader = new GLTFLoader();
  const loaded = await Promise.all([
    ...MENU_PROP_FILES.map((f) => loadGltf(loader, `${base}${f}.gltf`, [])),
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
