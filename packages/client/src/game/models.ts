import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BUILDINGS, BUILDING_TYPE_COUNT, BuildingType, MINE_SIZE, UnitType } from '@warlets/sim';

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
 * finished building is always the Level3 model. `banner` adds a team-coloured flag to the last stage
 * for models whose materials carry no team colour of their own.
 */
const BUILDING_FILES: Record<BuildingType, { files: [string, string, string]; team: string[]; banner?: [number, number] }> = {
  [BuildingType.Castle]: { files: ['Wonder_FirstAge_Level1', 'Wonder_FirstAge_Level2', 'Wonder_FirstAge_Level3'], team: ['Main'] },
  [BuildingType.House]: { files: ['Houses_FirstAge_1_Level1', 'Houses_FirstAge_1_Level2', 'Houses_FirstAge_1_Level3'], team: [], banner: [0.5, 0.05] },
  [BuildingType.Barracks]: { files: ['Barracks_FirstAge_Level1', 'Barracks_FirstAge_Level2', 'Barracks_FirstAge_Level3'], team: ['Main'] },
  [BuildingType.Forge]: { files: ['Storage_FirstAge_Level1', 'Storage_FirstAge_Level2', 'Storage_FirstAge_Leve3'], team: [], banner: [1.5, 1.35] }, // flagpole beside the barn: the model itself has no team material
  [BuildingType.Tower]: { files: ['WatchTower_FirstAge_Level1', 'WatchTower_FirstAge_Level2', 'WatchTower_FirstAge_Level3'], team: ['Main'] },
  // the fence has a single model in the pack: all three stages share it and only the build-up scale differs
  [BuildingType.Wall]: { files: ['Wall_FirstAge', 'Wall_FirstAge', 'Wall_FirstAge'], team: [] },
  [BuildingType.Mine]: { files: ['Mine', 'Mine', 'Mine'], team: [], banner: [1.05, 0.95] },
};
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
  /** buildings[type][stage], stage 0..2 (see `buildStage`) */
  buildings: ModelGeo[][] = [];
  /** half-cell fence panel running from the cell centre toward +x; corners and junctions are built from these */
  wallHalf!: ModelGeo;
  units: ModelGeo[] = [];
  /** gold deposit variants, see GOLD_FILES */
  mines: ModelGeo[] = [];
  decor: ModelGeo[] = [];
  private loader = new GLTFLoader();

  async load(base = '/models/'): Promise<void> {
    const loads: Promise<void>[] = [];
    for (let t = 0; t < BUILDING_TYPE_COUNT; t++) {
      const bt = t as BuildingType;
      const def = BUILDING_FILES[bt];
      // the same file may serve several stages (the fence), so load each distinct one once
      const unique = [...new Set(def.files)];
      loads.push(Promise.all(unique.map((f) => this.loadGltf(`${base}${f}.gltf`, def.team))).then((loaded) => {
        const byFile = new Map(unique.map((f, i) => [f, loaded[i]]));
        const stages = def.files.map((f, i) => (i === def.files.indexOf(f) ? byFile.get(f)! : cloneGeo(byFile.get(f)!)));
        const size = BUILDINGS[bt].size;
        if (bt === BuildingType.Wall) {
          // clone before fitWall mutates stage 0, which is the raw model itself
          this.wallHalf = fitWall(cloneGeo(stages[0]), 0.5, WALL_HEIGHT);
          this.wallHalf.geometry.translate(0.25, 0, 0);
        }
        // one scale for all stages (taken from the finished model) so the building grows instead of jumping
        this.buildings[t] = bt === BuildingType.Wall
          ? stages.map((g) => fitWall(g, 1, WALL_HEIGHT))
          : fitFootprintStages(stages, size * 0.92);
        if (def.banner) addBanner(this.buildings[t][BUILD_STAGES - 1], def.banner[0], def.banner[1]);
      }));
    }
    GOLD_FILES.forEach((f, i) => loads.push(this.loadGltf(`${base}${f}.gltf`, []).then((g) => { this.mines[i] = fitFootprint(g, MINE_SIZE * 0.95); })));
    DECOR_FILES.forEach((f, i) => loads.push(this.loadGltf(`${base}${f}.gltf`, []).then((g) => { this.decor[i] = fitFootprint(g, i < 3 ? 1.1 : 0.9, 1); })));
    await Promise.all(loads);
    this.units[UnitType.Worker] = buildWorker();
    this.units[UnitType.Soldier] = buildSoldier(false);
    this.units[UnitType.Archer] = buildArcher();
    this.units[UnitType.Catapult] = buildCatapult();
    this.units[UnitType.Militia] = buildSoldier(true);
  }

  private loadGltf(url: string, teamMaterials: string[]): Promise<ModelGeo> {
    return new Promise((resolve, reject) => {
      this.loader.load(url, (gltf) => {
        const parts: THREE.BufferGeometry[] = [];
        gltf.scene.updateMatrixWorld(true);
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
            const isTeam = teamMaterials.includes(m?.name ?? '');
            for (let i = gr.start; i < gr.start + gr.count; i++) {
              const v = idx ? idx.getX(i) : i;
              color[v * 3] = c.r; color[v * 3 + 1] = c.g; color[v * 3 + 2] = c.b;
              team[v] = isTeam ? 1 : 0;
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
        resolve({ geometry: merged, height: merged.boundingBox!.max.y - merged.boundingBox!.min.y, hipY: 0, shoulderY: 0 });
      }, undefined, reject);
    });
  }
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

// ------------------------------------------------------------------ procedural units

interface PartSpec { geo: THREE.BufferGeometry; color: number; team?: boolean; part?: number }

function assemble(parts: PartSpec[], hipY: number, shoulderY: number): ModelGeo {
  const geos: THREE.BufferGeometry[] = [];
  for (const p of parts) {
    const g = p.geo.toNonIndexed();
    const n = g.attributes.position.count;
    const c = new THREE.Color(p.color);
    const col = new Float32Array(n * 3), team = new Float32Array(n), part = new Float32Array(n);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; team[i] = p.team ? 1 : 0; part[i] = p.part ?? 0; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('teamMask', new THREE.BufferAttribute(team, 1));
    g.setAttribute('part', new THREE.BufferAttribute(part, 1));
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color', 'teamMask', 'part'].includes(k)) g.deleteAttribute(k);
    geos.push(g);
  }
  const merged = mergeGeometries(geos, false)!;
  merged.computeVertexNormals();
  merged.computeBoundingBox();
  return { geometry: merged, height: merged.boundingBox!.max.y, hipY, shoulderY };
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.rotateX(rx); g.rotateY(ry); g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}
function cyl(rTop: number, rBot: number, h: number, x: number, y: number, z: number, seg = 8, rx = 0, rz = 0): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg);
  g.rotateX(rx); g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}
function sphere(r: number, x: number, y: number, z: number, seg = 8): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, seg, 6);
  g.translate(x, y, z);
  return g;
}
function cone(r: number, h: number, x: number, y: number, z: number, seg = 8): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(r, h, seg);
  g.translate(x, y, z);
  return g;
}

const SKIN = 0xe8b98a, DARK_WOOD = 0x5b3a1e, WOOD = 0x8a5a2b, STEEL = 0xa8b0bb, DARK_STEEL = 0x5a6068, LEATHER = 0x7a4a26, CLOTH = 0x6b5a45;

/** Humanoid base: legs (parts 1/2), torso, head. Height ~0.8 */
function humanoid(torsoColor: number, torsoTeam: boolean, legColor: number, scale = 1): PartSpec[] {
  const s = scale;
  return [
    { geo: box(0.09 * s, 0.24 * s, 0.1 * s, -0.07 * s, 0.12 * s, 0), color: legColor, part: 1 },
    { geo: box(0.09 * s, 0.24 * s, 0.1 * s, 0.07 * s, 0.12 * s, 0), color: legColor, part: 2 },
    { geo: box(0.26 * s, 0.3 * s, 0.16 * s, 0, 0.4 * s, 0), color: torsoColor, team: torsoTeam },
    { geo: sphere(0.1 * s, 0, 0.66 * s, 0), color: SKIN },
  ];
}

function buildWorker(): ModelGeo {
  const p = humanoid(CLOTH, false, 0x4a3a2a, 0.95);
  // team sash across the torso
  p.push({ geo: box(0.06, 0.3, 0.17, -0.06, 0.4, 0, 0, 0, 0.35), color: 0xffffff, team: true });
  // straw hat
  p.push({ geo: cyl(0.16, 0.16, 0.02, 0, 0.72, 0), color: 0xd8b463 });
  p.push({ geo: cyl(0.07, 0.09, 0.06, 0, 0.75, 0), color: 0xd8b463 });
  // right arm with pickaxe
  p.push({ geo: box(0.07, 0.24, 0.07, 0.17, 0.4, 0.02), color: SKIN, part: 3 });
  p.push({ geo: box(0.03, 0.34, 0.03, 0.17, 0.42, 0.14, Math.PI / 2), color: WOOD, part: 3 });
  p.push({ geo: box(0.05, 0.14, 0.05, 0.17, 0.42, 0.3, 0, 0, Math.PI / 2), color: DARK_STEEL, part: 3 });
  // left arm
  p.push({ geo: box(0.07, 0.24, 0.07, -0.17, 0.4, 0), color: SKIN, part: 4 });
  // backpack/sack
  p.push({ geo: sphere(0.09, 0, 0.45, -0.12, 6), color: 0xb08a5a });
  return assemble(p, 0.24, 0.5);
}

function buildSoldier(militia: boolean): ModelGeo {
  const armor = militia ? LEATHER : STEEL;
  const p = humanoid(armor, false, militia ? 0x4a3a2a : DARK_STEEL, 1);
  // helmet / cap
  if (militia) p.push({ geo: sphere(0.105, 0, 0.7, 0, 8), color: 0x6b4a2a });
  else {
    p.push({ geo: sphere(0.11, 0, 0.68, 0, 8), color: STEEL });
    p.push({ geo: box(0.03, 0.12, 0.2, 0, 0.8, 0), color: 0xffffff, team: true }); // plume
  }
  // tabard in team color
  p.push({ geo: box(0.16, 0.3, 0.04, 0, 0.4, 0.09), color: 0xffffff, team: true });
  // right arm + sword
  p.push({ geo: box(0.08, 0.26, 0.08, 0.18, 0.4, 0.02), color: armor, part: 3 });
  p.push({ geo: box(0.03, 0.42, 0.06, 0.18, 0.45, 0.28, Math.PI / 2), color: STEEL, part: 3 });
  p.push({ geo: box(0.1, 0.03, 0.03, 0.18, 0.28, 0.14), color: 0xd8b463, part: 3 });
  // left arm + big round shield (silhouette)
  p.push({ geo: box(0.08, 0.26, 0.08, -0.18, 0.4, 0.02), color: armor, part: 4 });
  p.push({ geo: cyl(0.2, 0.2, 0.035, -0.26, 0.42, 0.06, 12, 0, Math.PI / 2), color: 0xffffff, team: true, part: 4 });
  p.push({ geo: sphere(0.05, -0.29, 0.42, 0.06, 6), color: STEEL, part: 4 });
  return assemble(p, 0.24, 0.52);
}

function buildArcher(): ModelGeo {
  const p = humanoid(0x4f6b3a, false, 0x3a4a2a, 0.95);
  // hood in team color
  p.push({ geo: cone(0.13, 0.22, 0, 0.74, 0, 8), color: 0xffffff, team: true });
  // quiver
  p.push({ geo: cyl(0.04, 0.04, 0.3, -0.08, 0.5, -0.11, 6, 0, 0.3), color: LEATHER });
  p.push({ geo: box(0.05, 0.06, 0.05, -0.12, 0.66, -0.14), color: 0xd8d8d8 });
  // right arm (draw)
  p.push({ geo: box(0.07, 0.24, 0.07, 0.17, 0.4, 0.02), color: 0x4f6b3a, part: 3 });
  // left arm + bow (torus arc, silhouette)
  p.push({ geo: box(0.07, 0.24, 0.07, -0.17, 0.42, 0.1), color: 0x4f6b3a, part: 4 });
  const bow = new THREE.TorusGeometry(0.3, 0.018, 5, 12, Math.PI * 1.05);
  bow.rotateZ(-Math.PI * 0.525); bow.rotateY(Math.PI / 2); bow.translate(-0.2, 0.45, 0.22);
  p.push({ geo: bow, color: DARK_WOOD, part: 4 });
  p.push({ geo: box(0.005, 0.6, 0.005, -0.2, 0.45, 0.16), color: 0xdddddd, part: 4 });
  return assemble(p, 0.24, 0.5);
}

function buildCatapult(): ModelGeo {
  const p: PartSpec[] = [];
  // frame
  p.push({ geo: box(0.12, 0.12, 1.0, -0.3, 0.22, 0), color: WOOD });
  p.push({ geo: box(0.12, 0.12, 1.0, 0.3, 0.22, 0), color: WOOD });
  p.push({ geo: box(0.72, 0.1, 0.1, 0, 0.24, 0.4), color: DARK_WOOD });
  p.push({ geo: box(0.72, 0.1, 0.1, 0, 0.24, -0.4), color: DARK_WOOD });
  // uprights + crossbar
  p.push({ geo: box(0.08, 0.5, 0.08, -0.3, 0.5, 0.15), color: WOOD });
  p.push({ geo: box(0.08, 0.5, 0.08, 0.3, 0.5, 0.15), color: WOOD });
  p.push({ geo: box(0.72, 0.08, 0.08, 0, 0.75, 0.15), color: DARK_WOOD });
  // wheels
  for (const [x, z] of [[-0.42, 0.35], [0.42, 0.35], [-0.42, -0.35], [0.42, -0.35]]) {
    p.push({ geo: cyl(0.16, 0.16, 0.08, x, 0.16, z, 10, 0, Math.PI / 2), color: DARK_WOOD, part: 5 });
    p.push({ geo: cyl(0.05, 0.05, 0.1, x, 0.16, z, 6, 0, Math.PI / 2), color: DARK_STEEL, part: 5 });
  }
  // throwing arm (part 6) pivot at (0, 0.3, -0.2)
  p.push({ geo: box(0.08, 0.08, 1.05, 0, 0.3, 0.22), color: WOOD, part: 6 });
  p.push({ geo: box(0.2, 0.12, 0.2, 0, 0.36, 0.72), color: DARK_WOOD, part: 6 });
  p.push({ geo: sphere(0.09, 0, 0.42, 0.72, 6), color: 0x777777, part: 6 });
  // banner in team color
  p.push({ geo: box(0.03, 0.5, 0.03, 0.34, 0.9, -0.42), color: DARK_WOOD });
  p.push({ geo: box(0.02, 0.22, 0.26, 0.34, 1.05, -0.28), color: 0xffffff, team: true });
  const m = assemble(p, 0.3, 0.3);
  // The parts above put the bucket at +z, which is the unit's forward: the engine drove around boulder-first
  // and the arm swing threw backwards. Turn the whole thing around so the arm trails and the throw goes
  // forward; the vertex shader's part-6 pivot (0.3, +0.2) matches this orientation.
  m.geometry.rotateY(Math.PI);
  m.geometry.computeBoundingBox();
  return m;
}

function addBanner(m: ModelGeo, x: number, z: number): void {
  const pole = box(0.04, 1.1, 0.04, x, 0.55, z);
  const flag = box(0.02, 0.3, 0.32, x, 0.95, z + 0.17);
  const spec: PartSpec[] = [{ geo: pole, color: DARK_WOOD }, { geo: flag, color: 0xffffff, team: true }];
  const extra = assemble(spec, 0, 0).geometry;
  const merged = mergeGeometries([m.geometry, extra], false)!;
  merged.computeBoundingBox();
  m.geometry = merged;
  m.height = Math.max(m.height, merged.boundingBox!.max.y);
}
