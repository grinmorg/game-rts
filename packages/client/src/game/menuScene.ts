import * as THREE from 'three';
import { loadMenuProps } from './models';

/**
 * The menu backdrop: trees, rocks and catapults tumbling down the screen at their own pace, drawn with the
 * same lighting as the match so the menus feel like the same world. It is deliberately cheap - a couple of
 * dozen plain meshes, no shadows, no fog - because it runs behind every menu screen.
 */
const PROP_COUNT = 24;
const FOV = 40;
const CAM_DIST = 12;
/** props live between these camera-space depths; the far ones are smaller, dimmer and slower */
const Z_NEAR = 2.5, Z_FAR = -7;

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** the props are shared by every menu screen, so they are loaded once and kept for the session */
let propsPromise: Promise<THREE.BufferGeometry[]> | null = null;
function menuProps(): Promise<THREE.BufferGeometry[]> {
  return (propsPromise ??= loadMenuProps());
}

interface Faller {
  mesh: THREE.Mesh;
  mat: THREE.MeshLambertMaterial;
  /** cells per second downwards */
  fall: number;
  spin: THREE.Vector3;
  /** horizontal drift, so the fall does not read as rain */
  swayAmp: number;
  swayFreq: number;
  phase: number;
}

/** Start the animated background on `canvas`. Returns the teardown. */
export function startMenuScene(canvas: HTMLCanvasElement): () => void {
  let gl: THREE.WebGLRenderer;
  try {
    gl = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
  } catch {
    return () => {}; // no WebGL: the page gradient alone is the background
  }
  gl.outputColorSpace = THREE.SRGBColorSpace;
  gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
  camera.position.set(0, 0, CAM_DIST);
  scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x6b7a4a, 0.9));
  const sun = new THREE.DirectionalLight(0xfff1d6, 1.5);
  sun.position.set(-5, 8, 6);
  scene.add(sun);

  const fallers: Faller[] = [];
  let geos: THREE.BufferGeometry[] = [];
  let alive = true;
  let raf = 0;
  let last = performance.now();

  /** half of what the camera sees at depth `z`, in world units */
  const halfHeightAt = (z: number) => Math.tan((FOV / 2) * (Math.PI / 180)) * (CAM_DIST - z);

  /** Send a prop back above the top edge with a fresh shape, size, speed and spin. */
  const respawn = (f: Faller, first: boolean) => {
    const z = rand(Z_FAR, Z_NEAR);
    const depth = (z - Z_FAR) / (Z_NEAR - Z_FAR); // 0 far .. 1 near
    const halfH = halfHeightAt(z);
    const halfW = halfH * camera.aspect;
    const s = rand(0.9, 1.7) * (0.75 + depth * 0.7);
    f.mesh.geometry = geos[(Math.random() * geos.length) | 0];
    f.mesh.scale.setScalar(s);
    f.mesh.position.set(rand(-halfW, halfW), first ? rand(-halfH, halfH) : halfH + s, z);
    f.mesh.rotation.set(rand(0, Math.PI * 2), rand(0, Math.PI * 2), rand(0, Math.PI * 2));
    f.mat.opacity = 0.35 + depth * 0.5;
    f.fall = rand(0.5, 1.5) * (0.6 + depth * 0.8);
    f.spin.set(rand(-0.9, 0.9), rand(-1.4, 1.4), rand(-0.9, 0.9));
    f.swayAmp = rand(0.05, 0.3);
    f.swayFreq = rand(0.2, 0.7);
    f.phase = rand(0, Math.PI * 2);
  };

  const resize = () => {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    gl.setSize(w, h, false);
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = now / 1000;
    for (const f of fallers) {
      const p = f.mesh.position;
      p.y -= f.fall * dt;
      p.x += Math.cos(t * f.swayFreq + f.phase) * f.swayAmp * dt;
      f.mesh.rotation.x += f.spin.x * dt;
      f.mesh.rotation.y += f.spin.y * dt;
      f.mesh.rotation.z += f.spin.z * dt;
      // one prop height of slack so nothing pops out mid-screen
      if (p.y < -halfHeightAt(p.z) - f.mesh.scale.x) respawn(f, false);
    }
    gl.render(scene, camera);
  };

  menuProps().then((loaded) => {
    if (!alive) return;
    geos = loaded;
    for (let i = 0; i < PROP_COUNT; i++) {
      const mat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true });
      const f: Faller = { mesh: new THREE.Mesh(geos[0], mat), mat, fall: 1, spin: new THREE.Vector3(), swayAmp: 0, swayFreq: 0, phase: 0 };
      respawn(f, true);
      scene.add(f.mesh);
      fallers.push(f);
    }
  }).catch(() => {});

  raf = requestAnimationFrame(frame);

  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    ro.disconnect();
    for (const f of fallers) { scene.remove(f.mesh); f.mat.dispose(); }
    gl.dispose(); // the geometries are shared with the next screen, so they stay
  };
}
