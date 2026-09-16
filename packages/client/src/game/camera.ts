import * as THREE from 'three';

const ZOOM_STEPS = [25, 34, 45, 58, 72, 90];

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
  zoomIndex = 2;
  private minX = 0; private maxX = 64; private minZ = 0; private maxZ = 64;
  private smoothDist: number;
  private ray = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private tmp = new THREE.Vector3();

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(42, aspect, 1, 400);
    this.smoothDist = ZOOM_STEPS[this.zoomIndex];
    this.apply();
  }

  setBounds(w: number, h: number): void {
    this.minX = 2; this.maxX = w - 2; this.minZ = 2; this.maxZ = h - 2;
  }

  get distance(): number { return ZOOM_STEPS[this.zoomIndex]; }

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
  zoom(dir: number): void { this.zoomIndex = Math.min(ZOOM_STEPS.length - 1, Math.max(0, this.zoomIndex + dir)); }
  reset(): void { this.yaw = 0; this.tilt = 55; this.zoomIndex = 2; }

  update(dt: number): void {
    const d = ZOOM_STEPS[this.zoomIndex];
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
    this.ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
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
