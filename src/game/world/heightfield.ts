import { fbm2, smoothstep, valueNoise2 } from '../engine/math';

/** The world is a square centred on the origin, MAP_HALF metres in each direction. */
export const MAP_HALF = 760;
export const MAP_SIZE = MAP_HALF * 2;

/**
 * The underlying land shape, before the road carves into it.
 *
 * Three octaves at different scales give broad rolling hills, medium ridges and
 * a little surface texture. A rim that rises near the map edge frames the
 * playable area and reads as distant mountains instead of an invisible wall.
 */
export const baseTerrainHeight = (x: number, z: number): number => {
  const broad = fbm2(x * 0.00155, z * 0.00155, 4, 2.03, 0.5, 11) * 44;
  const medium = fbm2(x * 0.0067, z * 0.0067, 3, 2.11, 0.5, 71) * 8.5;
  const fine = valueNoise2(x * 0.031, z * 0.031, 131) * 0.75;

  const r = Math.hypot(x, z) / MAP_HALF;
  const rim = smoothstep(0.68, 1.12, r) * 120;

  return broad + medium + fine + rim;
};
