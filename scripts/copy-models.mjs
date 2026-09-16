#!/usr/bin/env node
// Copies the glTF models the client actually loads from the asset pack into packages/client/public/models.
// The pack lives in the repo but is far too large to serve as-is, so public/models is a gitignored subset.
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'models/Ultimate Fantasy RTS - Aug 2022/glTF');
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
  'Mine',
  // resources & decor
  'Resource_Gold_1', 'Resource_Gold_2', 'Resource_Gold_3', 'Resource_Tree1', 'Resource_Tree2', 'Resource_PineTree',
  'Rock', 'Resource_Rock_1',
];

const exists = (p) => stat(p).then(() => true, () => false);

if (!(await exists(src))) {
  console.error(`asset pack not found: ${src}`);
  process.exit(1);
}
await mkdir(dst, { recursive: true });

let copied = 0;
for (const name of FILES) {
  const from = join(src, `${name}.gltf`);
  if (!(await exists(from))) { console.error(`missing in pack: ${name}.gltf`); process.exit(1); }
  await copyFile(from, join(dst, `${name}.gltf`));
  copied++;
}

const stale = (await readdir(dst)).filter((f) => f.endsWith('.gltf') && !FILES.includes(f.replace(/\.gltf$/, '')));
console.log(`copied ${copied} models -> packages/client/public/models`);
if (stale.length) console.log(`unused files still there: ${stale.join(', ')}`);
