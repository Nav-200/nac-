/**
 * Procedural low-poly models built from three.js primitives — vehicles, pedestrians, held
 * weapons, pickups and mission markers. No external assets.
 *
 * Conventions (shared with physics / AI / camera):
 *  - Models face local +Z. The game sets `root.rotation.y = yaw` (yaw 0 = world +Z).
 *  - Local +X is the driver's / character's LEFT (left-hand drive: driver seat on the +X side).
 *  - Ground is local y = 0 (tyres and shoes touch y = 0). Units are metres.
 *
 * Draw-call strategy: every static part of a vehicle (paint, trim, lamps, livery) is merged into
 * ONE geometry whose UVs point at texels of a tiny per-instance 16x1 "palette" texture (a colour
 * map plus an emissive map). Repainting, damage and light toggles rewrite a texel instead of
 * needing separate meshes / materials. Glass is a second mesh with a shared material, wheels are
 * one mesh each. Pedestrians use the same palette trick: one material for all six limb meshes.
 * Geometries are cached per vehicle type / ped kind / weapon id and shared between instances.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { VEHICLE_SPECS } from '../core/types';
import type { VehicleType, WeaponId } from '../core/types';
import { glowTexture } from '../core/textures';

// ------------------------------------------------------------------ palette textures
const PAL_W = 16;

interface Palette {
  tex: THREE.DataTexture;
  data: Uint8Array;
}

function makePalette(): Palette {
  const data = new Uint8Array(PAL_W * 4);
  for (let i = 0; i < PAL_W; i++) data[i * 4 + 3] = 255;
  const tex = new THREE.DataTexture(data, PAL_W, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return { tex, data };
}

/** Write an sRGB hex colour (optionally scaled toward black) into palette texel `i`. */
function setTexel(p: Palette, i: number, hex: number, scale = 1): void {
  const s = THREE.MathUtils.clamp(scale, 0, 1);
  p.data[i * 4] = Math.round(((hex >> 16) & 255) * s);
  p.data[i * 4 + 1] = Math.round(((hex >> 8) & 255) * s);
  p.data[i * 4 + 2] = Math.round((hex & 255) * s);
  p.tex.needsUpdate = true;
}

/** CSS colour string ('#rrggbb' or a named colour) -> sRGB hex number. */
function cssHex(css: string): number {
  return new THREE.Color(css).getHex();
}

// ------------------------------------------------------------------ primitive builder
type PaintMode = 'texel' | 'color';
type Axis = 'x' | 'y' | 'z';

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);

/**
 * Accumulates primitive geometries, tags each with either a palette texel (written into the UVs)
 * or a flat vertex colour, and merges them into a single non-indexed BufferGeometry.
 */
class Builder {
  private parts: THREE.BufferGeometry[] = [];

  constructor(private readonly mode: PaintMode) {}

  /** Add an arbitrary geometry, centred at (x,y,z) and rotated by Euler XYZ (rx, ry, rz). */
  add(geo: THREE.BufferGeometry, style: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): this {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    if (rx !== 0 || ry !== 0 || rz !== 0) {
      _e.set(rx, ry, rz, 'XYZ');
      _q.setFromEuler(_e);
    } else {
      _q.identity();
    }
    _p.set(x, y, z);
    _m4.compose(_p, _q, _one);
    g.applyMatrix4(_m4);
    this.tag(g, style);
    this.parts.push(g);
    return this;
  }

  private tag(g: THREE.BufferGeometry, style: number): void {
    const n = g.getAttribute('position').count;
    if (this.mode === 'texel') {
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      const u = (style + 0.5) / PAL_W;
      for (let i = 0; i < n; i++) uv.setXY(i, u, 0.5);
    } else {
      const c = new THREE.Color(style);
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        arr[i * 3] = c.r;
        arr[i * 3 + 1] = c.g;
        arr[i * 3 + 2] = c.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    }
  }

  /** Box of size (w,h,d) centred at (x,y,z). */
  box(style: number, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): this {
    return this.add(new THREE.BoxGeometry(w, h, d), style, x, y, z, rx, ry, rz);
  }

  /** Cylinder centred at (x,y,z) along `axis`; `rTop` is the radius at the +axis end. */
  cyl(style: number, rTop: number, rBot: number, len: number, x: number, y: number, z: number, axis: Axis = 'y', seg = 10): this {
    const g = new THREE.CylinderGeometry(rTop, rBot, len, seg, 1, false);
    if (axis === 'x') g.rotateZ(-Math.PI / 2);
    else if (axis === 'z') g.rotateX(Math.PI / 2);
    return this.add(g, style, x, y, z);
  }

  /** Sphere (or spherical cap when thetaLen < PI, measured from the +Y pole). */
  sphere(style: number, r: number, x: number, y: number, z: number, ws = 10, hs = 7, thetaLen = Math.PI): this {
    return this.add(new THREE.SphereGeometry(r, ws, hs, 0, Math.PI * 2, 0, thetaLen), style, x, y, z);
  }

  /** Cone pointing along `axis` (apex at the +axis end), centred at (x,y,z). */
  cone(style: number, r: number, h: number, x: number, y: number, z: number, axis: Axis = 'y', seg = 10): this {
    const g = new THREE.ConeGeometry(r, h, seg);
    if (axis === 'x') g.rotateZ(-Math.PI / 2);
    else if (axis === 'z') g.rotateX(Math.PI / 2);
    return this.add(g, style, x, y, z);
  }

  /** Side-view polygon of (z, y) points extruded along X to total width `w`, centred on `x`. */
  prism(style: number, pts: [number, number][], w: number, x = 0): this {
    const shape = new THREE.Shape();
    pts.forEach(([pz, py], i) => (i === 0 ? shape.moveTo(pz, py) : shape.lineTo(pz, py)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false, curveSegments: 1 });
    // Shape X -> local Z, extrusion (+Z) -> local -X, then recentre on x.
    g.rotateY(-Math.PI / 2);
    g.translate(x + w / 2, 0, 0);
    return this.add(g, style, 0, 0, 0);
  }

  /** Merge everything added so far into one geometry (parts are disposed). */
  build(): THREE.BufferGeometry {
    const merged = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts = [];
    merged.computeBoundingSphere();
    return merged;
  }
}

// ------------------------------------------------------------------ shared materials / caches
let glassMat: THREE.MeshStandardMaterial | null = null;
let wheelMat: THREE.MeshStandardMaterial | null = null;
let weaponMat: THREE.MeshStandardMaterial | null = null;

function getGlassMaterial(): THREE.MeshStandardMaterial {
  if (!glassMat) glassMat = new THREE.MeshStandardMaterial({ color: 0x111a22, metalness: 0.9, roughness: 0.1 });
  return glassMat;
}
function getWheelMaterial(): THREE.MeshStandardMaterial {
  if (!wheelMat) wheelMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.35, roughness: 0.75 });
  return wheelMat;
}
function getWeaponMaterial(): THREE.MeshStandardMaterial {
  if (!weaponMat) weaponMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.55, roughness: 0.55 });
  return weaponMat;
}

const wheelGeoCache = new Map<string, THREE.BufferGeometry>();
const vehicleGeoCache = new Map<VehicleType, VehicleGeo>();
const pedGeoCache = new Map<PedKind, PedGeo>();
const weaponGeoCache = new Map<WeaponId, THREE.BufferGeometry>();
const miscGeoCache = new Map<string, THREE.BufferGeometry>();
const miscMatCache = new Map<string, THREE.Material>();

/** Dark tyre + lighter hub disc + hub nut, merged with vertex colours; axis along X. */
function wheelGeometry(r: number, w: number): THREE.BufferGeometry {
  const key = `${r.toFixed(3)}_${w.toFixed(3)}`;
  const hit = wheelGeoCache.get(key);
  if (hit) return hit;
  const b = new Builder('color');
  b.cyl(0x141416, r, r, w, 0, 0, 0, 'x', 14);
  b.cyl(0x9a9ea3, r * 0.58, r * 0.58, w + 0.02, 0, 0, 0, 'x', 10);
  b.cyl(0x2a2a2c, r * 0.18, r * 0.18, w + 0.04, 0, 0, 0, 'x', 6);
  const g = b.build();
  wheelGeoCache.set(key, g);
  return g;
}

function cachedGeo(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  const hit = miscGeoCache.get(key);
  if (hit) return hit;
  const g = make();
  miscGeoCache.set(key, g);
  return g;
}

function cachedMat<T extends THREE.Material>(key: string, make: () => T): T {
  const hit = miscMatCache.get(key);
  if (hit) return hit as T;
  const m = make();
  miscMatCache.set(key, m);
  return m;
}

// ================================================================== VEHICLES
/** Palette texel slots used by vehicle geometry. */
const V = { paint: 0, trim: 1, chrome: 2, head: 3, tail: 4, rev: 5, sirenR: 6, sirenB: 7, livery: 8, white: 9, black: 10, amber: 11 } as const;

const TRIM_HEX = 0x1c1c1e;
const CHROME_HEX = 0xb8bcc0;
const WHITE_HEX = 0xe8e8e8;
const BLACK_HEX = 0x0e0e10;
const AMBER_HEX = 0xd88a1a;
const LENS_HEAD = 0xd8dcd0;
const LENS_TAIL = 0x5a0c0c;
const LENS_REV = 0xcfcfcf;
const LENS_SIREN_R = 0x7a1010;
const LENS_SIREN_B = 0x102070;
const GLOW_HEAD = 0xfff0c0;
const GLOW_TAIL_DIM = 0x7a0000;
const GLOW_TAIL_BRAKE = 0xff2020;
const GLOW_REV = 0xffffff;
const GLOW_SIREN_R = 0xff2020;
const GLOW_SIREN_B = 0x2050ff;

interface WheelDef {
  x: number;
  y: number;
  z: number;
  r: number;
  w: number;
  steer: boolean;
}

interface VehicleGeo {
  body: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  wheels: WheelDef[];
  headlights: THREE.Vector3[];
  exhaust: THREE.Vector3;
  seat: THREE.Vector3;
  /** Secondary livery colour (black band, white stripe…). */
  livery: number;
  hasSiren: boolean;
  fixedPaint: number | null;
}

/** Cabin side profile: base rear/front (at the beltline) and top rear/front (at the roof). */
interface CabinProfile {
  zb0: number;
  zb1: number;
  zt0: number;
  zt1: number;
}

interface CarDims {
  L: number;
  W: number;
  r: number;
  tyreW: number;
  clearance: number;
  beltY: number;
  roofY: number;
}

interface CarProfile {
  r: number;
  tyreW: number;
  clearance: number;
  beltY: number;
  cab: CabinProfile;
  /** Front / rear axle z. */
  wz: [number, number];
}

const CAR_PROFILES: Partial<Record<VehicleType, CarProfile>> = {
  compact: { r: 0.3, tyreW: 0.2, clearance: 0.22, beltY: 0.8, cab: { zb0: -1.65, zb1: 0.4, zt0: -1.45, zt1: -0.15 }, wz: [1.15, -1.15] },
  sedan: { r: 0.32, tyreW: 0.22, clearance: 0.24, beltY: 0.8, cab: { zb0: -1.15, zb1: 0.55, zt0: -0.85, zt1: -0.05 }, wz: [1.45, -1.45] },
  taxi: { r: 0.32, tyreW: 0.22, clearance: 0.24, beltY: 0.82, cab: { zb0: -1.15, zb1: 0.55, zt0: -0.85, zt1: -0.05 }, wz: [1.45, -1.45] },
  sports: { r: 0.33, tyreW: 0.26, clearance: 0.15, beltY: 0.62, cab: { zb0: -1.35, zb1: 0.55, zt0: -1.0, zt1: -0.35 }, wz: [1.35, -1.35] },
  suv: { r: 0.38, tyreW: 0.26, clearance: 0.32, beltY: 1.05, cab: { zb0: -2.3, zb1: 0.75, zt0: -2.2, zt1: 0.3 }, wz: [1.5, -1.5] },
  police: { r: 0.33, tyreW: 0.23, clearance: 0.24, beltY: 0.8, cab: { zb0: -1.2, zb1: 0.6, zt0: -0.9, zt1: -0.05 }, wz: [1.5, -1.5] },
  pickup: { r: 0.4, tyreW: 0.27, clearance: 0.34, beltY: 1.08, cab: { zb0: -0.68, zb1: 0.9, zt0: -0.6, zt1: 0.4 }, wz: [1.6, -1.7] },
};

const ROOF_T = 0.06;

/** Greenhouse: glass prism, roof slab and four pillars between beltY and roofY. */
function addCabin(b: Builder, glass: Builder, d: CarDims, c: CabinProfile, roofY = d.roofY): void {
  const inset = 0.06;
  const gTop = roofY - ROOF_T + 0.01;
  const gBot = d.beltY - 0.02;
  glass.prism(V.black, [[c.zb0, gBot], [c.zb1, gBot], [c.zt1, gTop], [c.zt0, gTop]], d.W - inset);
  b.box(V.paint, d.W - 0.02, ROOF_T, c.zt1 - c.zt0 + 0.08, 0, roofY - ROOF_T / 2, (c.zt0 + c.zt1) / 2);
  const h = gTop - gBot;
  const pillar = (zBase: number, zTop: number): void => {
    const dz = zTop - zBase;
    const len = Math.hypot(dz, h);
    const ang = Math.atan2(dz, h); // +rotation.x tilts the top toward +Z
    for (const sx of [1, -1]) b.box(V.paint, 0.07, len, 0.09, sx * (d.W / 2 - inset / 2 - 0.02), (gBot + gTop) / 2, (zBase + zTop) / 2, ang);
  };
  pillar(c.zb1, c.zt1);
  pillar(c.zb0, c.zt0);
}

/** Narrow sill between the wheels, full-width aprons beyond them, and the beltline slab. */
function addLowerBody(b: Builder, d: CarDims, wzF: number, wzR: number, zFront: number, zRear: number, slabZ0 = zRear, slabZ1 = zFront): number {
  const archTop = Math.min(2 * d.r + 0.08, d.beltY - 0.06);
  const midY = (d.clearance + archTop) / 2;
  const midH = archTop - d.clearance;
  const sillW = d.W - 2 * d.tyreW - 0.14;
  b.box(V.paint, sillW, midH, wzF - wzR, 0, midY, (wzF + wzR) / 2);
  const fz0 = wzF + d.r + 0.12;
  if (zFront > fz0) b.box(V.paint, d.W, midH, zFront - fz0, 0, midY, (zFront + fz0) / 2);
  const rz1 = wzR - d.r - 0.12;
  if (rz1 > zRear) b.box(V.paint, d.W, midH, rz1 - zRear, 0, midY, (rz1 + zRear) / 2);
  b.box(V.paint, d.W, d.beltY - archTop, slabZ1 - slabZ0, 0, (d.beltY + archTop) / 2, (slabZ0 + slabZ1) / 2);
  return archTop;
}

function addFrontFace(b: Builder, W: number, zF: number, yLamp: number, yBumper: number, lampW = 0.32, grille = true): void {
  b.box(V.trim, W + 0.04, 0.16, 0.18, 0, yBumper, zF + 0.03);
  for (const sx of [1, -1]) b.box(V.head, lampW, 0.14, 0.06, sx * (W / 2 - lampW / 2 - 0.1), yLamp, zF + 0.015);
  if (grille) b.box(V.trim, W * 0.42, 0.14, 0.05, 0, yLamp, zF + 0.01);
}

function addRearFace(b: Builder, W: number, zR: number, yLamp: number, yBumper: number, plate = true): void {
  b.box(V.trim, W + 0.04, 0.16, 0.18, 0, yBumper, zR - 0.03);
  for (const sx of [1, -1]) {
    b.box(V.tail, 0.32, 0.12, 0.06, sx * (W / 2 - 0.28), yLamp, zR - 0.015);
    b.box(V.rev, 0.1, 0.08, 0.06, sx * (W / 2 - 0.52), yLamp, zR - 0.015);
  }
  if (plate) b.box(V.white, 0.3, 0.12, 0.02, 0, yLamp, zR - 0.01);
  b.cyl(V.trim, 0.03, 0.03, 0.14, -W / 2 + 0.3, yBumper - 0.1, zR - 0.04, 'z', 8);
}

function addMirrors(b: Builder, W: number, y: number, z: number): void {
  for (const sx of [1, -1]) b.box(V.paint, 0.08, 0.07, 0.16, sx * (W / 2 + 0.07), y, z);
}

function wheelRow(d: CarDims, z: number, steer: boolean, out: WheelDef[]): void {
  const x = d.W / 2 - d.tyreW / 2 - 0.02;
  out.push({ x, y: d.r, z, r: d.r, w: d.tyreW, steer });
  out.push({ x: -x, y: d.r, z, r: d.r, w: d.tyreW, steer });
}

function buildVehicleGeo(type: VehicleType): VehicleGeo {
  const spec = VEHICLE_SPECS[type];
  const L = spec.length;
  const W = spec.width;
  const H = spec.height;
  const b = new Builder('texel');
  const g = new Builder('texel');
  const wheels: WheelDef[] = [];
  const headlights: THREE.Vector3[] = [];
  const exhaust = new THREE.Vector3(-W / 2 + 0.3, 0.3, -L / 2 - 0.12);
  const seat = new THREE.Vector3(W / 4 - 0.05, spec.cabinHeight, 0);
  let livery = 0x111111;
  let hasSiren = false;
  let fixedPaint: number | null = null;

  const prof = CAR_PROFILES[type];
  if (prof) {
    // ---- passenger cars, SUV, pickup
    const d: CarDims = { L, W, r: prof.r, tyreW: prof.tyreW, clearance: prof.clearance, beltY: prof.beltY, roofY: H };
    const c = prof.cab;
    const yLamp = d.beltY - 0.2;
    const yBumper = d.clearance + 0.1;
    const isPickup = type === 'pickup';
    const archTop = addLowerBody(b, d, prof.wz[0], prof.wz[1], L / 2, -L / 2, isPickup ? -0.7 : -L / 2, L / 2);
    addCabin(b, g, d, c);
    addFrontFace(b, W, L / 2, yLamp, yBumper);
    addRearFace(b, W, -L / 2, isPickup ? d.beltY - 0.25 : yLamp, yBumper);
    addMirrors(b, W, d.beltY + 0.12, c.zb1 - 0.02);
    wheelRow(d, prof.wz[0], true, wheels);
    wheelRow(d, prof.wz[1], false, wheels);
    for (const sx of [1, -1]) headlights.push(new THREE.Vector3(sx * (W / 2 - 0.26), yLamp, L / 2 + 0.06));
    exhaust.set(-W / 2 + 0.3, d.clearance, -L / 2 - 0.12);
    seat.set(W / 4 - 0.05, spec.cabinHeight, c.zt1 - 0.4);

    if (isPickup) {
      const bedLen = L / 2 - 0.7;
      const zc = -0.7 - bedLen / 2;
      const wallH = d.beltY - archTop;
      b.box(V.paint, W - 0.16, 0.05, bedLen, 0, archTop + 0.025, zc); // bed floor
      for (const sx of [1, -1]) b.box(V.paint, 0.08, wallH, bedLen, sx * (W / 2 - 0.04), archTop + wallH / 2, zc);
      b.box(V.paint, W, wallH, 0.08, 0, archTop + wallH / 2, -L / 2 + 0.04); // tailgate
      b.box(V.trim, W - 0.2, 0.04, 0.06, 0, archTop + wallH, -0.72); // cab-back rail
    } else if (type === 'taxi') {
      fixedPaint = 0xf7c600;
      b.box(V.white, 0.6, 0.2, 0.22, 0, H + 0.1, (c.zt0 + c.zt1) / 2);
      b.box(V.livery, W + 0.02, 0.1, 2.0, 0, 0.6, 0);
    } else if (type === 'police') {
      fixedPaint = 0xffffff;
      hasSiren = true;
      b.box(V.livery, W + 0.02, 0.32, 2.0, 0, 0.5, 0);
      const zc = (c.zt0 + c.zt1) / 2 + 0.1;
      b.box(V.trim, 1.15, 0.07, 0.3, 0, H + 0.035, zc);
      b.box(V.sirenR, 0.45, 0.13, 0.26, 0.32, H + 0.135, zc);
      b.box(V.sirenB, 0.45, 0.13, 0.26, -0.32, H + 0.135, zc);
      b.box(V.chrome, 0.18, 0.1, 0.2, 0, H + 0.12, zc);
      for (const sx of [1, -1]) b.box(V.trim, 0.06, 0.5, 0.06, sx * 0.35, d.clearance + 0.35, L / 2 + 0.14); // push bar
      b.box(V.trim, 0.9, 0.06, 0.06, 0, d.clearance + 0.52, L / 2 + 0.14);
      b.box(V.trim, 0.9, 0.06, 0.06, 0, d.clearance + 0.3, L / 2 + 0.14);
    } else if (type === 'sports') {
      b.box(V.paint, W - 0.4, 0.05, 0.32, 0, d.beltY + 0.2, -L / 2 + 0.22); // spoiler
      for (const sx of [1, -1]) b.box(V.trim, 0.05, 0.18, 0.08, sx * (W / 2 - 0.4), d.beltY + 0.09, -L / 2 + 0.2);
      b.box(V.trim, 0.5, 0.05, 0.6, 0, d.beltY + 0.02, 1.2); // hood scoop
    } else if (type === 'suv') {
      for (const sx of [1, -1]) b.box(V.trim, 0.06, 0.06, c.zt1 - c.zt0 - 0.2, sx * (W / 2 - 0.22), H + 0.03, (c.zt0 + c.zt1) / 2); // roof rails
    }
  } else if (type === 'van') {
    const d: CarDims = { L, W, r: 0.36, tyreW: 0.24, clearance: 0.3, beltY: 1.1, roofY: H };
    const c: CabinProfile = { zb0: 0.42, zb1: 2.0, zt0: 0.42, zt1: 1.5 };
    addLowerBody(b, d, 1.6, -1.5, L / 2, -L / 2);
    addCabin(b, g, d, c);
    b.box(V.paint, W, H - d.beltY, L / 2 + 0.45, 0, (H + d.beltY) / 2, (-L / 2 + 0.45) / 2); // cargo box
    b.box(V.trim, 0.02, H - d.beltY - 0.1, 0.02, 0, (H + d.beltY) / 2, -L / 2 - 0.005); // rear door seam
    addFrontFace(b, W, L / 2, d.beltY - 0.22, d.clearance + 0.1);
    addRearFace(b, W, -L / 2, d.beltY - 0.1, d.clearance + 0.1);
    addMirrors(b, W, d.beltY + 0.3, c.zb1 - 0.1);
    wheelRow(d, 1.6, true, wheels);
    wheelRow(d, -1.5, false, wheels);
    for (const sx of [1, -1]) headlights.push(new THREE.Vector3(sx * (W / 2 - 0.26), d.beltY - 0.22, L / 2 + 0.06));
    exhaust.set(-W / 2 + 0.3, d.clearance, -L / 2 - 0.12);
    seat.set(W / 4 - 0.05, spec.cabinHeight, 1.0);
  } else if (type === 'truck') {
    livery = 0xd9d9d9;
    const d: CarDims = { L, W, r: 0.5, tyreW: 0.32, clearance: 0.5, beltY: 1.7, roofY: 2.95 };
    const c: CabinProfile = { zb0: 1.62, zb1: 3.98, zt0: 1.62, zt1: 3.7 };
    b.box(V.paint, W, d.beltY - d.clearance, 2.4, 0, (d.beltY + d.clearance) / 2, 2.8); // cab lower
    addCabin(b, g, d, c, d.roofY);
    b.box(V.paint, W - 0.3, 0.35, 0.6, 0, d.roofY + 0.17, 2.0); // wind deflector
    b.box(V.livery, W, 2.5, 5.4, 0, 0.9 + 1.25, -1.3); // cargo box
    b.box(V.trim, W + 0.02, 0.08, 5.4, 0, 0.94, -1.3);
    b.box(V.trim, W + 0.02, 0.08, 5.4, 0, 3.36, -1.3);
    b.box(V.black, W - 0.9, 0.35, L - 0.5, 0, 0.72, -0.1); // chassis rails
    b.cyl(V.chrome, 0.3, 0.3, 1.0, -(W / 2 - 0.3), 0.75, 0.6, 'z', 10); // fuel tank
    b.cyl(V.chrome, 0.06, 0.06, 1.4, W / 2 - 0.2, 2.6, 1.45, 'y', 8); // exhaust stack
    addFrontFace(b, W, L / 2, 1.2, 0.72, 0.38);
    addRearFace(b, W, -L / 2, 1.08, 0.72, false);
    addMirrors(b, W, d.beltY + 0.5, c.zb1 - 0.15);
    wheelRow(d, 2.8, true, wheels);
    wheelRow(d, -1.5, false, wheels);
    wheelRow(d, -2.7, false, wheels);
    for (const sx of [1, -1]) headlights.push(new THREE.Vector3(sx * (W / 2 - 0.3), 1.2, L / 2 + 0.06));
    exhaust.set(W / 2 - 0.2, 3.32, 1.45);
    seat.set(W / 4 - 0.05, spec.cabinHeight, 3.0);
  } else {
    // ---- bus
    livery = 0xe8e8e8;
    fixedPaint = 0x2f6fd6;
    const d: CarDims = { L, W, r: 0.5, tyreW: 0.3, clearance: 0.45, beltY: 1.5, roofY: H };
    b.box(V.paint, W, H - d.clearance, L, 0, (H + d.clearance) / 2, 0);
    g.box(V.black, W + 0.02, 1.15, L + 0.02, 0, 2.08, 0); // window band (all four sides)
    b.box(V.livery, W + 0.02, 0.14, L - 0.3, 0, 1.36, 0); // stripe
    for (const dz of [3.6, -0.8]) b.box(V.trim, 0.03, 2.05, 1.1, -(W / 2 + 0.015), 1.5, dz); // doors (kerb side = -X)
    b.box(V.amber, 1.6, 0.3, 0.03, 0, 2.9, L / 2 + 0.005); // destination sign
    b.box(V.trim, 1.2, 0.2, 2.0, 0, H + 0.1, -1.0); // roof AC
    for (const sx of [1, -1]) b.box(V.trim, 0.1, 0.35, 0.12, sx * (W / 2 + 0.15), 2.1, L / 2 - 0.1); // mirrors
    addFrontFace(b, W, L / 2, 0.9, 0.6, 0.36, false);
    addRearFace(b, W, -L / 2, 1.0, 0.6, false);
    wheelRow(d, 3.4, true, wheels);
    wheelRow(d, -2.4, false, wheels);
    wheelRow(d, -3.6, false, wheels);
    for (const sx of [1, -1]) headlights.push(new THREE.Vector3(sx * (W / 2 - 0.28), 0.9, L / 2 + 0.06));
    exhaust.set(-W / 2 + 0.4, 0.5, -L / 2 - 0.12);
    seat.set(W / 4 - 0.05, spec.cabinHeight, 4.4);
  }

  return { body: b.build(), glass: g.build(), wheels, headlights, exhaust, seat, livery, hasSiren, fixedPaint };
}

function getVehicleGeo(type: VehicleType): VehicleGeo {
  const hit = vehicleGeoCache.get(type);
  if (hit) return hit;
  const geo = buildVehicleGeo(type);
  vehicleGeoCache.set(type, geo);
  return geo;
}

export interface VehicleModel {
  /** Add to the scene; the game sets position / rotation.y each frame. */
  root: THREE.Group;
  /** Pivot at the wheel hub: set pivot.rotation.y for steering (steer=true) and mesh.rotation.x for rolling (+x = forward). */
  wheels: { pivot: THREE.Object3D; mesh: THREE.Mesh; steer: boolean; radius: number }[];
  /** Repaint the body (ignored for fixed liveries: taxi, police, bus keep their colour). */
  setColor(hex: number): void;
  /** Headlights (white-yellow) plus dim red tail lights. */
  setHeadlights(on: boolean): void;
  /** Bright red tail lights. */
  setBrakeLights(on: boolean): void;
  setReverseLights(on: boolean): void;
  /** 0 = pristine … 1 = wreck: paint darkens and roughens progressively. */
  setDamage(d01: number): void;
  /** Police only: null = off, otherwise time in seconds (red / blue alternate at ~4 Hz). */
  setSiren(t: number | null): void;
  /** Two empties at the headlight positions, local +Z forward (for SpotLights on the player's car). */
  headlightAnchors: THREE.Object3D[];
  /** Rear exhaust tip (smoke particles). */
  exhaustAnchor: THREE.Object3D;
  /** Driver head position (camera / first person). */
  seatAnchor: THREE.Object3D;
  /** Dispose per-instance materials and textures only; shared geometries stay cached. */
  dispose(): void;
}

export function buildVehicleModel(type: VehicleType, colorHex: number): VehicleModel {
  const geo = getVehicleGeo(type);
  const pal = makePalette();
  const emis = makePalette();
  setTexel(pal, V.trim, TRIM_HEX);
  setTexel(pal, V.chrome, CHROME_HEX);
  setTexel(pal, V.head, LENS_HEAD);
  setTexel(pal, V.tail, LENS_TAIL);
  setTexel(pal, V.rev, LENS_REV);
  setTexel(pal, V.sirenR, LENS_SIREN_R);
  setTexel(pal, V.sirenB, LENS_SIREN_B);
  setTexel(pal, V.livery, geo.livery);
  setTexel(pal, V.white, WHITE_HEX);
  setTexel(pal, V.black, BLACK_HEX);
  setTexel(pal, V.amber, AMBER_HEX);

  const mat = new THREE.MeshStandardMaterial({
    map: pal.tex,
    emissive: 0xffffff,
    emissiveMap: emis.tex,
    emissiveIntensity: 1.3,
    metalness: 0.4,
    roughness: 0.5,
  });

  const root = new THREE.Group();
  root.name = `vehicle_${type}`;
  const body = new THREE.Mesh(geo.body, mat);
  body.castShadow = true;
  body.receiveShadow = true;
  root.add(body);
  const glass = new THREE.Mesh(geo.glass, getGlassMaterial());
  glass.castShadow = true;
  root.add(glass);

  const wheels: VehicleModel['wheels'] = geo.wheels.map((wd) => {
    const pivot = new THREE.Object3D();
    pivot.position.set(wd.x, wd.y, wd.z);
    const mesh = new THREE.Mesh(wheelGeometry(wd.r, wd.w), getWheelMaterial());
    mesh.castShadow = true;
    pivot.add(mesh);
    root.add(pivot);
    return { pivot, mesh, steer: wd.steer, radius: wd.r };
  });

  const headlightAnchors = geo.headlights.map((p) => {
    const o = new THREE.Object3D();
    o.position.copy(p);
    root.add(o);
    return o;
  });
  const exhaustAnchor = new THREE.Object3D();
  exhaustAnchor.position.copy(geo.exhaust);
  root.add(exhaustAnchor);
  const seatAnchor = new THREE.Object3D();
  seatAnchor.position.copy(geo.seat);
  root.add(seatAnchor);

  let paintHex = geo.fixedPaint ?? colorHex;
  let damage = 0;
  let headOn = false;
  let brakeOn = false;
  let revOn = false;

  const applyPaint = (): void => {
    setTexel(pal, V.paint, paintHex, 1 - 0.55 * damage);
    setTexel(pal, V.chrome, CHROME_HEX, 1 - 0.4 * damage);
    mat.roughness = 0.5 + 0.4 * damage;
    mat.metalness = 0.4 - 0.25 * damage;
  };
  const applyLights = (): void => {
    setTexel(emis, V.head, headOn ? GLOW_HEAD : 0);
    setTexel(emis, V.tail, brakeOn ? GLOW_TAIL_BRAKE : headOn ? GLOW_TAIL_DIM : 0);
    setTexel(emis, V.rev, revOn ? GLOW_REV : 0);
  };
  applyPaint();
  applyLights();

  return {
    root,
    wheels,
    headlightAnchors,
    exhaustAnchor,
    seatAnchor,
    setColor(hex: number): void {
      paintHex = geo.fixedPaint ?? hex;
      applyPaint();
    },
    setHeadlights(on: boolean): void {
      if (headOn === on) return;
      headOn = on;
      applyLights();
    },
    setBrakeLights(on: boolean): void {
      if (brakeOn === on) return;
      brakeOn = on;
      applyLights();
    },
    setReverseLights(on: boolean): void {
      if (revOn === on) return;
      revOn = on;
      applyLights();
    },
    setDamage(d01: number): void {
      const d = THREE.MathUtils.clamp(d01, 0, 1);
      if (Math.abs(d - damage) < 0.005) return;
      damage = d;
      applyPaint();
    },
    setSiren(t: number | null): void {
      if (!geo.hasSiren) return;
      if (t === null) {
        setTexel(emis, V.sirenR, 0);
        setTexel(emis, V.sirenB, 0);
        return;
      }
      const red = Math.floor(t * 8) % 2 === 0;
      setTexel(emis, V.sirenR, red ? GLOW_SIREN_R : 0);
      setTexel(emis, V.sirenB, red ? 0 : GLOW_SIREN_B);
    },
    dispose(): void {
      mat.dispose();
      pal.tex.dispose();
      emis.tex.dispose();
    },
  };
}

// ================================================================== PEDESTRIANS
type PedKind = 'civilian' | 'cop' | 'player';

/** Palette texel slots used by pedestrian geometry. */
const P = { skin: 0, shirt: 1, pants: 2, hair: 3, shoe: 4, badge: 5, cap: 6, belt: 7 } as const;

interface PedGeo {
  /** Torso + neck + head + hair/cap merged (head does not articulate separately). */
  body: THREE.BufferGeometry;
  armUpperL: THREE.BufferGeometry;
  armUpperR: THREE.BufferGeometry;
  leg: THREE.BufferGeometry;
}

const SHOULDER_Y = 1.42;
const SHOULDER_X = 0.26;
const HIP_Y = 0.92;
const HIP_X = 0.11;
const HEAD_Y = 1.62;

function armGeometry(kind: PedKind, right: boolean): THREE.BufferGeometry {
  const b = new Builder('texel');
  const sleeve = kind === 'cop' ? 0.34 : kind === 'player' ? 0.5 : 0.28; // sleeve length
  b.box(P.shirt, 0.12, sleeve, 0.12, 0, -sleeve / 2, 0);
  const forearm = 0.6 - sleeve;
  b.box(P.skin, 0.1, forearm, 0.1, 0, -sleeve - forearm / 2, 0);
  b.sphere(P.skin, 0.06, 0, -0.63, 0.01, 8, 6);
  if (kind === 'cop' && right) b.box(P.belt, 0.13, 0.04, 0.13, 0, -0.3, 0); // sleeve stripe
  return b.build();
}

function buildPedGeo(kind: PedKind): PedGeo {
  const b = new Builder('texel');
  // torso
  b.box(P.shirt, 0.44, 0.52, 0.24, 0, 1.17, 0);
  b.box(P.belt, 0.45, 0.06, 0.25, 0, 0.92, 0);
  b.box(P.pants, 0.42, 0.12, 0.23, 0, 0.86, 0);
  // neck + head
  b.cyl(P.skin, 0.06, 0.07, 0.12, 0, 1.47, 0, 'y', 8);
  b.sphere(P.skin, 0.135, 0, HEAD_Y, 0, 10, 8);
  // hair cap (upper hemisphere, slightly larger) and a fringe at the back
  b.sphere(P.hair, 0.145, 0, HEAD_Y + 0.01, -0.01, 10, 6, Math.PI * 0.55);
  b.box(P.hair, 0.26, 0.12, 0.08, 0, HEAD_Y - 0.02, -0.11);
  if (kind === 'cop') {
    b.cyl(P.cap, 0.15, 0.15, 0.09, 0, HEAD_Y + 0.11, 0, 'y', 12);
    b.box(P.cap, 0.26, 0.02, 0.14, 0, HEAD_Y + 0.07, 0.14); // peak
    b.box(P.badge, 0.06, 0.06, 0.02, -0.12, 1.3, 0.125); // badge on the right breast
  } else if (kind === 'player') {
    b.cyl(P.cap, 0.15, 0.15, 0.08, 0, HEAD_Y + 0.11, 0, 'y', 12);
    b.box(P.cap, 0.24, 0.02, 0.14, 0, HEAD_Y + 0.075, 0.15);
    b.box(P.pants, 0.46, 0.5, 0.06, 0, 1.17, -0.12); // jacket back panel in a second tone
  }
  const legB = new Builder('texel');
  legB.box(P.pants, 0.16, 0.46, 0.17, 0, -0.23, 0);
  legB.box(P.pants, 0.14, 0.4, 0.15, 0, -0.66, 0);
  legB.box(P.shoe, 0.15, 0.08, 0.27, 0, -0.88, 0.05);
  return { body: b.build(), armUpperL: armGeometry(kind, false), armUpperR: armGeometry(kind, true), leg: legB.build() };
}

function getPedGeo(kind: PedKind): PedGeo {
  const hit = pedGeoCache.get(kind);
  if (hit) return hit;
  const g = buildPedGeo(kind);
  pedGeoCache.set(kind, g);
  return g;
}

export interface PedPose {
  walkPhase: number;
  moveSpeed01: number;
  aiming: boolean;
  aimPitch: number;
  crouch?: boolean;
  inVehicle?: boolean;
  punchT?: number;
  hit?: number;
  jumpT?: number;
}

export interface PedModel {
  root: THREE.Group;
  head: THREE.Object3D;
  torso: THREE.Object3D;
  armL: THREE.Object3D;
  armR: THREE.Object3D;
  legL: THREE.Object3D;
  legR: THREE.Object3D;
  handR: THREE.Object3D;
  setPose(pose: PedPose): void;
  setColors(skin: string, shirt: string, pants: string): void;
  setRagdoll(down: boolean): void;
  dispose(): void;
}

export function buildPedModel(opts: { skin: string; shirt: string; pants: string; hair?: string; kind: 'civilian' | 'cop' | 'player' }): PedModel {
  const geo = getPedGeo(opts.kind);
  const pal = makePalette();
  const mat = new THREE.MeshStandardMaterial({ map: pal.tex, roughness: 0.85, metalness: 0.02 });
  const root = new THREE.Group();
  root.name = `ped_${opts.kind}`;
  const body = new THREE.Group(); // bobs / lies down; children keep their pivots
  root.add(body);
  const torso = new THREE.Mesh(geo.body, mat);
  torso.castShadow = true;
  body.add(torso);
  const head = new THREE.Object3D(); // exposed for API compatibility (head is merged into the torso mesh)
  head.position.set(0, HEAD_Y, 0);
  torso.add(head);
  const mkLimb = (g: THREE.BufferGeometry, x: number, y: number): THREE.Object3D => {
    const pivot = new THREE.Object3D();
    pivot.position.set(x, y, 0);
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = true;
    pivot.add(mesh);
    body.add(pivot);
    return pivot;
  };
  // Right-hand side is local -X.
  const armL = mkLimb(geo.armUpperL, SHOULDER_X, SHOULDER_Y);
  const armR = mkLimb(geo.armUpperR, -SHOULDER_X, SHOULDER_Y);
  const legL = mkLimb(geo.leg, HIP_X, HIP_Y);
  const legR = mkLimb(geo.leg, -HIP_X, HIP_Y);
  const handR = new THREE.Object3D();
  handR.position.set(0, -0.66, 0.06);
  handR.rotation.x = Math.PI / 2; // handR +Z runs down the arm, so a raised arm points the weapon forward
  armR.add(handR);

  const applyColors = (skin: string, shirt: string, pants: string, hair: string): void => {
    setTexel(pal, P.skin, cssHex(skin));
    setTexel(pal, P.shirt, cssHex(shirt));
    setTexel(pal, P.pants, cssHex(pants));
    setTexel(pal, P.hair, cssHex(hair));
    setTexel(pal, P.shoe, opts.kind === 'cop' ? 0x111111 : 0x2a2622);
    setTexel(pal, P.badge, 0xe6c04a);
    setTexel(pal, P.cap, opts.kind === 'cop' ? 0x1a2650 : opts.kind === 'player' ? 0x1f5a3a : cssHex(hair));
    setTexel(pal, P.belt, opts.kind === 'cop' ? 0x0f0f14 : 0x3a2e22);
  };
  applyColors(opts.skin, opts.shirt, opts.pants, opts.hair ?? '#2b1b0e');

  let ragdoll = false;
  const setPose = (p: PedPose): void => {
    if (ragdoll) return;
    const moving = p.moveSpeed01 > 0.02;
    const amp = moving ? 0.2 + 0.55 * p.moveSpeed01 : 0;
    const s = Math.sin(p.walkPhase);
    const hit = p.hit ?? 0;
    body.position.y = moving ? Math.abs(Math.sin(p.walkPhase)) * 0.035 * p.moveSpeed01 : 0;
    body.rotation.set(0, 0, 0);
    torso.rotation.set(0.1 * p.moveSpeed01 - hit * 0.25, 0, 0);
    if (p.inVehicle) {
      body.position.y = 0.05;
      legL.rotation.set(-1.35, 0, 0);
      legR.rotation.set(-1.35, 0, 0);
      armL.rotation.set(-1.05, 0, 0.15);
      armR.rotation.set(-1.05, 0, -0.15);
      torso.rotation.set(-0.08, 0, 0);
      return;
    }
    if (p.crouch) {
      body.position.y = -0.32;
      legL.rotation.set(-1.1, 0, 0.05);
      legR.rotation.set(-1.1, 0, -0.05);
      armL.rotation.set(-0.9, 0, 0.2);
      armR.rotation.set(-0.9, 0, -0.2);
      torso.rotation.set(0.35, 0, 0);
      return;
    }
    if (p.jumpT !== undefined) {
      legL.rotation.set(-0.5, 0, 0.05);
      legR.rotation.set(-0.35, 0, -0.05);
    } else {
      legL.rotation.set(s * amp, 0, 0);
      legR.rotation.set(-s * amp, 0, 0);
    }
    // arms
    if (p.aiming) {
      const pitch = p.aimPitch;
      armR.rotation.set(-Math.PI / 2 - pitch, 0, -0.05);
      armL.rotation.set(-Math.PI / 2 - pitch + 0.15, 0, 0.55);
      torso.rotation.y = -0.2;
    } else if (p.punchT !== undefined) {
      const k = Math.sin(Math.min(1, Math.max(0, p.punchT)) * Math.PI);
      armR.rotation.set(-1.55 * k, 0, -0.1);
      armL.rotation.set(-0.5 * k, 0, 0.3);
      torso.rotation.y = -0.35 * k;
    } else {
      armL.rotation.set(-s * amp * 0.75, 0, 0.08);
      armR.rotation.set(s * amp * 0.75, 0, -0.08);
    }
    if (hit > 0) {
      armL.rotation.x -= hit * 0.4;
      armR.rotation.x -= hit * 0.4;
    }
  };

  return {
    root,
    head,
    torso,
    armL,
    armR,
    legL,
    legR,
    handR,
    setPose,
    setColors(skin: string, shirt: string, pants: string): void {
      applyColors(skin, shirt, pants, opts.hair ?? '#2b1b0e');
    },
    setRagdoll(down: boolean): void {
      ragdoll = down;
      if (down) {
        // lie on the back: rotate about the feet so the body extends toward -Z, resting at y≈0.25
        body.rotation.set(-Math.PI / 2 + 0.05, 0, 0.12);
        body.position.set(0, 0.22, 0.05);
        torso.rotation.set(0, 0.25, 0);
        armL.rotation.set(-0.4, 0, 0.9);
        armR.rotation.set(-0.2, 0, -1.1);
        legL.rotation.set(0.1, 0, 0.35);
        legR.rotation.set(-0.15, 0, -0.2);
      } else {
        body.rotation.set(0, 0, 0);
        body.position.set(0, 0, 0);
        torso.rotation.set(0, 0, 0);
      }
    },
    dispose(): void {
      mat.dispose();
      pal.tex.dispose();
    },
  };
}

// ================================================================== WEAPONS
const GUNMETAL = 0x2a2d31;
const DARK = 0x141518;
const WOOD = 0x6b4a2a;
const OLIVE = 0x556b2f;

function buildWeaponGeo(id: WeaponId): THREE.BufferGeometry | null {
  const b = new Builder('color');
  switch (id) {
    case 'fist':
      return null;
    case 'bat':
      b.cyl(0xc9a06a, 0.035, 0.022, 0.85, 0, 0, 0.32, 'z', 10);
      b.cyl(0x3b2a1a, 0.024, 0.024, 0.12, 0, 0, -0.1, 'z', 8);
      break;
    case 'pistol':
      b.box(GUNMETAL, 0.03, 0.045, 0.19, 0, 0.03, 0.07);
      b.box(DARK, 0.028, 0.1, 0.04, 0, -0.04, -0.01, 0.25);
      b.cyl(DARK, 0.007, 0.007, 0.05, 0, 0.035, 0.18, 'z', 6);
      b.box(DARK, 0.01, 0.03, 0.03, 0, -0.005, 0.03);
      break;
    case 'smg':
      b.box(GUNMETAL, 0.05, 0.07, 0.34, 0, 0.03, 0.12);
      b.box(DARK, 0.03, 0.15, 0.04, 0, -0.08, 0.06, 0.1);
      b.box(DARK, 0.03, 0.09, 0.04, 0, -0.04, -0.03, 0.3);
      b.cyl(DARK, 0.01, 0.01, 0.1, 0, 0.04, 0.33, 'z', 6);
      b.box(DARK, 0.05, 0.04, 0.16, 0, 0.0, -0.16); // stock
      break;
    case 'shotgun':
      b.cyl(GUNMETAL, 0.018, 0.018, 0.72, 0, 0.04, 0.3, 'z', 8);
      b.cyl(GUNMETAL, 0.02, 0.02, 0.5, 0, 0.0, 0.2, 'z', 8); // tube magazine
      b.box(WOOD, 0.04, 0.045, 0.16, 0, 0.0, 0.4); // pump
      b.box(GUNMETAL, 0.04, 0.06, 0.16, 0, 0.02, -0.02); // receiver
      b.box(WOOD, 0.04, 0.07, 0.3, 0, -0.02, -0.22, 0.12); // stock
      break;
    case 'rifle':
      b.box(GUNMETAL, 0.045, 0.075, 0.5, 0, 0.03, 0.15);
      b.cyl(DARK, 0.012, 0.012, 0.3, 0, 0.05, 0.52, 'z', 6);
      b.box(DARK, 0.032, 0.17, 0.05, 0, -0.08, 0.08, 0.35); // curved-ish magazine
      b.box(DARK, 0.03, 0.09, 0.04, 0, -0.045, -0.06, 0.3); // grip
      b.box(WOOD, 0.045, 0.06, 0.26, 0, 0.0, -0.22); // stock
      b.box(DARK, 0.02, 0.05, 0.05, 0, 0.09, 0.05); // rear sight
      break;
    case 'sniper':
      b.box(GUNMETAL, 0.045, 0.07, 0.45, 0, 0.02, 0.05);
      b.cyl(DARK, 0.012, 0.014, 0.75, 0, 0.04, 0.6, 'z', 6);
      b.cyl(DARK, 0.026, 0.026, 0.28, 0, 0.11, 0.1, 'z', 8); // scope
      b.box(DARK, 0.03, 0.12, 0.04, 0, -0.06, 0.02, 0.2);
      b.box(WOOD, 0.045, 0.065, 0.3, 0, -0.01, -0.3, 0.05);
      b.box(DARK, 0.012, 0.11, 0.012, 0.03, -0.05, 0.62); // bipod legs
      b.box(DARK, 0.012, 0.11, 0.012, -0.03, -0.05, 0.62);
      break;
    case 'rpg':
      b.cyl(OLIVE, 0.06, 0.06, 1.05, 0, 0.05, 0.15, 'z', 12);
      b.cone(0x6a7a3a, 0.1, 0.32, 0, 0.05, 0.84, 'z', 12);
      b.cyl(OLIVE, 0.085, 0.06, 0.16, 0, 0.05, -0.42, 'z', 12); // venturi
      b.box(DARK, 0.03, 0.12, 0.05, 0, -0.06, 0.05, 0.25);
      b.box(DARK, 0.03, 0.1, 0.04, 0, -0.04, 0.3, 0.2);
      b.box(DARK, 0.02, 0.06, 0.06, 0, 0.14, 0.1); // sight
      break;
  }
  return b.build();
}

export function buildWeaponModel(id: WeaponId): THREE.Object3D {
  let geo = weaponGeoCache.get(id) ?? null;
  if (!geo) {
    geo = buildWeaponGeo(id);
    if (geo) weaponGeoCache.set(id, geo);
  }
  if (!geo) return new THREE.Object3D();
  const mesh = new THREE.Mesh(geo, getWeaponMaterial());
  mesh.castShadow = true;
  mesh.name = `weapon_${id}`;
  return mesh;
}

// ================================================================== PICKUPS / MARKERS
function pickupMaterial(key: string, emissiveHex: number): THREE.MeshStandardMaterial {
  return cachedMat(`pickup_${key}`, () => new THREE.MeshStandardMaterial({ vertexColors: true, emissive: emissiveHex, emissiveIntensity: 0.55, roughness: 0.35, metalness: 0.3 }));
}

export function buildPickupModel(kind: 'health' | 'armor' | 'money' | 'weapon', weaponId?: WeaponId): THREE.Object3D {
  const group = new THREE.Group();
  group.name = `pickup_${kind}`;
  let icon: THREE.Object3D;
  switch (kind) {
    case 'health': {
      const geo = cachedGeo('pickup_health', () => new Builder('color').box(0xff3b3b, 0.5, 0.16, 0.16, 0, 0, 0).box(0xff3b3b, 0.16, 0.5, 0.16, 0, 0, 0).box(0xffffff, 0.52, 0.06, 0.06, 0, 0, 0).build());
      icon = new THREE.Mesh(geo, pickupMaterial('health', 0xff2020));
      break;
    }
    case 'armor': {
      const geo = cachedGeo('pickup_armor', () => new Builder('color').box(0x3b82f6, 0.42, 0.42, 0.1, 0, 0.06, 0).box(0x3b82f6, 0.3, 0.2, 0.1, 0, -0.22, 0).box(0xdbeafe, 0.08, 0.34, 0.11, 0, 0.02, 0).build());
      icon = new THREE.Mesh(geo, pickupMaterial('armor', 0x2563eb));
      break;
    }
    case 'money': {
      const geo = cachedGeo('pickup_money', () =>
        new Builder('color')
          .box(0x3fbf5f, 0.42, 0.07, 0.22, 0, -0.07, 0, 0, 0.1)
          .box(0x4ccf6c, 0.42, 0.07, 0.22, 0, 0, 0, 0, -0.15)
          .box(0x3fbf5f, 0.42, 0.07, 0.22, 0, 0.07, 0, 0, 0.05)
          .box(0xf5d76e, 0.1, 0.23, 0.24, 0, 0, 0)
          .build(),
      );
      icon = new THREE.Mesh(geo, pickupMaterial('money', 0x22c55e));
      break;
    }
    default: {
      const w = buildWeaponModel(weaponId ?? 'pistol');
      w.scale.setScalar(1.4);
      w.rotation.set(0, 0, -0.35);
      const ring = new THREE.Mesh(cachedGeo('pickup_ring', () => new THREE.TorusGeometry(0.55, 0.035, 8, 28)), cachedMat('pickup_ring', () => new THREE.MeshStandardMaterial({ color: 0xffc94a, emissive: 0xffa500, emissiveIntensity: 0.9, roughness: 0.3, metalness: 0.6 })));
      ring.rotation.x = Math.PI / 2;
      const holder = new THREE.Group();
      holder.add(w, ring);
      icon = holder;
      break;
    }
  }
  icon.position.y = 1.0;
  group.add(icon);
  // soft ground glow
  const glow = new THREE.Sprite(cachedMat(`pickup_glow_${kind}`, () => new THREE.SpriteMaterial({ map: glowTexture(), color: kind === 'health' ? 0xff5050 : kind === 'armor' ? 0x60a5fa : kind === 'money' ? 0x4ade80 : 0xffc94a, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false })));
  glow.scale.set(1.6, 1.6, 1);
  glow.position.y = 1.0;
  group.add(glow);
  return group;
}

function markerMaterial(color: number, opacity: number): THREE.MeshBasicMaterial {
  return cachedMat(`marker_${color}_${opacity}`, () => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
}

export function buildMissionMarker(color: number): THREE.Object3D {
  const g = new THREE.Group();
  g.name = 'missionMarker';
  const cyl = new THREE.Mesh(cachedGeo('marker_cyl', () => new THREE.CylinderGeometry(1.5, 1.5, 3, 24, 1, true)), markerMaterial(color, 0.28));
  cyl.position.y = 1.5;
  const base = new THREE.Mesh(cachedGeo('marker_base', () => new THREE.RingGeometry(1.2, 1.55, 24)), markerMaterial(color, 0.6));
  base.rotation.x = -Math.PI / 2;
  base.position.y = 0.03;
  const arrow = new THREE.Mesh(cachedGeo('marker_arrow', () => new THREE.ConeGeometry(0.45, 0.9, 12)), markerMaterial(color, 0.9));
  arrow.rotation.x = Math.PI;
  arrow.position.y = 3.9;
  g.add(cyl, base, arrow);
  g.renderOrder = 20;
  return g;
}

export function buildCheckpointModel(color: number): THREE.Object3D {
  const g = new THREE.Group();
  g.name = 'checkpoint';
  const cyl = new THREE.Mesh(cachedGeo('checkpoint_cyl', () => new THREE.CylinderGeometry(4, 4, 6, 32, 1, true)), markerMaterial(color, 0.22));
  cyl.position.y = 3;
  const ring = new THREE.Mesh(cachedGeo('checkpoint_ring', () => new THREE.RingGeometry(3.6, 4.1, 32)), markerMaterial(color, 0.7));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.04;
  const arrow = new THREE.Mesh(cachedGeo('checkpoint_arrow', () => new THREE.ConeGeometry(0.8, 1.6, 12)), markerMaterial(color, 0.9));
  arrow.rotation.x = Math.PI;
  arrow.position.y = 7.4;
  g.add(cyl, ring, arrow);
  g.renderOrder = 20;
  return g;
}

// ================================================================== SMALL HELPERS
export function makeTracerLine(): { line: THREE.Line; set(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void } {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(6);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0xffe6a0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
  const line = new THREE.Line(geo, mat);
  line.frustumCulled = false;
  return {
    line,
    set(x0, y0, z0, x1, y1, z1): void {
      pos[0] = x0;
      pos[1] = y0;
      pos[2] = z0;
      pos[3] = x1;
      pos[4] = y1;
      pos[5] = z1;
      (geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    },
  };
}

export function makeMuzzleFlash(): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({ map: glowTexture(), color: 0xffb060, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
  const s = new THREE.Sprite(mat);
  s.scale.set(0.6, 0.6, 1);
  return s;
}

export function disposeModelCaches(): void {
  for (const g of wheelGeoCache.values()) g.dispose();
  wheelGeoCache.clear();
  for (const v of vehicleGeoCache.values()) {
    v.body.dispose();
    v.glass.dispose();
  }
  vehicleGeoCache.clear();
  for (const p of pedGeoCache.values()) {
    p.body.dispose();
    p.armUpperL.dispose();
    p.armUpperR.dispose();
    p.leg.dispose();
  }
  pedGeoCache.clear();
  for (const g of weaponGeoCache.values()) g.dispose();
  weaponGeoCache.clear();
  for (const g of miscGeoCache.values()) g.dispose();
  miscGeoCache.clear();
  for (const m of miscMatCache.values()) m.dispose();
  miscMatCache.clear();
  glassMat?.dispose();
  wheelMat?.dispose();
  weaponMat?.dispose();
  glassMat = wheelMat = weaponMat = null;
}
