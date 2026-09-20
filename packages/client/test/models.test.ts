/**
 * The asset pipeline must not change what the renderer draws.
 *
 * `pnpm assets` rewrites every model: it strips UV channels, welds vertices, quantises positions to 14 bits
 * and normals to 8, then meshopt-compresses the result (see scripts/copy-models.mjs). All of that is
 * invisible in the game only as long as the geometry comes out where it went in, so this loads each built
 * `.glb` next to the source it was built from and compares them.
 *
 * Three things have gone wrong here before and are each worth a check of their own:
 *   - `prune` drops childless empty nodes, which is exactly what the unit pivots `Hip` and `Shoulder` are;
 *   - quantised attributes arrive as *normalized integers*, and a matrix applied to one of those clamps
 *     every vertex (see `deQuantize` in game/models.ts);
 *   - a stale `public/models` silently serves yesterday's build.
 *
 * The test is skipped when the pack or the build is missing, so a fresh clone without `pnpm assets` is not
 * a failure.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const BUILT = join(root, 'packages/client/public/models');
const PACK = join(root, 'models/Ultimate Fantasy RTS - Aug 2022/glTF');
const CUSTOM = join(root, 'models/custom');

interface Shape {
  tris: number;
  min: [number, number, number];
  max: [number, number, number];
  materials: string[];
  /** world y of the pivot empties the unit animation turns limbs around */
  joints: Record<string, number>;
}

// three reports load progress with a DOM event type Node does not have; nothing here listens to it
(globalThis as { ProgressEvent?: unknown }).ProgressEvent ??= class { constructor(public type: string) {} };

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

/** Load a model the way the client does - flattened to world space - and describe what came out. */
async function shapeOf(file: string): Promise<Shape> {
  const buf = readFileSync(file);
  const gltf = await loader.parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, `${dirname(file)}/`);
  gltf.scene.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const materials = new Set<string>();
  let tris = 0;
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    // the same widening the client does before any matrix touches a quantised attribute
    const geo = mesh.geometry.clone();
    const pos = geo.attributes.position;
    const out = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) { out[i * 3] = pos.getX(i); out[i * 3 + 1] = pos.getY(i); out[i * 3 + 2] = pos.getZ(i); }
    geo.setAttribute('position', new THREE.BufferAttribute(out, 3));
    geo.applyMatrix4(mesh.matrixWorld);
    geo.computeBoundingBox();
    box.union(geo.boundingBox!);
    tris += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (m?.name) materials.add(m.name);
  });
  const joints: Record<string, number> = {};
  for (const name of ['Hip', 'Shoulder']) {
    const n = gltf.scene.getObjectByName(name);
    if (n) joints[name] = n.getWorldPosition(new THREE.Vector3()).y;
  }
  return { tris, min: box.min.toArray(), max: box.max.toArray(), materials: [...materials].sort(), joints };
}

/** Every built model, paired with the source it came from. */
function pairs(): { name: string; built: string; source: string }[] {
  if (!existsSync(BUILT)) return [];
  return readdirSync(BUILT)
    .filter((f) => f.endsWith('.glb'))
    .map((f) => {
      const name = f.replace(/\.glb$/, '');
      const packed = join(PACK, `${name}.gltf`);
      const own = join(CUSTOM, `${name}.glb`);
      return { name, built: join(BUILT, f), source: existsSync(own) ? own : packed };
    })
    .filter((p) => existsSync(p.source));
}

const cases = pairs();
const ready = cases.length > 0;

describe.skipIf(!ready)('built models match their sources', () => {
  it('has a build for every source in the list', () => {
    // 45 from the pack (incl. two gatehouses per age) plus 14 unit models; fewer means `pnpm assets` half-ran or the list changed
    expect(cases.length).toBe(59);
  });

  it.each(cases)('$name keeps its shape, materials and pivots', async ({ built, source }) => {
    const [a, b] = await Promise.all([shapeOf(source), shapeOf(built)]);
    // welding removes duplicated vertices but never a triangle
    expect(b.tris).toBe(a.tris);
    // 14-bit positions over the model's own bounding box: the error is a ten-thousandth of its size
    const size = Math.max(...a.max.map((v, i) => v - a.min[i]));
    const tol = Math.max(size / 4000, 1e-4);
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(b.min[i] - a.min[i])).toBeLessThan(tol);
      expect(Math.abs(b.max[i] - a.max[i])).toBeLessThan(tol);
    }
    // material names carry the team colour and the animation part id, so losing one is a visible bug
    expect(b.materials).toEqual(a.materials);
    // `prune` would take these away as useless leaves; the walk animation needs them
    expect(Object.keys(b.joints).sort()).toEqual(Object.keys(a.joints).sort());
    for (const [k, v] of Object.entries(a.joints)) expect(Math.abs(b.joints[k] - v)).toBeLessThan(tol);
  });
});
