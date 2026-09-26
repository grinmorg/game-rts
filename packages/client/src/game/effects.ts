import * as THREE from 'three';

/** scratch colour for emit() and Decals.add(), so neither allocates one per call */
const tmpColor = new THREE.Color();

interface Particle { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; maxLife: number; size: number; r: number; g: number; b: number; gravity: number }

/** CPU particle pool rendered as one Points draw call. */
export class Particles {
  readonly points: THREE.Points;
  private pool: Particle[] = [];
  private live: Particle[] = [];
  private pos: Float32Array;
  private col: Float32Array;
  private sz: Float32Array;
  private geo: THREE.BufferGeometry;
  readonly max: number;

  constructor(max = 2500) {
    this.max = max;
    this.pos = new Float32Array(max * 3); this.col = new Float32Array(max * 3); this.sz = new Float32Array(max);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.sz, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, vertexColors: true,
      uniforms: { scale: { value: 400 } },
      vertexShader: `
        attribute float size; varying vec3 vC;
        uniform float scale;
        void main(){ vC = color; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * scale / -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `
        varying vec3 vC;
        void main(){ vec2 d = gl_PointCoord - 0.5; float a = 1.0 - smoothstep(0.25, 0.5, length(d)); if (a < 0.02) discard; gl_FragColor = vec4(vC, a); }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.geo.setDrawRange(0, 0);
    for (let i = 0; i < max; i++) this.pool.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1, size: 1, r: 1, g: 1, b: 1, gravity: 0 });
  }

  setViewportHeight(h: number): void { (this.points.material as THREE.ShaderMaterial).uniforms.scale.value = h * 0.9; }

  emit(x: number, y: number, z: number, count: number, color: number, opts: { speed?: number; up?: number; life?: number; size?: number; gravity?: number; spread?: number } = {}): void {
    const c = tmpColor.setHex(color);
    const speed = opts.speed ?? 2, up = opts.up ?? 2, life = opts.life ?? 0.6, size = opts.size ?? 0.25, gravity = opts.gravity ?? 6, spread = opts.spread ?? 0.1;
    for (let i = 0; i < count; i++) {
      const p = this.pool.pop();
      if (!p) return;
      const a = Math.random() * Math.PI * 2, s = Math.random() * speed;
      p.x = x + (Math.random() - 0.5) * spread; p.y = y + Math.random() * spread; p.z = z + (Math.random() - 0.5) * spread;
      p.vx = Math.cos(a) * s; p.vz = Math.sin(a) * s; p.vy = up * (0.4 + Math.random() * 0.8);
      p.life = p.maxLife = life * (0.6 + Math.random() * 0.8);
      p.size = size * (0.7 + Math.random() * 0.6);
      const v = 0.8 + Math.random() * 0.4;
      p.r = Math.min(1, c.r * v); p.g = Math.min(1, c.g * v); p.b = Math.min(1, c.b * v);
      p.gravity = gravity;
      this.live.push(p);
    }
  }

  /** drop every live particle (a replay jumped to another moment) */
  clear(): void { for (const p of this.live) this.pool.push(p); this.live.length = 0; }

  update(dt: number): void {
    let n = 0;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.life -= dt;
      if (p.life <= 0) { this.live[i] = this.live[this.live.length - 1]; this.live.pop(); this.pool.push(p); continue; }
      p.vy -= p.gravity * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.y < 0.02) { p.y = 0.02; p.vy *= -0.2; p.vx *= 0.7; p.vz *= 0.7; }
      const k = p.life / p.maxLife;
      this.pos[n * 3] = p.x; this.pos[n * 3 + 1] = p.y; this.pos[n * 3 + 2] = p.z;
      this.col[n * 3] = p.r; this.col[n * 3 + 1] = p.g; this.col[n * 3 + 2] = p.b;
      this.sz[n] = p.size * (0.5 + 0.5 * k);
      n++;
    }
    this.geo.setDrawRange(0, n);
    // nothing alive: skip the draw and, with it, the upload of all three buffers
    this.points.visible = n > 0;
    if (n === 0) return;
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.size as THREE.BufferAttribute).needsUpdate = true;
  }
}

/** Blood / scorch decals projected on the ground; pool with oldest-first eviction. */
export class Decals {
  readonly mesh: THREE.InstancedMesh;
  private ages: Float32Array;
  private lifes: Float32Array;
  private alphaAttr: THREE.InstancedBufferAttribute;
  private next = 0;
  private dummy = new THREE.Object3D();
  readonly max: number;
  private heightAt: (x: number, z: number) => number;

  constructor(max: number, heightAt: (x: number, z: number) => number) {
    this.max = max;
    this.heightAt = heightAt;
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    // 2x2 atlas of splat shapes in a procedural texture
    const tex = makeSplatTexture();
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    mat.onBeforeCompile = (s) => {
      s.vertexShader = s.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aAlpha; attribute float aTile; varying float vA;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvA = aAlpha; vMapUv = vMapUv * 0.5 + vec2(mod(aTile, 2.0), floor(aTile / 2.0)) * 0.5;');
      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vA;')
        .replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor.a *= vA;');
    };
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.ages = new Float32Array(max); this.lifes = new Float32Array(max);
    this.alphaAttr = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    geo.setAttribute('aAlpha', this.alphaAttr);
    geo.setAttribute('aTile', new THREE.InstancedBufferAttribute(Float32Array.from({ length: max }, () => Math.floor(Math.random() * 4)), 1));
    for (let i = 0; i < max; i++) { this.dummy.position.set(0, -100, 0); this.dummy.updateMatrix(); this.mesh.setMatrixAt(i, this.dummy.matrix); this.mesh.setColorAt(i, new THREE.Color(0x000000)); }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  add(x: number, z: number, size: number, color: number, life = 20): void {
    const i = this.next; this.next = (this.next + 1) % this.max;
    this.dummy.position.set(x, this.heightAt(x, z) + 0.03, z);
    this.dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
    this.dummy.scale.set(size, 1, size);
    this.dummy.updateMatrix();
    this.mesh.setMatrixAt(i, this.dummy.matrix);
    this.mesh.setColorAt(i, tmpColor.setHex(color));
    this.ages[i] = 0; this.lifes[i] = life;
    this.alphaAttr.setX(i, 0.9);
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
  }

  /** let every decal expire on the next update (a replay jumped to another moment) */
  clear(): void { for (let i = 0; i < this.max; i++) if (this.lifes[i] > 0) this.ages[i] = this.lifes[i]; }

  update(dt: number): void {
    let dirty = false;
    for (let i = 0; i < this.max; i++) {
      if (this.lifes[i] <= 0) continue;
      this.ages[i] += dt;
      const left = this.lifes[i] - this.ages[i];
      if (left <= 4) {
        const a = Math.max(0, left / 4) * 0.9;
        this.alphaAttr.setX(i, a); dirty = true;
        if (left <= 0) { this.lifes[i] = 0; this.dummy.position.set(0, -100, 0); this.dummy.scale.set(1, 1, 1); this.dummy.updateMatrix(); this.mesh.setMatrixAt(i, this.dummy.matrix); this.mesh.instanceMatrix.needsUpdate = true; }
      }
    }
    if (dirty) this.alphaAttr.needsUpdate = true;
  }
}

function makeSplatTexture(): THREE.Texture {
  const size = 256;
  const c = document.createElement('canvas'); c.width = size; c.height = size;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, size, size);
  for (let t = 0; t < 4; t++) {
    const ox = (t % 2) * 128 + 64, oy = Math.floor(t / 2) * 128 + 64;
    g.fillStyle = 'rgba(255,255,255,1)';
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2, d = Math.random() * 34;
      const r = 8 + Math.random() * 22 * (1 - d / 40);
      g.beginPath(); g.ellipse(ox + Math.cos(a) * d, oy + Math.sin(a) * d, r, r * (0.6 + Math.random() * 0.4), a, 0, Math.PI * 2); g.fill();
    }
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2, d = 30 + Math.random() * 26;
      g.beginPath(); g.arc(ox + Math.cos(a) * d, oy + Math.sin(a) * d, 2 + Math.random() * 4, 0, Math.PI * 2); g.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}
