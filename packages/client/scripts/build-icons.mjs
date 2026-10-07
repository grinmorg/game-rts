#!/usr/bin/env node
// Builds the icon registry (src/ui/icons/icons.generated.ts) from a folder of SVG files.
//
//   node packages/client/scripts/build-icons.mjs [svgDir] [outFile] [--aliases=<file.json>]
//
// Defaults: src/ui/icons/svg, src/ui/icons/icons.generated.ts, src/ui/icons/aliases.json (all relative to the client
// package). Each <name>.svg becomes the icon `name`: the root <svg> is dropped (its viewBox is kept, width/height and
// the XML prolog go), the inner markup is kept with whitespace between tags squeezed and every decimal rounded to two
// places. Ids inside an icon (mask cut-outs) are rewritten to `__ID__<n>`; Icon.tsx replaces the token with a prefix
// unique to each rendered icon, so two copies on one page never share a mask. Aliases name an icon after what it
// means in the game and borrow another icon's drawing until they get their own file (see aliases.json).
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const pos = args.filter((a) => !a.startsWith('--'));
const svgDir = resolve(pos[0] ?? join(pkg, 'src/ui/icons/svg'));
const outFile = resolve(pos[1] ?? join(pkg, 'src/ui/icons/icons.generated.ts'));
const aliasFile = resolve(flag('aliases') ?? join(pkg, 'src/ui/icons/aliases.json'));

const ID_TOKEN = '__ID__';

/** 3.9600000000000004 -> 3.96, 0.50 -> .5, -0.004 -> 0; never glues two numbers of a path together */
function roundNumbers(value) {
  return value.replace(/-?\d*\.\d+/g, (m, offset, whole) => {
    let r = String(Math.round(Number(m) * 100) / 100);
    if (r === '-0') r = '0';
    r = r.replace(/^(-?)0\./, '$1.');
    // "0.999.5" must not become "1.5": a rounded integer followed by a bare fraction needs a separator
    if (!r.includes('.') && whole[offset + m.length] === '.') r += ' ';
    return r;
  });
}

function parseSvg(file) {
  const id = basename(file, '.svg');
  let src = readFileSync(file, 'utf8')
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  const open = src.match(/^<svg\b([^>]*)>/);
  if (!open || !src.endsWith('</svg>')) throw new Error(`${file}: not a single <svg> element`);
  const attrs = Object.fromEntries([...open[1].matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
  let viewBox = attrs.viewBox;
  if (!viewBox) {
    const w = parseFloat(attrs.width), h = parseFloat(attrs.height);
    if (!(w > 0 && h > 0)) throw new Error(`${file}: no viewBox and no width/height to make one from`);
    viewBox = `0 0 ${w} ${h}`;
  }
  viewBox = roundNumbers(viewBox).replace(/(^|\s)\./g, '$10.').trim();
  let body = src.slice(open[0].length, -'</svg>'.length).replace(/>\s+</g, '><').trim();
  if (/<style\b|<script\b|\sclass=/.test(body)) throw new Error(`${file}: <style>, <script> and class= are not allowed in an icon (they leak into the page)`);
  // attribute values: round the numbers; ids become per-icon tokens that Icon.tsx makes unique per instance
  const ids = [...body.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  body = body.replace(/(\s[\w:-]+)="([^"]*)"/g, (_, name, value) => {
    if (name.trim() === 'id') return `${name}="${ID_TOKEN}${ids.indexOf(value)}"`;
    let v = value;
    for (const [i, old] of ids.entries()) v = v.split(`url(#${old})`).join(`url(#${ID_TOKEN}${i})`).replace(new RegExp(`^#${old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), `#${ID_TOKEN}${i}`);
    return `${name}="${/href$/.test(name.trim()) ? v : roundNumbers(v)}"`;
  });
  return { id, viewBox, body };
}

const files = readdirSync(svgDir).filter((f) => f.endsWith('.svg')).sort();
if (!files.length) throw new Error(`no .svg files in ${svgDir}`);
const icons = files.map((f) => parseSvg(join(svgDir, f)));
const byId = new Map(icons.map((x) => [x.id, x]));
for (const x of icons) if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(x.id)) throw new Error(`icon id "${x.id}" must be kebab-case (rename the file)`);

const aliases = [];
const gaps = [];
if (existsSync(aliasFile)) {
  const raw = JSON.parse(readFileSync(aliasFile, 'utf8'));
  for (const [name, v] of Object.entries(raw)) {
    if (name.startsWith('_')) continue;
    const spec = typeof v === 'string' ? { from: v } : v;
    if (byId.has(name)) { console.warn(`alias "${name}" ignored: ${name}.svg exists (delete the alias)`); continue; }
    const target = byId.get(spec.from);
    if (!target) throw new Error(`alias "${name}" -> "${spec.from}": no such icon`);
    aliases.push({ name, ...spec });
    if (spec.gap) gaps.push(`${name} -> ${spec.from}${spec.flipX ? ' (mirrored)' : ''}: ${spec.gap}`);
  }
}

const varName = (id) => 'i_' + id.replace(/-/g, '_');
const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const lines = [];
const rel = (p) => relative(pkg, p).replace(/\\/g, '/');
lines.push(`// Generated by ${rel(fileURLToPath(import.meta.url))} from ${rel(svgDir)}/*.svg${existsSync(aliasFile) ? ` and ${rel(aliasFile)}` : ''} (paths in packages/client). Do not edit by hand.`);
lines.push(`// Inner SVG markup per icon; ids are written as ${ID_TOKEN}<n> and made unique per rendered icon by Icon.tsx.`);
lines.push('');
lines.push('export interface IconDef { readonly viewBox: string; readonly body: string }');
lines.push('');
for (const x of icons) lines.push(`const ${varName(x.id)}: IconDef = { viewBox: ${q(x.viewBox)}, body: ${q(x.body)} };`);
for (const a of aliases.filter((a) => a.flipX)) {
  const t = byId.get(a.from);
  const [minX, , w] = t.viewBox.split(/\s+/).map(Number);
  lines.push(`const ${varName(a.name)}: IconDef = { viewBox: ${q(t.viewBox)}, body: ${q(`<g transform="matrix(-1 0 0 1 ${2 * minX + w} 0)">${t.body}</g>`)} };`);
}
lines.push('');
lines.push('export const ICONS = {');
for (const x of icons) lines.push(`  ${q(x.id)}: ${varName(x.id)},`);
lines.push('  // aliases: a game meaning drawn with another icon until it has its own');
for (const a of aliases) lines.push(`  ${q(a.name)}: ${a.flipX ? varName(a.name) : varName(a.from)},${a.gap ? ` // gap: ${a.gap}` : ''}`);
lines.push('} as const;');
lines.push('');
lines.push('/** alias -> the icon it borrows (mirrored ones are marked) */');
lines.push('export const ICON_ALIASES: Readonly<Record<string, string>> = {');
for (const a of aliases) lines.push(`  ${q(a.name)}: ${q(a.from + (a.flipX ? ' (mirrored)' : ''))},`);
lines.push('};');
writeFileSync(outFile, lines.join('\n') + '\n');
console.log(`${relative(process.cwd(), outFile)}: ${icons.length} icons, ${aliases.length} aliases (${gaps.length} stand-ins for missing icons)`);
for (const g of gaps) console.log(`  gap  ${g}`);
