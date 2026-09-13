/**
 * 2D (XZ-plane) collision primitives used by the custom physics.
 * Static world geometry is boxes (AABB or yaw-rotated OBB); characters are circles;
 * vehicles are OBBs. Heights are handled separately (everything is ground-level except
 * bullets, which use 3D rays against extruded boxes).
 */
import type { HasBounds } from './spatialHash';

export type ColliderKind = 'building' | 'prop' | 'wall' | 'water' | 'tree' | 'lamp';

export interface BoxCollider extends HasBounds {
  id: number;
  kind: ColliderKind;
  /** Centre in world space. */
  cx: number;
  cz: number;
  /** Half extents along the box's local axes. */
  hx: number;
  hz: number;
  /** Yaw rotation in radians (0 = axis aligned). */
  yaw: number;
  /** Height above ground (for bullet rays, camera collision, and jumping onto low props). */
  height: number;
  /** Cached cos/sin of yaw. */
  c: number;
  s: number;
  /** Whether bullets stop here. */
  solid: boolean;
  /** Optional back-reference to a game object (prop instance, etc.). */
  userData?: unknown;
}

let nextColliderId = 1;

export function makeBox(kind: ColliderKind, cx: number, cz: number, hx: number, hz: number, yaw = 0, height = 3, solid = true): BoxCollider {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const ex = Math.abs(c) * hx + Math.abs(s) * hz;
  const ez = Math.abs(s) * hx + Math.abs(c) * hz;
  return {
    id: nextColliderId++,
    kind,
    cx,
    cz,
    hx,
    hz,
    yaw,
    height,
    c,
    s,
    solid,
    minX: cx - ex,
    maxX: cx + ex,
    minZ: cz - ez,
    maxZ: cz + ez,
  };
}

/** Recompute the AABB after moving/rotating an OBB in place. */
export function refreshBoxBounds(b: BoxCollider): void {
  b.c = Math.cos(b.yaw);
  b.s = Math.sin(b.yaw);
  const ex = Math.abs(b.c) * b.hx + Math.abs(b.s) * b.hz;
  const ez = Math.abs(b.s) * b.hx + Math.abs(b.c) * b.hz;
  b.minX = b.cx - ex;
  b.maxX = b.cx + ex;
  b.minZ = b.cz - ez;
  b.maxZ = b.cz + ez;
}

export interface Contact {
  /** Push-out normal pointing away from the obstacle (toward the mover). */
  nx: number;
  nz: number;
  /** Penetration depth (>0 when overlapping). */
  depth: number;
}

const tmpContact: Contact = { nx: 0, nz: 0, depth: 0 };

/**
 * Circle vs OBB. Returns a contact (push-out for the circle) or null if separated.
 * Works in the box's local frame.
 */
export function circleVsBox(px: number, pz: number, r: number, b: BoxCollider, out: Contact = tmpContact): Contact | null {
  // world -> local
  const dx = px - b.cx;
  const dz = pz - b.cz;
  const lx = dx * b.c + dz * b.s;
  const lz = -dx * b.s + dz * b.c;
  // closest point on box
  const qx = lx < -b.hx ? -b.hx : lx > b.hx ? b.hx : lx;
  const qz = lz < -b.hz ? -b.hz : lz > b.hz ? b.hz : lz;
  let nx = lx - qx;
  let nz = lz - qz;
  const d2 = nx * nx + nz * nz;
  if (d2 > r * r) return null;
  let depth: number;
  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    nx /= d;
    nz /= d;
    depth = r - d;
  } else {
    // centre inside the box: push out through the nearest face
    const ox = b.hx - Math.abs(lx);
    const oz = b.hz - Math.abs(lz);
    if (ox < oz) {
      nx = lx >= 0 ? 1 : -1;
      nz = 0;
      depth = ox + r;
    } else {
      nx = 0;
      nz = lz >= 0 ? 1 : -1;
      depth = oz + r;
    }
  }
  // local -> world normal
  out.nx = nx * b.c - nz * b.s;
  out.nz = nx * b.s + nz * b.c;
  out.depth = depth;
  return out;
}

export function circleVsCircle(ax: number, az: number, ar: number, bx: number, bz: number, br: number, out: Contact = tmpContact): Contact | null {
  const dx = ax - bx;
  const dz = az - bz;
  const d2 = dx * dx + dz * dz;
  const rr = ar + br;
  if (d2 >= rr * rr) return null;
  const d = Math.sqrt(d2);
  if (d < 1e-6) {
    out.nx = 1;
    out.nz = 0;
    out.depth = rr;
  } else {
    out.nx = dx / d;
    out.nz = dz / d;
    out.depth = rr - d;
  }
  return out;
}

/** Corner positions of an OBB in world space (x0,z0,x1,z1,...). Reused buffer. */
const cornerBuf = new Float64Array(8);
export function boxCorners(b: BoxCollider, out: Float64Array = cornerBuf): Float64Array {
  const ax = b.c * b.hx;
  const az = b.s * b.hx;
  const bx = -b.s * b.hz;
  const bz = b.c * b.hz;
  out[0] = b.cx + ax + bx;
  out[1] = b.cz + az + bz;
  out[2] = b.cx - ax + bx;
  out[3] = b.cz - az + bz;
  out[4] = b.cx - ax - bx;
  out[5] = b.cz - az - bz;
  out[6] = b.cx + ax - bx;
  out[7] = b.cz + az - bz;
  return out;
}

const cornersA = new Float64Array(8);
const cornersB = new Float64Array(8);

/**
 * OBB vs OBB via the Separating Axis Theorem (4 axes). Returns the minimum translation
 * vector for A (push A away from B) or null when separated.
 */
export function boxVsBox(a: BoxCollider, b: BoxCollider, out: Contact = tmpContact): Contact | null {
  const ca = boxCorners(a, cornersA);
  const cb = boxCorners(b, cornersB);
  const axes = [a.c, a.s, -a.s, a.c, b.c, b.s, -b.s, b.c];
  let bestDepth = Infinity;
  let bestNx = 0;
  let bestNz = 0;
  for (let i = 0; i < 4; i++) {
    const nx = axes[i * 2];
    const nz = axes[i * 2 + 1];
    let minA = Infinity,
      maxA = -Infinity,
      minB = Infinity,
      maxB = -Infinity;
    for (let j = 0; j < 4; j++) {
      const pa = ca[j * 2] * nx + ca[j * 2 + 1] * nz;
      if (pa < minA) minA = pa;
      if (pa > maxA) maxA = pa;
      const pb = cb[j * 2] * nx + cb[j * 2 + 1] * nz;
      if (pb < minB) minB = pb;
      if (pb > maxB) maxB = pb;
    }
    const overlap = Math.min(maxA, maxB) - Math.max(minA, minB);
    if (overlap <= 0) return null;
    if (overlap < bestDepth) {
      bestDepth = overlap;
      // orient normal from B toward A
      const centreDelta = (a.cx - b.cx) * nx + (a.cz - b.cz) * nz;
      if (centreDelta >= 0) {
        bestNx = nx;
        bestNz = nz;
      } else {
        bestNx = -nx;
        bestNz = -nz;
      }
    }
  }
  out.nx = bestNx;
  out.nz = bestNz;
  out.depth = bestDepth;
  return out;
}

export interface RayHit {
  t: number; // distance along the ray (0..maxDist)
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
}

/**
 * 3D ray vs extruded OBB (box spans y in [0, height]). Returns nearest hit distance or -1.
 * Slab method in the box's local frame.
 */
export function rayVsBox(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, b: BoxCollider, maxDist: number, out?: RayHit): number {
  // to local
  const rx = ox - b.cx;
  const rz = oz - b.cz;
  const lox = rx * b.c + rz * b.s;
  const loz = -rx * b.s + rz * b.c;
  const ldx = dx * b.c + dz * b.s;
  const ldz = -dx * b.s + dz * b.c;
  let tmin = 0;
  let tmax = maxDist;
  let axis = -1;
  let sgn = 0;
  // X slab
  const slabs = [
    [lox, ldx, b.hx, 0],
    [loz, ldz, b.hz, 2],
    [oy - b.height / 2, dy, b.height / 2, 1],
  ] as const;
  for (const [o, d, h, ax] of slabs) {
    if (Math.abs(d) < 1e-9) {
      if (o < -h || o > h) return -1;
      continue;
    }
    const inv = 1 / d;
    let t1 = (-h - o) * inv;
    let t2 = (h - o) * inv;
    let s = -1;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
      s = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = ax;
      sgn = s;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  if (axis === -1) {
    // origin inside box
    if (out) {
      out.t = 0;
      out.x = ox;
      out.y = oy;
      out.z = oz;
      out.nx = -dx;
      out.ny = -dy;
      out.nz = -dz;
    }
    return 0;
  }
  if (out) {
    out.t = tmin;
    out.x = ox + dx * tmin;
    out.y = oy + dy * tmin;
    out.z = oz + dz * tmin;
    if (axis === 0) {
      out.nx = sgn * b.c;
      out.ny = 0;
      out.nz = sgn * b.s;
    } else if (axis === 2) {
      out.nx = -sgn * b.s;
      out.ny = 0;
      out.nz = sgn * b.c;
    } else {
      out.nx = 0;
      out.ny = sgn;
      out.nz = 0;
    }
  }
  return tmin;
}

/** Ray vs vertical cylinder (x,z centre, radius, y in [y0,y1]). Returns t or -1. */
export function rayVsCylinder(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, cx: number, cz: number, r: number, y0: number, y1: number, maxDist: number): number {
  const fx = ox - cx;
  const fz = oz - cz;
  const a = dx * dx + dz * dz;
  const b = 2 * (fx * dx + fz * dz);
  const c = fx * fx + fz * fz - r * r;
  let t = -1;
  if (a < 1e-9) {
    if (c > 0) return -1;
    t = 0;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return -1;
    const sq = Math.sqrt(disc);
    t = (-b - sq) / (2 * a);
    if (t < 0) {
      t = (-b + sq) / (2 * a);
      if (t < 0) return -1;
      t = 0; // inside
    }
  }
  if (t > maxDist) return -1;
  const y = oy + dy * t;
  if (y < y0 || y > y1) {
    // try caps
    if (Math.abs(dy) < 1e-9) return -1;
    const tc = ((y < y0 ? y0 : y1) - oy) / dy;
    if (tc < 0 || tc > maxDist) return -1;
    const px = ox + dx * tc - cx;
    const pz = oz + dz * tc - cz;
    if (px * px + pz * pz > r * r) return -1;
    return tc;
  }
  return t;
}

/** Ray vs sphere. Returns t or -1. */
export function rayVsSphere(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, cx: number, cy: number, cz: number, r: number, maxDist: number): number {
  const fx = ox - cx;
  const fy = oy - cy;
  const fz = oz - cz;
  const b = fx * dx + fy * dy + fz * dz;
  const c = fx * fx + fy * fy + fz * fz - r * r;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  let t = -b - Math.sqrt(disc);
  if (t < 0) t = 0;
  return t > maxDist ? -1 : t;
}

/** Point in OBB test. */
export function pointInBox(px: number, pz: number, b: BoxCollider): boolean {
  const dx = px - b.cx;
  const dz = pz - b.cz;
  const lx = dx * b.c + dz * b.s;
  const lz = -dx * b.s + dz * b.c;
  return Math.abs(lx) <= b.hx && Math.abs(lz) <= b.hz;
}

/** Squared distance from a point to an OBB (0 if inside). */
export function distSqPointBox(px: number, pz: number, b: BoxCollider): number {
  const dx = px - b.cx;
  const dz = pz - b.cz;
  const lx = dx * b.c + dz * b.s;
  const lz = -dx * b.s + dz * b.c;
  const ox = Math.max(0, Math.abs(lx) - b.hx);
  const oz = Math.max(0, Math.abs(lz) - b.hz);
  return ox * ox + oz * oz;
}
