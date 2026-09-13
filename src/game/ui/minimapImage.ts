/**
 * Pre-rendered top-down map of the city, used by both the minimap (cropped/rotated) and the
 * full-screen map (scaled). Map pixel space: x → right, z → down, origin at world
 * (-MAP_EXTENT, -MAP_EXTENT). Cached per world + scale.
 */
import { WORLD_HALF } from '../core/constants';
import type { District, WorldData } from '../core/types';

/** Metres of padding around the ±WORLD_HALF play area (shows the boundary strip + some ocean). */
export const MAP_MARGIN = 40;
export const MAP_EXTENT = WORLD_HALF + MAP_MARGIN;
export const MAP_SIZE_M = MAP_EXTENT * 2;
/** Scale used by the minimap crop (≈1040 px square). */
export const MAP_PX_PER_METER = 0.5;
/** Scale used by the full-screen map so zooming stays crisp (≈2080 px square). */
export const FULLMAP_PX_PER_METER = 1;

export const MAP_BG = '#0d1424';
export const WATER_COLOR = '#1d4f7a';

export const DISTRICT_COLORS: Record<District, string> = {
  downtown: '#3a3f4a',
  midtown: '#464b55',
  residential: '#4f6a3c',
  industrial: '#5a5046',
  harbor: '#4a5056',
  park: '#2f7a3a',
  beach: '#d9c48f',
  airfield: '#6d6d6a',
};

const DECAL_COLORS: Record<string, string> = {
  runway: '#45464a',
  taxiway: '#55565a',
  parking: '#3d4048',
  helipad: '#4c4d50',
  plaza: '#7a776d',
  boardwalk: '#8a6a45',
  path: '#8c8a78',
};

export function mapImageSize(pxPerMeter: number): number {
  return Math.ceil(MAP_SIZE_M * pxPerMeter);
}

export function worldToMap(x: number, z: number, pxPerMeter: number): { x: number; y: number } {
  return { x: (x + MAP_EXTENT) * pxPerMeter, y: (z + MAP_EXTENT) * pxPerMeter };
}

export function mapToWorld(mx: number, my: number, pxPerMeter: number): { x: number; z: number } {
  return { x: mx / pxPerMeter - MAP_EXTENT, z: my / pxPerMeter - MAP_EXTENT };
}

const cache = new WeakMap<WorldData, Map<number, HTMLCanvasElement>>();

export function renderMapImage(world: WorldData, pxPerMeter: number): HTMLCanvasElement {
  let perScale = cache.get(world);
  if (!perScale) {
    perScale = new Map();
    cache.set(world, perScale);
  }
  const hit = perScale.get(pxPerMeter);
  if (hit) return hit;
  const canvas = paint(world, pxPerMeter);
  perScale.set(pxPerMeter, canvas);
  return canvas;
}

function paint(world: WorldData, s: number): HTMLCanvasElement {
  const size = mapImageSize(s);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const px = (v: number) => (v + MAP_EXTENT) * s;
  const rect = (minX: number, minZ: number, maxX: number, maxZ: number) => {
    ctx.fillRect(px(minX), px(minZ), (maxX - minX) * s, (maxZ - minZ) * s);
  };

  // Background
  ctx.fillStyle = MAP_BG;
  ctx.fillRect(0, 0, size, size);

  // Ground slabs by district (large margin slabs first so blocks paint over them).
  const slabs = [...world.slabs].sort((a, b) => (b.maxX - b.minX) * (b.maxZ - b.minZ) - (a.maxX - a.minX) * (a.maxZ - a.minZ));
  for (const slab of slabs) {
    let color = DISTRICT_COLORS[slab.district];
    if (slab.top === 'sand') color = DISTRICT_COLORS.beach;
    else if (slab.top === 'grass' && slab.district !== 'park') color = '#44603a';
    else if (slab.top === 'dirt') color = '#5e5344';
    ctx.fillStyle = color;
    rect(slab.minX, slab.minZ, slab.maxX, slab.maxZ);
  }

  // Water
  ctx.fillStyle = WATER_COLOR;
  for (const w of world.water) rect(w.minX, w.minZ, w.maxX, w.maxZ);

  // Decals (runway, taxiways, parking, paths…)
  for (const d of world.decals) {
    ctx.fillStyle = DECAL_COLORS[d.kind] ?? '#666';
    if (d.kind === 'path') {
      ctx.globalAlpha = 0.7;
      rect(d.minX, d.minZ, d.maxX, d.maxZ);
      ctx.globalAlpha = 1;
    } else rect(d.minX, d.minZ, d.maxX, d.maxZ);
  }

  // Roads: once per undirected pair; streets then avenues so avenues paint on top.
  ctx.lineCap = 'square';
  ctx.lineJoin = 'miter';
  const nodes = world.roads.nodes;
  const nodeById = new Map<number, { x: number; z: number }>();
  for (const n of nodes) nodeById.set(n.id, n);
  const edges = world.roads.edges;
  for (const avenuePass of [false, true]) {
    ctx.strokeStyle = avenuePass ? '#959aa4' : '#8a8f99';
    ctx.beginPath();
    for (const e of edges) {
      if (e.isAvenue !== avenuePass) continue;
      if (e.twin >= 0 && e.twin < e.id) continue; // draw each street once
      const a = nodeById.get(e.from);
      const b = nodeById.get(e.to);
      if (!a || !b) continue;
      ctx.lineWidth = Math.max(1, 2 * e.halfWidth * s);
      ctx.moveTo(px(a.x), px(a.z));
      ctx.lineTo(px(b.x), px(b.z));
      // lineWidth is per-stroke, so stroke each edge individually.
      ctx.stroke();
      ctx.beginPath();
    }
  }
  // Avenue centre line for readability.
  ctx.strokeStyle = 'rgba(40, 44, 52, 0.55)';
  ctx.lineWidth = Math.max(1, 0.8 * s);
  ctx.beginPath();
  for (const e of edges) {
    if (!e.isAvenue || (e.twin >= 0 && e.twin < e.id)) continue;
    const a = nodeById.get(e.from);
    const b = nodeById.get(e.to);
    if (!a || !b) continue;
    ctx.moveTo(px(a.x), px(a.z));
    ctx.lineTo(px(b.x), px(b.z));
  }
  ctx.stroke();

  // Buildings
  const hasRoundRect = typeof ctx.roundRect === 'function';
  ctx.fillStyle = '#23262d';
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1;
  for (const b of world.buildings) {
    const w = b.w * s;
    const d = b.d * s;
    if (w < 1 || d < 1) continue;
    const radius = Math.min(2, w * 0.15, d * 0.15);
    if (b.yaw !== 0) {
      ctx.save();
      ctx.translate(px(b.x), px(b.z));
      ctx.rotate(-b.yaw);
      ctx.beginPath();
      if (hasRoundRect) ctx.roundRect(-w / 2, -d / 2, w, d, radius);
      else ctx.rect(-w / 2, -d / 2, w, d);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.beginPath();
      if (hasRoundRect) ctx.roundRect(px(b.x) - w / 2, px(b.z) - d / 2, w, d, radius);
      else ctx.rect(px(b.x) - w / 2, px(b.z) - d / 2, w, d);
      ctx.fill();
      ctx.stroke();
    }
  }

  // Landmark buildings get a lighter tint so they read on the map.
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  for (const b of world.buildings) {
    if (!b.name) continue;
    rect(b.x - b.w / 2, b.z - b.d / 2, b.x + b.w / 2, b.z + b.d / 2);
  }

  // Piers (props of kind 'pier': scale = length/100, centred).
  ctx.fillStyle = '#7a5c3a';
  for (const p of world.props) {
    if (p.kind !== 'pier') continue;
    const len = p.scale * 100;
    rect(p.x - len / 2, p.z - 4, p.x + len / 2, p.z + 4);
  }

  // Play-area boundary line.
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.strokeRect(px(-WORLD_HALF - 20), px(-WORLD_HALF - 20), (WORLD_HALF + 20) * 2 * s, (WORLD_HALF + 20) * 2 * s);

  return canvas;
}
