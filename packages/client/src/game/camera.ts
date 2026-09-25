import * as THREE from 'three';

/**
 * Viewing distances the wheel steps through. The first CLOSE_STEPS are for fingers only (see `closeZoom`):
 * on a phone the whole map is a few hundred pixels tall, and at the desktop's closest distance a footman
 * is under twenty pixels wide - a fingertip needs roughly twice that to land on the unit it meant.
 */
const ZOOM_STEPS = [10, 14, 19, 25, 34, 45, 58, 72, 90];
const CLOSE_STEPS = 3;
const DEFAULT_LEVEL = 5; // 45

function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }
/** viewing distance at a fractional zoom step */
function distAt(level: number): number {
  const l = clamp(level, 0, ZOOM_STEPS.length - 1);
  const i = Math.min(ZOOM_STEPS.length - 2, Math.floor(l));
  return ZOOM_STEPS[i] + (ZOOM_STEPS[i + 1] - ZOOM_STEPS[i]) * (l - i);
}
/** the inverse of distAt */
function levelAt(dist: number): number {
  for (let i = 0; i < ZOOM_STEPS.length - 1; i++) {
    if (dist <= ZOOM_STEPS[i + 1]) return i + (dist - ZOOM_STEPS[i]) / (ZOOM_STEPS[i + 1] - ZOOM_STEPS[i]);
  }
  return ZOOM_STEPS.length - 1;
}

/**
 * Fixed-tilt RTS camera. Sim x -> world X, sim y -> world Z.
 * At yaw = 0 the camera sits at +Z of its target and looks towards -Z, so screen-up is -Z
 * (map y decreasing = up on the minimap) and screen-right is +X (map x increasing).
 */
export class CameraController {
  readonly camera: THREE.PerspectiveCamera;
  target = new THREE.Vector3(32, 0, 32);
  yaw = 0; // radians
  tilt = 55; // degrees from horizontal
  /**
   * Zoom as a *fractional* position in ZOOM_STEPS. The wheel walks whole steps, a pinch slides between
   * them, so two fingers track the map instead of snapping through nine fixed distances.
   */
  zoomLevel = DEFAULT_LEVEL;
  /** opens the close-up steps below the desktop minimum; the input controller sets it with the touch HUD */
  closeZoom = false;
  private minX = 0; private maxX = 64; private minZ = 0; private maxZ = 64;
  private smoothDist: number;
  private ray = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private tmp = new THREE.Vector3();
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private ndc = new THREE.Vector2();

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(42, aspect, 1, 400);
    this.smoothDist = distAt(this.zoomLevel);
    this.apply();
  }

  setBounds(w: number, h: number): void {
    this.minX = 2; this.maxX = w - 2; this.minZ = 2; this.maxZ = h - 2;
  }

  get distance(): number { return distAt(this.zoomLevel); }
  get zoomIndex(): number { return Math.round(this.zoomLevel); }
  private get minLevel(): number { return this.closeZoom ? 0 : CLOSE_STEPS; }

  lookAt(x: number, z: number): void {
    this.target.set(x, 0, z);
    this.clamp();
    this.apply();
  }

  /** pan in screen-aligned world units: dx = screen right, dz = screen up (away from the camera) */
  pan(dx: number, dz: number): void {
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    // forward (screen up) = (-s, 0, -c), right = (c, 0, -s)
    this.target.x += dx * c - dz * s;
    this.target.z += -dx * s - dz * c;
    this.clamp();
  }

  rotate(deltaRad: number): void { this.yaw += deltaRad; }
  tiltBy(deltaDeg: number): void { this.tilt = Math.min(65, Math.max(45, this.tilt + deltaDeg)); }
  zoom(dir: number): void { this.zoomLevel = clamp(Math.round(this.zoomLevel) + dir, this.minLevel, ZOOM_STEPS.length - 1); }
  /** pinch zoom: `scale` > 1 pulls the camera back. Skips the easing so the map stays under the fingers. */
  zoomBy(scale: number): void {
    this.zoomLevel = levelAt(clamp(distAt(this.zoomLevel) * scale, ZOOM_STEPS[this.minLevel], ZOOM_STEPS[ZOOM_STEPS.length - 1]));
    this.smoothDist = distAt(this.zoomLevel);
    this.apply();
  }
  /**
   * Pinch zoom about a screen point (ndc): the ground between the fingers stays between the fingers, so a
   * player zooms straight onto the unit they are about to tap instead of chasing it across the screen.
   */
  zoomAt(scale: number, ndcX: number, ndcY: number): void {
    const before = this.groundPoint(ndcX, ndcY, this.tmpA);
    this.zoomBy(scale);
    if (!before) return;
    const after = this.groundPoint(ndcX, ndcY, this.tmpB);
    if (!after) return;
    this.target.x += before.x - after.x;
    this.target.z += before.z - after.z;
    this.clamp();
    this.apply();
  }
  reset(): void { this.yaw = 0; this.tilt = 55; this.zoomLevel = DEFAULT_LEVEL; }

  update(dt: number): void {
    const d = distAt(this.zoomLevel);
    this.smoothDist += (d - this.smoothDist) * Math.min(1, dt * 12);
    this.apply();
  }

  private clamp(): void {
    this.target.x = Math.min(this.maxX, Math.max(this.minX, this.target.x));
    this.target.z = Math.min(this.maxZ, Math.max(this.minZ, this.target.z));
  }

  private apply(): void {
    const dist = this.smoothDist;
    const t = THREE.MathUtils.degToRad(this.tilt);
    const horiz = Math.cos(t) * dist, up = Math.sin(t) * dist;
    const px = this.target.x + Math.sin(this.yaw) * horiz;
    const pz = this.target.z + Math.cos(this.yaw) * horiz;
    this.camera.position.set(px, this.target.y + up, pz);
    this.camera.lookAt(this.target.x, this.target.y, this.target.z);
    this.camera.updateMatrixWorld();
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** ndc (-1..1) -> ground point (y=0 plane); returns null if looking at the sky */
  groundPoint(ndcX: number, ndcY: number, out: THREE.Vector3 = this.tmp): THREE.Vector3 | null {
    this.ray.setFromCamera(this.ndc.set(ndcX, ndcY), this.camera);
    const hit = this.ray.ray.intersectPlane(this.plane, out);
    return hit;
  }

  /** world -> ndc */
  project(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    out.set(x, y, z).project(this.camera);
    return out;
  }

  /** approximate world units per pixel at the target depth */
  unitsPerPixel(viewportHeight: number): number {
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    return (2 * Math.tan(fov / 2) * this.smoothDist) / viewportHeight;
  }
}
