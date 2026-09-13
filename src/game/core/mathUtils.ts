export const TAU = Math.PI * 2;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function inverseLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : clamp01((v - a) / (b - a));
}

export function remap(v: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  return lerp(outMin, outMax, inverseLerp(inMin, inMax, v));
}

/** Frame-rate independent exponential smoothing. `lambda` ≈ speed (higher = snappier). */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function sign(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Shortest signed difference from angle a to angle b. */
export function angleDelta(a: number, b: number): number {
  return wrapAngle(b - a);
}

/** Damp an angle toward a target, taking the short way round. */
export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  return current + angleDelta(current, target) * (1 - Math.exp(-lambda * dt));
}

/** Move a value toward a target by at most `maxDelta`. */
export function moveToward(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + sign(d) * maxDelta;
}

export function approxEq(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

export function dist2D(ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  return Math.sqrt(dx * dx + dz * dz);
}

export function distSq2D(ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  return dx * dx + dz * dz;
}

/** Heading (yaw) in radians from a 2D direction, where yaw 0 = +Z and increases toward +X. */
export function headingFromDir(dx: number, dz: number): number {
  return Math.atan2(dx, dz);
}

/** Convert a yaw to a unit direction (x, z). */
export function dirFromHeading(yaw: number): [number, number] {
  return [Math.sin(yaw), Math.cos(yaw)];
}

export function randomInUnitDisk(rnd: () => number): [number, number] {
  const a = rnd() * TAU;
  const r = Math.sqrt(rnd());
  return [Math.cos(a) * r, Math.sin(a) * r];
}

/** Ease helpers for UI / camera. */
export const ease = {
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  inOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  outBack: (t: number) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2),
};

export function formatMoney(v: number): string {
  const neg = v < 0 ? '-' : '';
  return `${neg}$${Math.abs(Math.round(v)).toLocaleString('en-US')}`;
}

export function formatClock(t01: number): string {
  const totalMin = Math.floor(((t01 % 1) + 1) % 1 * 24 * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}
