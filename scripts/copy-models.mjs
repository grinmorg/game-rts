#!/usr/bin/env node
// Builds the models the client loads, from the asset pack and from models/custom, into
// packages/client/public/models. The pack lives in the repo but is far too large to serve as-is, so
// public/models is a gitignored, rebuilt-on-demand subset.
//
// Nothing is copied verbatim any more: every model goes through the pipeline below, which is what keeps a
// match start off a phone's patience. The three things it exploits are all facts about *this* renderer:
//
//   - nothing is textured. The client bakes each material's colour into a vertex attribute and deletes
//     every other attribute after loading, so UV channels are dead weight - about a fifth of each file.
//   - glTF from Blender embeds its buffer as base64, which costs a third of the file for nothing. Binary
//     glTF (.glb) carries the same bytes raw.
//   - the geometry is boxy and low-poly, which is exactly what quantisation and meshopt are good at.
//
// Two things must survive all of it, and both are material and node *names*, which a mesh pipeline normally
// treats as decoration:
//   - the empty nodes `Hip` and `Shoulder` on the unit models are the pivots the vertex animation turns
//     limbs around. Being childless, `prune` would drop them as useless leaves - hence `keepLeaves`.
//   - a material's name is how a model says which part of it moves and which part takes the player's colour
//     (see PART_PREFIX and TEAM_MATERIALS in game/models.ts). `LegA_Dark` and `LegB_Dark` are the same
//     shade of brown, so `dedup` merges them into one and a walking unit loses a leg - hence no MATERIAL.
// packages/client/test/models.test.ts compares every build against its source and fails on either.
import { readdir, readFile, stat, unlink, writeFile, mkdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO, PropertyType } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, prune, quantize, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'models/Ultimate Fantasy RTS - Aug 2022/glTF');
const custom = join(root, 'models/custom');
const dst = join(root, 'packages/client/public/models');

// keep in sync with BUILDING_FILES / DECOR_FILES in packages/client/src/game/models.ts
const FILES = [
  // buildings: three construction stages each (Level1 -> Level2 -> Level3)
  'Wonder_FirstAge_Level1', 'Wonder_FirstAge_Level2', 'Wonder_FirstAge_Level3',
  'Houses_FirstAge_1_Level1', 'Houses_FirstAge_1_Level2', 'Houses_FirstAge_1_Level3',
  'Barracks_FirstAge_Level1', 'Barracks_FirstAge_Level2', 'Barracks_FirstAge_Level3',
  'Storage_FirstAge_Level1', 'Storage_FirstAge_Level2', 'Storage_FirstAge_Leve3',
  'WatchTower_FirstAge_Level1', 'WatchTower_FirstAge_Level2', 'WatchTower_FirstAge_Level3',
  'Wall_FirstAge',
  // gatehouse for a fence line (see GATE_LENGTH): the door swings open for the owner's troops
  'WallTowers_Door_FirstAge', 'WallTowers_DoorClosed_FirstAge',
  // second age: the same buildings in stone
  'Wonder_SecondAge_Level1', 'Wonder_SecondAge_Level2', 'Wonder_SecondAge_Level3',
  'Houses_SecondAge_1_Level1', 'Houses_SecondAge_1_Level2', 'Houses_SecondAge_1_Level3',
  'Barracks_SecondAge_Level1', 'Barracks_SecondAge_Level2', 'Barracks_SecondAge_Level3',
  'Storage_SecondAge_Level1', 'Storage_SecondAge_Level2', 'Storage_SecondAge_Level3',
  'WatchTower_SecondAge_Level1', 'WatchTower_SecondAge_Level2', 'WatchTower_SecondAge_Level3',
  'Wall_SecondAge',
  'WallTowers_Door_SecondAge', 'WallTowers_DoorClosed_SecondAge',
  'Mine',
  // resources & decor
  'Resource_Gold_1', 'Resource_Gold_2', 'Resource_Gold_3', 'Resource_Tree1', 'Resource_Tree2', 'Resource_PineTree',
  'Rock', 'Resource_Rock_1',
];

// our own models (scripts/blender/*.py), which live in the repo rather than in the pack: one per age
const CUSTOM = ['Worker', 'Soldier', 'Archer', 'Catapult', 'Militia', 'Cavalry', 'Ram']
  .flatMap((name) => [`${name}_FirstAge`, `${name}_SecondAge`]);

const exists = (p) => stat(p).then(() => true, () => false);
const gz = (buf) => gzipSync(buf, { level: 9 }).length;
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

/**
 * Strip, weld and quantise, then write the file twice: once plain and once meshopt-compressed. Meshopt wins
 * on anything with real geometry but loses its own header's worth on the smallest models, so whichever comes
 * out smaller *after gzip* is the one that ships - nginx gzips both types on the way out.
 */
async function build(from, name) {
  const base = async () => {
    const doc = await io.read(from);
    await doc.transform(
      // everything but MATERIAL: identical colours under different names are different parts of a unit
      dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.MESH, PropertyType.TEXTURE, PropertyType.SKIN] }),
      // keepLeaves: `Hip` and `Shoulder` are childless empties the unit animation pivots around
      prune({ keepAttributes: false, keepIndices: false, keepLeaves: true }),
      weld(),
      quantize({ quantizePosition: 14, quantizeNormal: 8 }),
    );
    return doc;
  };
  const plain = Buffer.from(await io.writeBinary(await base()));
  const packed = await base();
  packed.createExtension(EXTMeshoptCompression).setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  const meshopt = Buffer.from(await io.writeBinary(packed));
  const out = gz(meshopt) <= gz(plain) ? meshopt : plain;
  await writeFile(join(dst, `${name}.glb`), out);
  return { out: out.length, gz: gz(out), meshopt: out === meshopt };
}

if (!(await exists(src))) {
  console.error(`asset pack not found: ${src}`);
  process.exit(1);
}
await mkdir(dst, { recursive: true });

const jobs = [
  ...FILES.map((name) => ({ name, from: join(src, `${name}.gltf`), what: `${name}.gltf` })),
  ...CUSTOM.map((name) => ({ name, from: join(custom, `${name}.glb`), what: `${name}.glb` })),
];

let rawTotal = 0, outTotal = 0, gzTotal = 0, packedCount = 0;
for (const job of jobs) {
  if (!(await exists(job.from))) { console.error(`missing source: ${job.from}`); process.exit(1); }
  rawTotal += (await readFile(job.from)).length;
  const r = await build(job.from, job.name);
  outTotal += r.out; gzTotal += r.gz;
  if (r.meshopt) packedCount++;
}

// public/models is generated, so anything left over is from an older list or an older extension
const keep = new Set(jobs.map((j) => `${j.name}.glb`));
let removed = 0;
for (const f of await readdir(dst)) {
  if (/\.(gltf|glb|bin)$/.test(f) && !keep.has(f)) { await unlink(join(dst, f)); removed++; }
}

console.log(`built ${jobs.length} models -> packages/client/public/models (${packedCount} meshopt-compressed)`);
console.log(`  sources ${kb(rawTotal)} -> ${kb(outTotal)} on disk, ${kb(gzTotal)} over the wire (gzip)`);
if (removed) console.log(`  removed ${removed} stale file(s)`);
