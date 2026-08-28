import * as THREE from 'three';
import { clamp01 } from '../engine/math';

const SMOKE_VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uSizeScale;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  // aSize is a diameter in metres; uSizeScale converts it to pixels at 1m so a
  // puff is the same physical size whatever the screen or resolution scale.
  gl_PointSize = clamp(aSize * uSizeScale / max(-mv.z, 0.001), 1.0, 420.0);
}
`;

const SMOKE_FRAG = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main() {
  if (vAlpha <= 0.001) discard;
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = dot(d, d);
  if (r > 0.25) discard;
  // Soft edge, no texture fetch needed.
  float falloff = 1.0 - smoothstep(0.02, 0.25, r);
  gl_FragColor = vec4(vColor, vAlpha * falloff);
}
`;

/**
 * Pooled point-sprite puffs used for tyre smoke and off-road dust.
 * The pool is preallocated and recycled head-first, so spawning never allocates.
 */
export class SmokeSystem {
  readonly points: THREE.Points;
  private capacity: number;
  private positions: Float32Array;
  private sizes: Float32Array;
  private alphas: Float32Array;
  private colors: Float32Array;
  private velocities: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private baseAlpha: Float32Array;
  private head = 0;
  private geometry: THREE.BufferGeometry;
  private material: THREE.ShaderMaterial;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 3);
    this.velocities = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.alphas = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.baseAlpha = new Float32Array(capacity);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3));
    // The puffs live all over the map; culling them as one blob would pop.
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      uniforms: { uSizeScale: { value: 300 } },
      vertexShader: SMOKE_VERT,
      fragmentShader: SMOKE_FRAG,
      transparent: true,
      depthWrite: false,
      fog: false,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  /** Recomputed on resize: pixels per metre of puff diameter at one metre out. */
  setProjection(drawingBufferHeight: number, fovDegrees: number): void {
    const halfFov = (fovDegrees * Math.PI) / 360;
    this.material.uniforms.uSizeScale.value =
      drawingBufferHeight / (2 * Math.tan(halfFov));
  }

  spawn(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    size: number, life: number,
    r: number, g: number, b: number,
    alpha: number,
  ): void {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    const o = i * 3;
    this.positions[o] = x;
    this.positions[o + 1] = y;
    this.positions[o + 2] = z;
    this.velocities[o] = vx;
    this.velocities[o + 1] = vy;
    this.velocities[o + 2] = vz;
    this.colors[o] = r;
    this.colors[o + 1] = g;
    this.colors[o + 2] = b;
    this.sizes[i] = size;
    this.alphas[i] = 0;
    this.baseAlpha[i] = alpha;
    this.life[i] = life;
    this.maxLife[i] = life;
  }

  update(dt: number): void {
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const o = i * 3;
      this.positions[o] += this.velocities[o] * dt;
      this.positions[o + 1] += this.velocities[o + 1] * dt;
      this.positions[o + 2] += this.velocities[o + 2] * dt;
      // Air drag on the puff, plus a little lift.
      const decay = Math.exp(-1.6 * dt);
      this.velocities[o] *= decay;
      this.velocities[o + 1] = this.velocities[o + 1] * decay + 0.55 * dt;
      this.velocities[o + 2] *= decay;

      const t = clamp01(this.life[i] / this.maxLife[i]);
      this.sizes[i] += 1.7 * dt;
      // Fade in over the first sliver of life as well as out, so puffs do not
      // pop into existence at full strength right under the camera. The spawn
      // alpha is the peak: smoke stays hazy, nitro flames run much hotter.
      this.alphas[i] = t * t * Math.min(1, (1 - t) * 7) * this.baseAlpha[i];
      if (this.life[i] <= 0) this.alphas[i] = 0;
    }
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.getAttribute('aSize').needsUpdate = true;
    this.geometry.getAttribute('aAlpha').needsUpdate = true;
    this.geometry.getAttribute('aColor').needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
    this.alphas.fill(0);
    this.geometry.getAttribute('aAlpha').needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

const SKID_VERT = /* glsl */ `
attribute float aAlpha;
attribute float aBirth;
uniform float uTime;
uniform float uLife;
varying float vAlpha;
void main() {
  float age = (uTime - aBirth) / uLife;
  vAlpha = aAlpha * clamp(1.0 - age, 0.0, 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKID_FRAG = /* glsl */ `
varying float vAlpha;
void main() {
  if (vAlpha <= 0.002) discard;
  gl_FragColor = vec4(0.04, 0.035, 0.033, vAlpha);
}
`;

/**
 * Rubber left on the road. A fixed ring buffer of independent quads: because
 * each segment owns its six vertices, recycling the oldest one never stitches a
 * stray triangle across the map.
 */
export class SkidMarks {
  readonly mesh: THREE.Mesh;
  private capacity: number;
  private positions: Float32Array;
  private alphas: Float32Array;
  private births: Float32Array;
  private head = 0;
  private geometry: THREE.BufferGeometry;
  private material: THREE.ShaderMaterial;
  private time = 0;

  /** Last emitted edge per tracked wheel, so segments join up. */
  private lastValid: boolean[] = [];
  private lastEdges: Float32Array;

  constructor(capacity: number, wheels = 2, life = 14) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 6 * 3);
    this.alphas = new Float32Array(capacity * 6);
    this.births = new Float32Array(capacity * 6);
    this.births.fill(-1e6);
    this.lastEdges = new Float32Array(wheels * 6);
    for (let i = 0; i < wheels; i++) this.lastValid.push(false);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
    this.geometry.setAttribute('aBirth', new THREE.BufferAttribute(this.births, 1));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uLife: { value: life },
      },
      vertexShader: SKID_VERT,
      fragmentShader: SKID_FRAG,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      fog: false,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  /**
   * Extends the mark for one wheel. `lx/lz` and `rx/rz` are the two edges of the
   * contact patch; `y` is the ground height there.
   */
  extend(
    wheel: number,
    lx: number, ly: number, lz: number,
    rx: number, ry: number, rz: number,
    alpha: number,
  ): void {
    const base = wheel * 6;
    if (!this.lastValid[wheel]) {
      this.storeEdge(base, lx, ly, lz, rx, ry, rz);
      this.lastValid[wheel] = true;
      return;
    }

    const plx = this.lastEdges[base];
    const ply = this.lastEdges[base + 1];
    const plz = this.lastEdges[base + 2];
    const prx = this.lastEdges[base + 3];
    const pry = this.lastEdges[base + 4];
    const prz = this.lastEdges[base + 5];

    // Only lay a new quad once the wheel has actually moved a little.
    const moved = Math.hypot(lx - plx, lz - plz);
    if (moved < 0.35) return;
    // A teleport (respawn) must not draw a stripe across the world.
    if (moved > 12) {
      this.storeEdge(base, lx, ly, lz, rx, ry, rz);
      return;
    }

    const seg = this.head;
    this.head = (this.head + 1) % this.capacity;
    const o = seg * 6 * 3;
    const write = (slot: number, x: number, y: number, z: number) => {
      const p = o + slot * 3;
      this.positions[p] = x;
      this.positions[p + 1] = y + 0.035;
      this.positions[p + 2] = z;
    };
    write(0, plx, ply, plz);
    write(1, prx, pry, prz);
    write(2, lx, ly, lz);
    write(3, prx, pry, prz);
    write(4, rx, ry, rz);
    write(5, lx, ly, lz);

    const a = seg * 6;
    for (let i = 0; i < 6; i++) {
      this.alphas[a + i] = alpha;
      this.births[a + i] = this.time;
    }

    this.storeEdge(base, lx, ly, lz, rx, ry, rz);
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.getAttribute('aAlpha').needsUpdate = true;
    this.geometry.getAttribute('aBirth').needsUpdate = true;
  }

  private storeEdge(
    base: number,
    lx: number, ly: number, lz: number,
    rx: number, ry: number, rz: number,
  ): void {
    this.lastEdges[base] = lx;
    this.lastEdges[base + 1] = ly;
    this.lastEdges[base + 2] = lz;
    this.lastEdges[base + 3] = rx;
    this.lastEdges[base + 4] = ry;
    this.lastEdges[base + 5] = rz;
  }

  /** Call when the wheel stops sliding, so the next mark starts fresh. */
  breakTrail(wheel: number): void {
    this.lastValid[wheel] = false;
  }

  update(dt: number): void {
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;
  }

  clear(): void {
    this.alphas.fill(0);
    for (let i = 0; i < this.lastValid.length; i++) this.lastValid[i] = false;
    this.geometry.getAttribute('aAlpha').needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
