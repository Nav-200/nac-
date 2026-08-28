/**
 * Small math helpers used across the game.
 * Everything here is allocation-free so it is safe to call from the frame loop.
 */

export const TAU = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const invLerp = (a: number, b: number, v: number): number =>
  a === b ? 0 : (v - a) / (b - a);

export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp01(invLerp(edge0, edge1, x));
  return t * t * (3 - 2 * t);
};

/**
 * Framerate-independent exponential smoothing.
 * `rate` is roughly "how many units of catch-up per second".
 */
export const damp = (a: number, b: number, rate: number, dt: number): number =>
  lerp(a, b, 1 - Math.exp(-rate * dt));

/** Move `a` toward `b` by at most `maxDelta`. */
export const moveToward = (a: number, b: number, maxDelta: number): number => {
  const d = b - a;
  if (Math.abs(d) <= maxDelta) return b;
  return a + Math.sign(d) * maxDelta;
};

/** Wrap an angle into (-PI, PI]. */
export const wrapAngle = (a: number): number => {
  let x = (a + Math.PI) % TAU;
  if (x < 0) x += TAU;
  return x - Math.PI;
};

/** Signed distance from angle `a` to angle `b`, in (-PI, PI]. */
export const angleDelta = (a: number, b: number): number => wrapAngle(b - a);

// --- Deterministic noise (no dependency, stable across reloads) -------------

const hash2 = (x: number, y: number, seed: number): number => {
  let h = x * 374761393 + y * 668265263 + seed * 1442695040;
  h = (h ^ (h >> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
};

/** Smooth value noise in [-1, 1]. */
export const valueNoise2 = (x: number, y: number, seed = 0): number => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);

  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);

  const top = lerp(a, b, u);
  const bottom = lerp(c, d, u);
  return lerp(top, bottom, v) * 2 - 1;
};

/** Fractal Brownian motion built on `valueNoise2`, roughly in [-1, 1]. */
export const fbm2 = (
  x: number,
  y: number,
  octaves = 4,
  lacunarity = 2.03,
  gain = 0.5,
  seed = 0,
): number => {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(x * freq, y * freq, seed + i * 17);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm === 0 ? 0 : sum / norm;
};

/** Small deterministic PRNG so world generation is reproducible. */
export const makeRng = (seed: number): (() => number) => {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
};
