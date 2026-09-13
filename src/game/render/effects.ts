/**
 * Visual effects: CPU-simulated, GPU-drawn particles plus a few tiny pools of
 * transient meshes (tracer lines, shockwave rings, muzzle-flash sprites).
 *
 * Two THREE.Points pools share one shader: an additive one for fire / sparks /
 * flashes and a normal alpha-blended one for smoke / dust / blood / debris.
 * All particle state lives in flat Float32Arrays; emitters write straight into
 * ring buffers and update() performs no allocations.
 */
import * as THREE from 'three';
import { glowTexture, smokeTexture } from '../core/textures';
import { fx } from '../core/rng';

// ---------------------------------------------------------------------------
// Particle record layout (Float32Array, STRIDE floats per particle)
// ---------------------------------------------------------------------------

const MAX_PARTICLES = 3000;
const STRIDE = 20;
const P_X = 0, P_Y = 1, P_Z = 2;
const P_VX = 3, P_VY = 4, P_VZ = 5;
const P_LIFE = 6, P_MAXLIFE = 7;
const P_SIZE0 = 8, P_SIZE1 = 9;
const P_R0 = 10, P_G0 = 11, P_B0 = 12;
const P_ALPHA0 = 13, P_GRAVITY = 14, P_DRAG = 15;
const P_R1 = 16, P_G1 = 17, P_B1 = 18;
const P_TURB = 19; // random velocity jitter, m/s^2

const TRACER_MAX = 24;
const TRACER_LIFE = 0.09;
const RING_MAX = 6;
const RING_LIFE = 0.6;
const FLASH_MAX = 8;
const FIRE_SLOTS = 16;
const TRAIL_SLOTS = 32;
const SOURCE_TIMEOUT = 0.5;
const MAX_BURST = 24;
const TWO_PI = Math.PI * 2;

type RGB = readonly [number, number, number];

/** Linear-space RGB tuple from an sRGB hex colour (evaluated once at module load). */
function lin(hex: number): RGB {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

const C = {
  flame0: lin(0xffa83a),
  flame1: lin(0x6e1200),
  fire0: lin(0xffc257),
  fire1: lin(0x8a1600),
  spark0: lin(0xfff1b8),
  spark1: lin(0xff7a1a),
  ember0: lin(0xffb060),
  ember1: lin(0xff3000),
  blood0: lin(0x9c1218),
  blood1: lin(0x3c0608),
  mist: lin(0x7a0c12),
  concrete: lin(0xa3a19b),
  sand: lin(0xc4b28c),
  wood: lin(0x7a4f28),
  woodDust: lin(0xcdb693),
  glass: lin(0xe6f2fb),
  water: lin(0xe2f1ff),
  debris: lin(0x37312d),
  white: lin(0xffffff),
} as const;

/** Scratch tuples for computed colours (filled right before emit, copied on emit). */
const GREY_A: [number, number, number] = [0, 0, 0];
const GREY_B: [number, number, number] = [0, 0, 0];
const RGB_A: [number, number, number] = [0, 0, 0];

function greyA(g: number): RGB {
  const l = g * g; // cheap sRGB -> linear
  GREY_A[0] = l;
  GREY_A[1] = l;
  GREY_A[2] = l;
  return GREY_A;
}

function greyB(g: number): RGB {
  const l = g * g;
  GREY_B[0] = l;
  GREY_B[1] = l;
  GREY_B[2] = l;
  return GREY_B;
}

/** Scratch velocity; filled by scatter(), consumed immediately. */
const V = { x: 0, y: 0, z: 0 };

/** V = dir * speed + random cube jitter * spread. */
function scatter(dx: number, dy: number, dz: number, speed: number, spread: number): void {
  V.x = dx * speed + (fx.next() * 2 - 1) * spread;
  V.y = dy * speed + (fx.next() * 2 - 1) * spread;
  V.z = dz * speed + (fx.next() * 2 - 1) * spread;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Shaders (three's ShaderMaterial prologue supplies position/modelViewMatrix/
// projectionMatrix and maps attribute/varying/texture2D/gl_FragColor to GLSL3).
// ---------------------------------------------------------------------------

const PARTICLE_VERT = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
attribute float aAlpha;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  if (aAlpha < 0.004) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = min(aSize * (300.0 / max(-mvPosition.z, 0.05)), 640.0);
  gl_Position = projectionMatrix * mvPosition;
}`;

const PARTICLE_FRAG = /* glsl */ `
uniform sampler2D map;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 t = texture2D(map, gl_PointCoord);
  float a = t.a * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor * t.rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------------------
// Particle pool
// ---------------------------------------------------------------------------

class ParticlePool {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  alive = 0;
  private readonly data = new Float32Array(MAX_PARTICLES * STRIDE);
  private readonly pos = new Float32Array(MAX_PARTICLES * 3);
  private readonly size = new Float32Array(MAX_PARTICLES);
  private readonly color = new Float32Array(MAX_PARTICLES * 3);
  private readonly alpha = new Float32Array(MAX_PARTICLES);
  private readonly posAttr: THREE.BufferAttribute;
  private readonly sizeAttr: THREE.BufferAttribute;
  private readonly colorAttr: THREE.BufferAttribute;
  private readonly alphaAttr: THREE.BufferAttribute;
  private head = 0;
  private dirty = false;

  constructor(map: THREE.Texture, additive: boolean, renderOrder: number) {
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('aSize', this.sizeAttr);
    geo.setAttribute('aColor', this.colorAttr);
    geo.setAttribute('aAlpha', this.alphaAttr);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: map } },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = renderOrder;
    this.points.matrixAutoUpdate = false;
  }

  /** Write one particle into the ring buffer (overwrites the oldest slot when full). */
  emit(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number, size0: number, size1: number,
    c0: RGB, c1: RGB, alpha: number,
    gravity: number, drag: number, turb: number,
  ): void {
    const i = this.head;
    this.head = i + 1 === MAX_PARTICLES ? 0 : i + 1;
    const b = i * STRIDE;
    const d = this.data;
    if (d[b + P_LIFE] <= 0) this.alive++;
    if (life < 0.016) life = 0.016;
    d[b + P_X] = x;
    d[b + P_Y] = y;
    d[b + P_Z] = z;
    d[b + P_VX] = vx;
    d[b + P_VY] = vy;
    d[b + P_VZ] = vz;
    d[b + P_LIFE] = life;
    d[b + P_MAXLIFE] = life;
    d[b + P_SIZE0] = size0;
    d[b + P_SIZE1] = size1;
    d[b + P_R0] = c0[0];
    d[b + P_G0] = c0[1];
    d[b + P_B0] = c0[2];
    d[b + P_ALPHA0] = alpha;
    d[b + P_GRAVITY] = gravity;
    d[b + P_DRAG] = drag;
    d[b + P_R1] = c1[0];
    d[b + P_G1] = c1[1];
    d[b + P_B1] = c1[2];
    d[b + P_TURB] = turb;
    const i3 = i * 3;
    this.pos[i3] = x;
    this.pos[i3 + 1] = y;
    this.pos[i3 + 2] = z;
    this.size[i] = size0;
    this.color[i3] = c0[0];
    this.color[i3 + 1] = c0[1];
    this.color[i3 + 2] = c0[2];
    this.alpha[i] = alpha;
    this.dirty = true;
  }

  update(dt: number): void {
    if (this.alive === 0 && !this.dirty) return;
    const d = this.data;
    const pos = this.pos;
    const size = this.size;
    const col = this.color;
    const alp = this.alpha;
    let alive = 0;
    for (let i = 0, b = 0; i < MAX_PARTICLES; i++, b += STRIDE) {
      let life = d[b + P_LIFE];
      if (life <= 0) continue;
      life -= dt;
      if (life <= 0) {
        d[b + P_LIFE] = 0;
        size[i] = 0;
        alp[i] = 0;
        continue;
      }
      alive++;
      d[b + P_LIFE] = life;
      const t = 1 - life / d[b + P_MAXLIFE];
      let vx = d[b + P_VX];
      let vy = d[b + P_VY] - d[b + P_GRAVITY] * dt;
      let vz = d[b + P_VZ];
      const turb = d[b + P_TURB];
      if (turb > 0) {
        const k = turb * dt * 2;
        vx += (fx.next() - 0.5) * k;
        vy += (fx.next() - 0.5) * k;
        vz += (fx.next() - 0.5) * k;
      }
      const drag = d[b + P_DRAG];
      if (drag > 0) {
        let k = 1 - drag * dt;
        if (k < 0) k = 0;
        vx *= k;
        vy *= k;
        vz *= k;
      }
      d[b + P_VX] = vx;
      d[b + P_VY] = vy;
      d[b + P_VZ] = vz;
      const x = d[b + P_X] + vx * dt;
      const y = d[b + P_Y] + vy * dt;
      const z = d[b + P_Z] + vz * dt;
      d[b + P_X] = x;
      d[b + P_Y] = y;
      d[b + P_Z] = z;
      const i3 = i * 3;
      pos[i3] = x;
      pos[i3 + 1] = y;
      pos[i3 + 2] = z;
      const s0 = d[b + P_SIZE0];
      size[i] = s0 + (d[b + P_SIZE1] - s0) * t;
      const r0 = d[b + P_R0];
      const g0 = d[b + P_G0];
      const b0 = d[b + P_B0];
      col[i3] = r0 + (d[b + P_R1] - r0) * t;
      col[i3 + 1] = g0 + (d[b + P_G1] - g0) * t;
      col[i3 + 2] = b0 + (d[b + P_B1] - b0) * t;
      // Quick fade-in over the first 10% of life, linear fade-out after.
      const ramp = t * 10;
      alp[i] = d[b + P_ALPHA0] * (1 - t) * (ramp < 1 ? ramp : 1);
    }
    this.alive = alive;
    this.posAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
    this.dirty = false;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Tracer lines
// ---------------------------------------------------------------------------

class TracerPool {
  readonly group = new THREE.Group();
  alive = 0;
  private readonly lines: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>[] = [];
  private readonly verts: Float32Array[] = [];
  private readonly attrs: THREE.BufferAttribute[] = [];
  private readonly life = new Float32Array(TRACER_MAX);
  private head = 0;

  constructor(renderOrder: number) {
    for (let i = 0; i < TRACER_MAX; i++) {
      const v = new Float32Array(6);
      const attr = new THREE.BufferAttribute(v, 3).setUsage(THREE.DynamicDrawUsage);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', attr);
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
      const mat = new THREE.LineBasicMaterial({
        color: 0xffd48a,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      });
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      line.matrixAutoUpdate = false;
      line.visible = false;
      line.renderOrder = renderOrder;
      this.lines.push(line);
      this.verts.push(v);
      this.attrs.push(attr);
      this.group.add(line);
    }
  }

  spawn(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const i = this.head;
    this.head = i + 1 === TRACER_MAX ? 0 : i + 1;
    if (this.life[i] <= 0) this.alive++;
    const v = this.verts[i];
    v[0] = x0;
    v[1] = y0;
    v[2] = z0;
    v[3] = x1;
    v[4] = y1;
    v[5] = z1;
    this.attrs[i].needsUpdate = true;
    this.life[i] = TRACER_LIFE;
    const line = this.lines[i];
    line.material.opacity = 1;
    line.visible = true;
  }

  update(dt: number): void {
    if (this.alive === 0) return;
    let alive = 0;
    for (let i = 0; i < TRACER_MAX; i++) {
      let life = this.life[i];
      if (life <= 0) continue;
      life -= dt;
      const line = this.lines[i];
      if (life <= 0) {
        this.life[i] = 0;
        line.visible = false;
        line.material.opacity = 0;
        continue;
      }
      alive++;
      this.life[i] = life;
      line.material.opacity = life / TRACER_LIFE;
    }
    this.alive = alive;
  }

  dispose(): void {
    for (let i = 0; i < TRACER_MAX; i++) {
      this.lines[i].geometry.dispose();
      this.lines[i].material.dispose();
    }
    this.group.clear();
  }
}

// ---------------------------------------------------------------------------
// Shockwave rings
// ---------------------------------------------------------------------------

class RingPool {
  readonly group = new THREE.Group();
  alive = 0;
  private readonly geo: THREE.RingGeometry;
  private readonly meshes: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[] = [];
  private readonly life = new Float32Array(RING_MAX);
  private readonly radius = new Float32Array(RING_MAX);
  private head = 0;

  constructor(renderOrder: number) {
    this.geo = new THREE.RingGeometry(0.78, 1, 48);
    this.geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < RING_MAX; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffe2b4,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
      const mesh = new THREE.Mesh(this.geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = renderOrder;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
  }

  spawn(x: number, y: number, z: number, radius: number): void {
    const i = this.head;
    this.head = i + 1 === RING_MAX ? 0 : i + 1;
    if (this.life[i] <= 0) this.alive++;
    this.life[i] = RING_LIFE;
    this.radius[i] = radius;
    const mesh = this.meshes[i];
    mesh.position.set(x, y, z);
    mesh.scale.set(radius * 0.1, 1, radius * 0.1);
    mesh.material.opacity = 0.9;
    mesh.visible = true;
  }

  update(dt: number): void {
    if (this.alive === 0) return;
    let alive = 0;
    for (let i = 0; i < RING_MAX; i++) {
      let life = this.life[i];
      if (life <= 0) continue;
      life -= dt;
      const mesh = this.meshes[i];
      if (life <= 0) {
        this.life[i] = 0;
        mesh.visible = false;
        mesh.material.opacity = 0;
        continue;
      }
      alive++;
      this.life[i] = life;
      const t = 1 - life / RING_LIFE;
      const ease = 1 - (1 - t) * (1 - t);
      const s = this.radius[i] * (0.1 + 0.9 * ease);
      mesh.scale.set(s, 1, s);
      mesh.material.opacity = 0.9 * (1 - t);
    }
    this.alive = alive;
  }

  dispose(): void {
    for (let i = 0; i < RING_MAX; i++) this.meshes[i].material.dispose();
    this.geo.dispose();
    this.group.clear();
  }
}

// ---------------------------------------------------------------------------
// Flash sprites
// ---------------------------------------------------------------------------

class FlashPool {
  readonly group = new THREE.Group();
  alive = 0;
  private readonly sprites: THREE.Sprite[] = [];
  private readonly life = new Float32Array(FLASH_MAX);
  private readonly maxLife = new Float32Array(FLASH_MAX);
  private head = 0;

  constructor(map: THREE.Texture, renderOrder: number) {
    for (let i = 0; i < FLASH_MAX; i++) {
      const mat = new THREE.SpriteMaterial({
        map,
        color: 0xffe4a8,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.frustumCulled = false;
      sprite.renderOrder = renderOrder;
      this.sprites.push(sprite);
      this.group.add(sprite);
    }
  }

  spawn(x: number, y: number, z: number, scale: number, life: number): void {
    const i = this.head;
    this.head = i + 1 === FLASH_MAX ? 0 : i + 1;
    if (this.life[i] <= 0) this.alive++;
    this.life[i] = life;
    this.maxLife[i] = life;
    const s = this.sprites[i];
    s.position.set(x, y, z);
    s.scale.set(scale, scale, 1);
    s.material.rotation = fx.next() * TWO_PI;
    s.material.opacity = 1;
    s.visible = true;
  }

  update(dt: number): void {
    if (this.alive === 0) return;
    let alive = 0;
    for (let i = 0; i < FLASH_MAX; i++) {
      let life = this.life[i];
      if (life <= 0) continue;
      life -= dt;
      const s = this.sprites[i];
      if (life <= 0) {
        this.life[i] = 0;
        s.visible = false;
        s.material.opacity = 0;
        continue;
      }
      alive++;
      this.life[i] = life;
      s.material.opacity = life / this.maxLife[i];
    }
    this.alive = alive;
  }

  dispose(): void {
    for (let i = 0; i < FLASH_MAX; i++) this.sprites[i].material.dispose();
    this.group.clear();
  }
}

// ---------------------------------------------------------------------------
// Continuous sources (fires, smoke trails) — fixed slots, no allocation.
// ---------------------------------------------------------------------------

interface Source {
  id: number;
  active: boolean;
  x: number;
  y: number;
  z: number;
  intensity: number;
  /** Seconds since the last set*() call. */
  age: number;
  accA: number;
  accB: number;
  dark: boolean;
}

function makeSources(count: number): Source[] {
  const list: Source[] = [];
  for (let i = 0; i < count; i++) {
    list.push({ id: -1, active: false, x: 0, y: 0, z: 0, intensity: 0, age: 0, accA: 0, accB: 0, dark: false });
  }
  return list;
}

/** Find the slot for id, else a free slot, else the stalest active slot. */
function acquireSource(list: Source[], id: number): Source {
  let free: Source | null = null;
  let stale: Source = list[0];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (s.active) {
      if (s.id === id) return s;
      if (s.age > stale.age) stale = s;
    } else if (free === null) {
      free = s;
    }
  }
  const slot = free ?? stale;
  slot.id = id;
  slot.active = true;
  slot.accA = 0;
  slot.accB = 0;
  return slot;
}

function releaseSource(list: Source[], id: number): void {
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (s.active && s.id === id) {
      s.active = false;
      s.id = -1;
      return;
    }
  }
}

/** Drain an emission accumulator into a burst count, capped to avoid hitch storms. */
function drain(s: Source, which: 0 | 1, rate: number, dt: number): number {
  const acc = (which === 0 ? s.accA : s.accB) + rate * dt;
  let n = Math.floor(acc);
  let rest = acc - n;
  if (n > MAX_BURST) {
    n = MAX_BURST;
    rest = 0;
  }
  if (which === 0) s.accA = rest;
  else s.accB = rest;
  return n;
}

// ---------------------------------------------------------------------------
// Public system
// ---------------------------------------------------------------------------

export class EffectsSystem {
  readonly root: THREE.Group;

  private readonly add: ParticlePool;
  private readonly alp: ParticlePool;
  private readonly tracers: TracerPool;
  private readonly rings: RingPool;
  private readonly flashes: FlashPool;
  private readonly fires: Source[] = makeSources(FIRE_SLOTS);
  private readonly trails: Source[] = makeSources(TRAIL_SLOTS);
  private readonly tmpColor = new THREE.Color();

  constructor() {
    const glow = glowTexture();
    const smoke = smokeTexture();
    this.root = new THREE.Group();
    this.root.name = 'effects';
    this.alp = new ParticlePool(smoke, false, 100);
    this.add = new ParticlePool(glow, true, 101);
    this.rings = new RingPool(101);
    this.tracers = new TracerPool(102);
    this.flashes = new FlashPool(glow, 103);
    this.root.add(this.alp.points, this.add.points, this.rings.group, this.tracers.group, this.flashes.group);
  }

  update(dt: number): void {
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;
    this.updateFires(dt);
    this.updateTrails(dt);
    this.add.update(dt);
    this.alp.update(dt);
    this.tracers.update(dt);
    this.rings.update(dt);
    this.flashes.update(dt);
  }

  get activeCount(): number {
    return this.add.alive + this.alp.alive + this.tracers.alive + this.rings.alive + this.flashes.alive;
  }

  dispose(): void {
    this.add.dispose();
    this.alp.dispose();
    this.tracers.dispose();
    this.rings.dispose();
    this.flashes.dispose();
    this.root.clear();
    for (let i = 0; i < this.fires.length; i++) this.fires[i].active = false;
    for (let i = 0; i < this.trails.length; i++) this.trails[i].active = false;
  }

  // ---- Emitters -----------------------------------------------------------

  spawnMuzzleFlash(x: number, y: number, z: number, dx: number, dy: number, dz: number, big = false): void {
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (l > 1e-6) {
      dx /= l;
      dy /= l;
      dz /= l;
    } else {
      dx = 0;
      dy = 0;
      dz = 1;
    }
    const fwd = big ? 0.4 : 0.22;
    this.flashes.spawn(x + dx * fwd, y + dy * fwd, z + dz * fwd, big ? 1.9 : 0.9, 0.045);
    const n = 3 + Math.floor(fx.next() * 3);
    for (let i = 0; i < n; i++) {
      scatter(dx, dy, dz, fx.range(6, 14), 2.2);
      this.add.emit(
        x + dx * 0.1, y + dy * 0.1, z + dz * 0.1, V.x, V.y, V.z,
        fx.range(0.08, 0.18), 0.09, 0.02, C.spark0, C.spark1, 1, 9.8, 1.5, 0,
      );
    }
    // Faint wisp of propellant smoke drifting forward.
    const g = greyA(0.72);
    this.alp.emit(
      x + dx * 0.3, y + dy * 0.3, z + dz * 0.3,
      dx * 1.4 + (fx.next() - 0.5) * 0.4, dy * 1.4 + 0.5, dz * 1.4 + (fx.next() - 0.5) * 0.4,
      fx.range(0.4, 0.6), big ? 0.35 : 0.18, big ? 1.1 : 0.6, g, g, 0.26, -0.3, 2.5, 1.5,
    );
  }

  spawnTracer(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    this.tracers.spawn(x0, y0, z0, x1, y1, z1);
  }

  spawnImpact(
    kind: 'concrete' | 'metal' | 'wood' | 'flesh' | 'glass' | 'ground' | 'water',
    x: number, y: number, z: number, nx: number, ny: number, nz: number,
  ): void {
    switch (kind) {
      case 'concrete': {
        const g0 = greyA(0.66);
        const g1 = greyB(0.58);
        for (let i = 0; i < 6; i++) {
          scatter(nx, ny, nz, fx.range(0.8, 2.2), 1.0);
          this.alp.emit(x, y, z, V.x, V.y, V.z, fx.range(0.5, 0.9), 0.14, fx.range(0.5, 0.8), g0, g1, 0.55, 0.4, 2.5, 0.8);
        }
        for (let i = 0; i < 3; i++) {
          scatter(nx, ny, nz, fx.range(3, 7), 3);
          this.add.emit(x, y, z, V.x, V.y, V.z, fx.range(0.15, 0.3), 0.06, 0.01, C.spark0, C.spark1, 1, 9.8, 0.8, 0);
        }
        break;
      }
      case 'metal': {
        for (let i = 0; i < 10; i++) {
          scatter(nx, ny, nz, fx.range(4, 9), 4);
          this.add.emit(x, y, z, V.x, V.y, V.z, fx.range(0.2, 0.45), 0.07, 0.015, C.spark0, C.spark1, 1, 12, 0.5, 0);
        }
        const g = greyA(0.6);
        this.alp.emit(x, y, z, nx * 0.8, ny * 0.8 + 0.4, nz * 0.8, 0.5, 0.1, 0.4, g, g, 0.3, -0.2, 2, 1);
        break;
      }
      case 'wood': {
        for (let i = 0; i < 8; i++) {
          scatter(nx, ny, nz, fx.range(2, 5), 2);
          this.alp.emit(x, y, z, V.x, V.y, V.z, fx.range(0.5, 0.9), 0.07, 0.05, C.wood, C.wood, 1, 9.8, 0.3, 0);
        }
        for (let i = 0; i < 3; i++) {
          scatter(nx, ny, nz, fx.range(0.6, 1.6), 0.8);
          this.alp.emit(x, y, z, V.x, V.y, V.z, fx.range(0.4, 0.7), 0.12, 0.45, C.woodDust, C.woodDust, 0.45, 0.5, 2.5, 0.5);
        }
        break;
      }
      case 'flesh': {
        this.spawnBlood(x, y, z, nx, ny, nz, 1.5);
        for (let i = 0; i < 2; i++) {
          scatter(nx, ny, nz, fx.range(0.5, 1.5), 0.6);
          this.alp.emit(x, y, z, V.x, V.y, V.z, fx.range(0.3, 0.5), 0.18, 0.6, C.mist, C.mist, 0.5, 0.8, 2.5, 0.5);
        }
        break;
      }
      case 'glass': {
        for (let i = 0; i < 12; i++) {
          scatter(nx, ny, nz, fx.range(1.5, 4), 2.5);
          this.alp.emit(x, y, z, V.x, V.y, V.z, fx.range(0.5, 1.0), 0.05, 0.03, C.glass, C.glass, 0.9, 9.8, 0.2, 0);
        }
        for (let i = 0; i < 3; i++) {
          scatter(nx, ny, nz, fx.range(1, 3), 1.5);
          this.add.emit(x, y, z, V.x, V.y, V.z, fx.range(0.1, 0.2), 0.12, 0.02, C.white, C.glass, 1, 4, 1, 0);
        }
        break;
      }
      case 'ground': {
        for (let i = 0; i < 8; i++) {
          scatter(nx, ny, nz, fx.range(0.6, 1.8), 0.9);
          this.alp.emit(x, y, z, V.x, V.y, V.z, fx.range(0.6, 1.1), 0.2, fx.range(0.6, 0.9), C.sand, C.sand, 0.5, 0.3, 2.2, 0.8);
        }
        break;
      }
      case 'water': {
        for (let i = 0; i < 14; i++) {
          this.alp.emit(
            x, y, z,
            (fx.next() - 0.5) * 3 + nx, fx.range(2, 5) + ny, (fx.next() - 0.5) * 3 + nz,
            fx.range(0.4, 0.8), 0.06, 0.04, C.water, C.water, 0.85, 9.8, 0.3, 0,
          );
        }
        this.alp.emit(x, y, z, nx * 0.3, 0.5 + ny * 0.3, nz * 0.3, 0.5, 0.3, 0.9, C.white, C.water, 0.5, 0, 2, 0.6);
        break;
      }
    }
  }

  spawnBlood(x: number, y: number, z: number, dx: number, dy: number, dz: number, amount: number): void {
    amount = clamp(amount, 0.25, 3);
    const n = Math.round(6 * amount);
    for (let i = 0; i < n; i++) {
      scatter(dx, dy, dz, fx.range(1, 4), 1.5);
      this.alp.emit(
        x, y, z, V.x, V.y + 0.5, V.z,
        fx.range(0.35, 0.7), fx.range(0.05, 0.11), 0.02, C.blood0, C.blood1, 1, 9.8, 0.5, 0,
      );
    }
    const mists = amount >= 2 ? 3 : 2;
    for (let i = 0; i < mists; i++) {
      scatter(dx, dy, dz, fx.range(0.6, 1.4), 0.5);
      this.alp.emit(x, y, z, V.x, V.y, V.z, fx.range(0.3, 0.45), 0.15 * amount, 0.45 * amount, C.mist, C.blood1, 0.5, 1, 2.5, 0.5);
    }
  }

  spawnExplosion(x: number, y: number, z: number, radius: number): void {
    radius = clamp(radius, 1, 30);
    const k = radius / 4;
    // Fireball
    const fireN = 40 + Math.floor(fx.next() * 21);
    for (let i = 0; i < fireN; i++) {
      scatter(0, 0.35, 0, 1, 1);
      const spd = fx.range(2, 8) * k;
      this.add.emit(
        x + V.x * radius * 0.15, y + V.y * radius * 0.15, z + V.z * radius * 0.15,
        V.x * spd, V.y * spd, V.z * spd,
        fx.range(0.5, 1.1), radius * fx.range(0.5, 0.9), radius * fx.range(1.2, 1.8),
        C.fire0, C.fire1, 1, -1.5, 3, 2,
      );
    }
    // Smoke column
    for (let i = 0; i < 30; i++) {
      scatter(0, 1, 0, fx.range(1.5, 4) * k, 1.6 * k);
      const g = fx.range(0.1, 0.3);
      this.alp.emit(
        x + (fx.next() - 0.5) * radius * 0.6, y + fx.next() * radius * 0.4, z + (fx.next() - 0.5) * radius * 0.6,
        V.x, V.y, V.z,
        fx.range(3, 4), radius * 0.6, radius * fx.range(2, 2.8),
        greyA(g), greyB(g * 0.7), 0.55, -0.4, 0.8, 3,
      );
    }
    // Debris chunks
    for (let i = 0; i < 20; i++) {
      scatter(0, 1, 0, fx.range(6, 16) * k, 8 * k);
      this.alp.emit(
        x, y + 0.2, z, V.x, V.y, V.z,
        fx.range(1, 2), fx.range(0.12, 0.3) * k, fx.range(0.1, 0.25) * k, C.debris, C.debris, 1, 9.8, 0.2, 0,
      );
    }
    // Hot sparks
    for (let i = 0; i < 24; i++) {
      scatter(0, 0.6, 0, fx.range(8, 20) * k, 10 * k);
      this.add.emit(x, y, z, V.x, V.y, V.z, fx.range(0.4, 0.9), 0.1 * k, 0.01, C.spark0, C.ember1, 1, 9.8, 0.6, 0);
    }
    this.rings.spawn(x, y + 0.15, z, radius * 1.6);
    this.flashes.spawn(x, y + radius * 0.3, z, radius * 3.5, 0.09);
  }

  spawnSmokePuff(x: number, y: number, z: number, size: number, grey = 0.5): void {
    grey = clamp(grey, 0, 1);
    this.alp.emit(
      x, y, z,
      (fx.next() - 0.5) * 0.3, fx.range(0.4, 0.8), (fx.next() - 0.5) * 0.3,
      fx.range(1.5, 2.5), size, size * 2.2, greyA(grey), greyB(grey * 0.85), 0.4, -0.2, 1, 1.2,
    );
  }

  spawnSparks(x: number, y: number, z: number, count: number, dx: number, dz: number): void {
    const l = Math.sqrt(dx * dx + dz * dz);
    const bx = l > 1e-6 ? dx / l : 0;
    const bz = l > 1e-6 ? dz / l : 0;
    count = clamp(Math.round(count), 1, 40);
    for (let i = 0; i < count; i++) {
      scatter(bx, 0.35, bz, fx.range(2, 6), 1.5);
      this.add.emit(x, y, z, V.x, V.y, V.z, fx.range(0.15, 0.4), 0.06, 0.01, C.spark0, C.spark1, 1, 9.8, 0.4, 0);
    }
  }

  spawnDust(x: number, y: number, z: number, size: number): void {
    const g0 = greyA(0.74);
    for (let i = 0; i < 2; i++) {
      this.alp.emit(
        x + (fx.next() - 0.5) * size * 0.5, y, z + (fx.next() - 0.5) * size * 0.5,
        (fx.next() - 0.5) * 0.8, fx.range(0.3, 0.9), (fx.next() - 0.5) * 0.8,
        fx.range(0.6, 1.2), size * 0.6, size * 2, C.sand, g0, 0.32, 0.15, 1.5, 0.8,
      );
    }
  }

  spawnDebris(x: number, y: number, z: number, count: number): void {
    count = clamp(Math.round(count), 1, 60);
    for (let i = 0; i < count; i++) {
      scatter(0, 1, 0, fx.range(3, 8), 3);
      this.alp.emit(x, y, z, V.x, V.y, V.z, fx.range(0.8, 1.6), fx.range(0.1, 0.25), fx.range(0.08, 0.2), C.debris, C.debris, 1, 9.8, 0.2, 0);
    }
  }

  spawnWaterSplash(x: number, y: number, z: number, size: number): void {
    size = clamp(size, 0.2, 6);
    const n = clamp(Math.round(10 * size), 6, 40);
    for (let i = 0; i < n; i++) {
      this.alp.emit(
        x + (fx.next() - 0.5) * size * 0.4, y, z + (fx.next() - 0.5) * size * 0.4,
        (fx.next() - 0.5) * 3 * size, fx.range(2, 5) * Math.sqrt(size), (fx.next() - 0.5) * 3 * size,
        fx.range(0.4, 0.9), 0.06 * size, 0.04 * size, C.water, C.water, 0.85, 9.8, 0.3, 0,
      );
    }
    for (let i = 0; i < 3; i++) {
      this.alp.emit(
        x, y, z, (fx.next() - 0.5) * size, fx.range(0.4, 1) * size, (fx.next() - 0.5) * size,
        fx.range(0.5, 0.8), 0.3 * size, 1.1 * size, C.white, C.water, 0.5, 0.5, 2, 0.6,
      );
    }
  }

  spawnPickupSparkle(x: number, y: number, z: number, colorHex: number): void {
    const c = this.tmpColor.setHex(colorHex);
    RGB_A[0] = c.r;
    RGB_A[1] = c.g;
    RGB_A[2] = c.b;
    const n = 12;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TWO_PI + fx.next() * 0.3;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      this.add.emit(
        x + ca * 0.35, y + fx.next() * 0.2, z + sa * 0.35,
        ca * 0.35, fx.range(1.2, 2), sa * 0.35,
        fx.range(0.6, 0.9), 0.14, 0.02, C.white, RGB_A, 1, -0.5, 1, 0.5,
      );
    }
  }

  spawnHitMarkerPuff(x: number, y: number, z: number): void {
    const g = greyA(0.92);
    for (let i = 0; i < 3; i++) {
      scatter(0, 0.3, 0, 1, 0.6);
      this.alp.emit(x, y, z, V.x, V.y, V.z, 0.25, 0.08, 0.32, g, g, 0.6, 0, 2, 0.5);
    }
    this.add.emit(x, y, z, 0, 0.2, 0, 0.1, 0.22, 0.0, C.white, C.white, 0.9, 0, 0, 0);
  }

  // ---- Continuous sources -------------------------------------------------

  setFire(id: number, x: number, y: number, z: number, intensity01: number): void {
    const s = acquireSource(this.fires, id);
    s.x = x;
    s.y = y;
    s.z = z;
    s.intensity = clamp(intensity01, 0, 1);
    s.age = 0;
  }

  removeFire(id: number): void {
    releaseSource(this.fires, id);
  }

  setSmokeTrail(id: number, x: number, y: number, z: number, intensity01: number, dark = false): void {
    const s = acquireSource(this.trails, id);
    s.x = x;
    s.y = y;
    s.z = z;
    s.intensity = clamp(intensity01, 0, 1);
    s.dark = dark;
    s.age = 0;
  }

  removeSmokeTrail(id: number): void {
    releaseSource(this.trails, id);
  }

  private updateFires(dt: number): void {
    const list = this.fires;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s.active) continue;
      s.age += dt;
      if (s.age > SOURCE_TIMEOUT) {
        s.active = false;
        s.id = -1;
        continue;
      }
      const k = s.intensity;
      if (k <= 0) continue;
      const spread = 0.35 + 0.9 * k;
      // Flames
      let n = drain(s, 0, 14 + 40 * k, dt);
      while (n-- > 0) {
        const a = fx.next() * TWO_PI;
        const r = Math.sqrt(fx.next()) * spread;
        const s0 = 0.5 + 0.7 * k;
        this.add.emit(
          s.x + Math.cos(a) * r, s.y, s.z + Math.sin(a) * r,
          (fx.next() - 0.5) * 0.6, fx.range(1.2, 2.6) + k, (fx.next() - 0.5) * 0.6,
          fx.range(0.35, 0.8), s0, s0 * 0.35, C.flame0, C.flame1, 0.9, -2, 1.2, 8,
        );
      }
      // Black smoke column
      n = drain(s, 1, 3 + 9 * k, dt);
      while (n-- > 0) {
        const a = fx.next() * TWO_PI;
        const r = Math.sqrt(fx.next()) * spread * 0.7;
        const s0 = 0.6 + 0.8 * k;
        const g = fx.range(0.08, 0.18);
        this.alp.emit(
          s.x + Math.cos(a) * r, s.y + 0.6, s.z + Math.sin(a) * r,
          (fx.next() - 0.5) * 0.6, fx.range(1.5, 3), (fx.next() - 0.5) * 0.6,
          fx.range(2, 3.5), s0, s0 * 3.5, greyA(g), greyB(g * 0.8), 0.45, -0.35, 0.7, 3,
        );
      }
      // Occasional ember
      if (fx.next() < 6 * k * dt) {
        this.add.emit(
          s.x + (fx.next() - 0.5) * spread, s.y + 0.3, s.z + (fx.next() - 0.5) * spread,
          (fx.next() - 0.5) * 2.4, fx.range(3, 6), (fx.next() - 0.5) * 2.4,
          fx.range(0.7, 1.4), 0.08, 0, C.ember0, C.ember1, 1, -0.8, 0.8, 10,
        );
      }
    }
  }

  private updateTrails(dt: number): void {
    const list = this.trails;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s.active) continue;
      s.age += dt;
      if (s.age > SOURCE_TIMEOUT) {
        s.active = false;
        s.id = -1;
        continue;
      }
      const k = s.intensity;
      if (k <= 0) continue;
      let n = drain(s, 0, 6 + 16 * k, dt);
      const dark = s.dark;
      const g0 = dark ? 0.1 : 0.72;
      const alpha = dark ? 0.5 : 0.3;
      while (n-- > 0) {
        const s0 = 0.18 + 0.15 * k;
        this.alp.emit(
          s.x + (fx.next() - 0.5) * 0.2, s.y + (fx.next() - 0.5) * 0.2, s.z + (fx.next() - 0.5) * 0.2,
          (fx.next() - 0.5) * 0.8, fx.range(0.3, 0.9), (fx.next() - 0.5) * 0.8,
          fx.range(0.7, 1.5) + (dark ? 0.6 : 0), s0, s0 * 3.5,
          greyA(g0), greyB(dark ? 0.16 : 0.62), alpha, -0.15, 1.4, 1.5,
        );
      }
    }
  }
}
