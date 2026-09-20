import * as THREE from 'three';
import { AGE_COUNT, UNIT_TYPE_COUNT } from '@rookfall/sim';
import { Models } from './models';

/**
 * Unit thumbnails for the HUD: the very model the unit is drawn with on the map, rendered once into a small
 * picture. They are what tells a training button from an upgrade button at a glance - a soldier looks like a
 * soldier, while abilities and upgrades stay the flat symbols they have always been.
 *
 * Every thumbnail is rendered off-screen with the match's own lighting and the owner's colour baked into the
 * vertex colours, so a plain material draws it: the instanced shader of the map is not available here. A
 * colour's whole set is rendered in one go and kept for the session - the models never change - and the
 * off-screen context is thrown away as soon as the batch is done, so nothing but the match holds a GPU
 * context while it runs.
 */

/** the longer side of a thumbnail; the largest frame one is shown in is 84px, so this survives a retina screen */
const SIZE = 128;
/** the unit is turned off its facing and looked at from a little above - the three-quarter view of the map */
const TURN = -0.55;
const PITCH = 0.40;
/** breathing room around the model inside the picture */
const MARGIN = 1.08;
/** animation part of the load a worker carries home; see PART_PREFIX in models.ts */
const LOAD_PART = 8;

/** team colour -> [age][unit type] -> data URL */
const cache = new Map<number, (string | undefined)[][]>();

/**
 * The thumbnail of one unit: a plain lookup, safe to call from the HUD every frame. It is `undefined` until
 * `warmUnitArt` has rendered that colour, and stays `undefined` where there is no WebGL to render it with -
 * either way the caller falls back to the symbol, and nothing on the frame path ever renders anything.
 */
export function unitArt(teamColor: number, age: number, type: number): string | undefined {
  return cache.get(teamColor)?.[age]?.[type];
}

/**
 * Render the thumbnails of the given colours, in one batch and once per session. A match warms every player's
 * colour while it is still starting up, so nothing is rendered mid-fight - not even the first time an enemy
 * unit is selected.
 */
export function warmUnitArt(models: Models, teamColors: number[]): void {
  const missing = [...new Set(teamColors)].filter((c) => !cache.has(c));
  if (!missing.length) return;
  const sets = renderSet(models, missing);
  for (const c of missing) cache.set(c, sets.get(c) ?? []);
}

function renderSet(models: Models, teamColors: number[]): Map<number, (string | undefined)[][]> {
  const out = new Map<number, (string | undefined)[][]>();
  for (const c of teamColors) out.set(c, Array.from({ length: AGE_COUNT }, () => [] as (string | undefined)[]));
  let gl: THREE.WebGLRenderer;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  try {
    // the picture is read back with toDataURL, so the drawing buffer has to survive the render
    gl = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true, powerPreference: 'low-power' });
  } catch {
    return out; // no WebGL to spare: the HUD keeps its symbols
  }
  try {
    gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.setPixelRatio(1);
    gl.setSize(SIZE, SIZE, false);

    // the colours of the match, lit harder than the map is: a thumbnail sits on a dark tile with no sunlit
    // grass around it, so the same lighting would leave every wooden unit a brown smudge. The second lamp
    // fills the shadow side, which is what keeps a 30px picture readable at all.
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xdceaff, 0x8a7a55, 1.15));
    const sun = new THREE.DirectionalLight(0xfff1d6, 1.9);
    sun.position.set(-4, 7, 6);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.6);
    fill.position.set(5, 2, -4);
    scene.add(fill);

    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    cam.position.set(0, Math.sin(PITCH), Math.cos(PITCH)).multiplyScalar(10);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    for (let age = 0; age < AGE_COUNT; age++) {
      for (let type = 0; type < UNIT_TYPE_COUNT; type++) {
        const src = models.units[age]?.[type];
        if (!src) continue;
        for (const color of teamColors) {
          const geo = src.geometry.clone();
          prepare(geo, color);
          const mesh = new THREE.Mesh(geo, mat);
          mesh.rotation.y = TURN;
          mesh.updateMatrixWorld(true);
          const size = frame(cam, mesh);
          scene.add(mesh);
          gl.setSize(size.w, size.h, false);
          gl.render(scene, cam);
          out.get(color)![age][type] = canvas.toDataURL('image/png');
          scene.remove(mesh);
          geo.dispose();
        }
      }
    }
    mat.dispose();
  } catch {
    // a context lost halfway through: keep whatever was rendered, fall back to symbols for the rest
  } finally {
    gl.dispose();
    gl.forceContextLoss();
  }
  return out;
}

/**
 * What the map's shader does to a standing unit, done once on the geometry instead: the owner's colour goes
 * where the model carries the team mask, and the load a worker only has in his hands on the way home (part 8)
 * is collapsed into the origin, so the portrait shows him with his tool rather than holding both at once.
 */
function prepare(geo: THREE.BufferGeometry, teamColor: number): void {
  const mask = geo.getAttribute('teamMask');
  const color = geo.getAttribute('color');
  if (mask && color) {
    const c = new THREE.Color(teamColor);
    for (let i = 0; i < mask.count; i++) if (mask.getX(i) > 0.5) color.setXYZ(i, c.r, c.g, c.b);
  }
  const part = geo.getAttribute('part');
  const pos = geo.getAttribute('position');
  // the origin is the ground under the unit's feet, so collapsing there changes nothing the frame is fitted to
  if (part && pos) for (let i = 0; i < part.count; i++) if (Math.round(part.getX(i)) === LOAD_PART) pos.setXYZ(i, 0, 0, 0);
}

/**
 * Fit the picture to the model: the vertices are projected into camera space and both the frustum and the
 * picture itself are cut to what they cover, so a thumbnail carries no empty margin. That is what lets the
 * short, wide tiles of the command panel show a battering ram at their full width while an archer, in the
 * same tile, is drawn at its full height. Returns the pixel size the frame should be rendered at.
 */
function frame(cam: THREE.OrthographicCamera, mesh: THREE.Mesh): { w: number; h: number } {
  const pos = mesh.geometry.getAttribute('position');
  const v = new THREE.Vector3();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).applyMatrix4(cam.matrixWorldInverse);
    if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
    if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
  }
  if (!Number.isFinite(minX)) return { w: SIZE, h: SIZE };
  const spanX = Math.max(maxX - minX, 0.001) * MARGIN, spanY = Math.max(maxY - minY, 0.001) * MARGIN;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  cam.left = cx - spanX / 2; cam.right = cx + spanX / 2;
  cam.top = cy + spanY / 2; cam.bottom = cy - spanY / 2;
  // the camera looks down -z, so the far side of the model is the most negative
  cam.near = Math.max(0.01, -maxZ - 1); cam.far = -minZ + 1;
  cam.updateProjectionMatrix();
  const longest = Math.max(spanX, spanY);
  return { w: Math.max(8, Math.round((SIZE * spanX) / longest)), h: Math.max(8, Math.round((SIZE * spanY) / longest)) };
}
