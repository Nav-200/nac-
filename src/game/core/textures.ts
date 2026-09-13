import * as THREE from 'three';
import { Rng } from './rng';

/**
 * Procedural canvas textures. Everything visual is generated at boot — no asset files.
 * Textures are cached by name so repeated requests are free.
 */
const cache = new Map<string, THREE.Texture>();

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  return [c, ctx];
}

function finish(name: string, canvas: HTMLCanvasElement, repeat = true, srgb = true, anisotropy = 4): THREE.Texture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  cache.set(name, tex);
  return tex;
}

function noise(ctx: CanvasRenderingContext2D, w: number, h: number, rng: Rng, amount: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const v = Math.floor(rng.range(-amount, amount));
    ctx.fillStyle = v >= 0 ? `rgba(255,255,255,${v / 255})` : `rgba(0,0,0,${-v / 255})`;
    ctx.fillRect(rng.range(0, w), rng.range(0, h), rng.range(1, 3), rng.range(1, 3));
  }
}

export function asphaltTexture(): THREE.Texture {
  const key = 'asphalt';
  const hit = cache.get(key);
  if (hit) return hit;
  const s = 256;
  const [c, ctx] = makeCanvas(s, s);
  const rng = new Rng(11);
  ctx.fillStyle = '#3a3a3e';
  ctx.fillRect(0, 0, s, s);
  noise(ctx, s, s, rng, 26, 9000);
  // A few cracks
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    let x = rng.range(0, s);
    let y = rng.range(0, s);
    ctx.moveTo(x, y);
    for (let j = 0; j < 8; j++) {
      x += rng.range(-20, 20);
      y += rng.range(-20, 20);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return finish(key, c);
}

export function sidewalkTexture(): THREE.Texture {
  const key = 'sidewalk';
  const hit = cache.get(key);
  if (hit) return hit;
  const s = 256;
  const [c, ctx] = makeCanvas(s, s);
  const rng = new Rng(12);
  ctx.fillStyle = '#9a9791';
  ctx.fillRect(0, 0, s, s);
  noise(ctx, s, s, rng, 18, 6000);
  ctx.strokeStyle = 'rgba(40,40,40,0.55)';
  ctx.lineWidth = 3;
  const tiles = 4;
  for (let i = 0; i <= tiles; i++) {
    const p = (i * s) / tiles;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, s);
    ctx.moveTo(0, p);
    ctx.lineTo(s, p);
    ctx.stroke();
  }
  return finish(key, c);
}

export function grassTexture(): THREE.Texture {
  const key = 'grass';
  const hit = cache.get(key);
  if (hit) return hit;
  const s = 256;
  const [c, ctx] = makeCanvas(s, s);
  const rng = new Rng(13);
  ctx.fillStyle = '#4c7a2f';
  ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 9000; i++) {
    const g = rng.int(90, 150);
    ctx.fillStyle = `rgb(${g * 0.45 | 0},${g},${g * 0.3 | 0})`;
    ctx.fillRect(rng.range(0, s), rng.range(0, s), rng.range(1, 3), rng.range(2, 5));
  }
  return finish(key, c);
}

export function dirtTexture(): THREE.Texture {
  const key = 'dirt';
  const hit = cache.get(key);
  if (hit) return hit;
  const s = 256;
  const [c, ctx] = makeCanvas(s, s);
  const rng = new Rng(14);
  ctx.fillStyle = '#7a6448';
  ctx.fillRect(0, 0, s, s);
  noise(ctx, s, s, rng, 30, 8000);
  return finish(key, c);
}

export function sandTexture(): THREE.Texture {
  const key = 'sand';
  const hit = cache.get(key);
  if (hit) return hit;
  const s = 256;
  const [c, ctx] = makeCanvas(s, s);
  const rng = new Rng(15);
  ctx.fillStyle = '#d9c48f';
  ctx.fillRect(0, 0, s, s);
  noise(ctx, s, s, rng, 14, 7000);
  return finish(key, c);
}

export function concreteTexture(): THREE.Texture {
  const key = 'concrete';
  const hit = cache.get(key);
  if (hit) return hit;
  const s = 128;
  const [c, ctx] = makeCanvas(s, s);
  const rng = new Rng(16);
  ctx.fillStyle = '#8d8d88';
  ctx.fillRect(0, 0, s, s);
  noise(ctx, s, s, rng, 16, 3000);
  return finish(key, c);
}

export function waterTexture(): THREE.Texture {
  const key = 'water';
  const hit = cache.get(key);
  if (hit) return hit;
  const s = 256;
  const [c, ctx] = makeCanvas(s, s);
  const rng = new Rng(17);
  ctx.fillStyle = '#1d4f7a';
  ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 400; i++) {
    ctx.strokeStyle = `rgba(255,255,255,${rng.range(0.03, 0.12)})`;
    ctx.lineWidth = rng.range(1, 2);
    const x = rng.range(0, s);
    const y = rng.range(0, s);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.bezierCurveTo(x + 10, y - 3, x + 20, y + 3, x + rng.range(20, 40), y);
    ctx.stroke();
  }
  return finish(key, c);
}

export interface FacadeStyle {
  base: string;
  window: string;
  windowLit: string;
  cols: number;
  rows: number;
  litChance: number;
  frame?: string;
}

export const FACADE_STYLES: FacadeStyle[] = [
  { base: '#5b6770', window: '#243447', windowLit: '#ffd58a', cols: 6, rows: 8, litChance: 0.35 }, // glass office
  { base: '#8a7a6a', window: '#2b2b33', windowLit: '#ffe0a3', cols: 5, rows: 6, litChance: 0.3 }, // brownstone
  { base: '#c9c2b4', window: '#1f2a3a', windowLit: '#fff1c1', cols: 7, rows: 7, litChance: 0.25 }, // beige tower
  { base: '#3f4a5a', window: '#9fc3e0', windowLit: '#ffe9b0', cols: 8, rows: 10, litChance: 0.4, frame: '#2a3340' }, // blue glass skyscraper
  { base: '#a8433a', window: '#2a2420', windowLit: '#ffd28a', cols: 4, rows: 5, litChance: 0.3 }, // red brick
  { base: '#d8d3c8', window: '#33404f', windowLit: '#fff3cc', cols: 6, rows: 4, litChance: 0.2 }, // low white commercial
  { base: '#6e6a63', window: '#1c1c1c', windowLit: '#ffcf7a', cols: 3, rows: 3, litChance: 0.15 }, // industrial
  { base: '#e8dcc0', window: '#40506a', windowLit: '#ffefc0', cols: 3, rows: 2, litChance: 0.3 }, // suburban house
];

/** Building facade with window grid. Emissive variant lights up at night. */
export function facadeTexture(styleIndex: number, seed: number, emissive = false): THREE.Texture {
  const key = `facade_${styleIndex}_${seed}_${emissive ? 'e' : 'd'}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const st = FACADE_STYLES[styleIndex % FACADE_STYLES.length];
  const w = 256;
  const h = 256;
  const [c, ctx] = makeCanvas(w, h);
  const rng = new Rng(1000 + seed);
  ctx.fillStyle = emissive ? '#000000' : st.base;
  ctx.fillRect(0, 0, w, h);
  if (!emissive) noise(ctx, w, h, rng, 12, 1500);
  const padX = w / st.cols;
  const padY = h / st.rows;
  const winW = padX * 0.55;
  const winH = padY * 0.55;
  for (let r = 0; r < st.rows; r++) {
    for (let col = 0; col < st.cols; col++) {
      const x = col * padX + (padX - winW) / 2;
      const y = r * padY + (padY - winH) / 2;
      const lit = rng.chance(st.litChance);
      if (emissive) {
        if (lit) {
          ctx.fillStyle = st.windowLit;
          ctx.fillRect(x, y, winW, winH);
        }
      } else {
        if (st.frame) {
          ctx.fillStyle = st.frame;
          ctx.fillRect(x - 2, y - 2, winW + 4, winH + 4);
        }
        ctx.fillStyle = st.window;
        ctx.fillRect(x, y, winW, winH);
        // reflection highlight
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(x, y, winW * 0.4, winH);
      }
    }
  }
  // Ground floor / horizontal banding for non-emissive
  if (!emissive) {
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    for (let r = 1; r < st.rows; r++) ctx.fillRect(0, r * padY - 1, w, 2);
  }
  return finish(key, c, true, true, 2);
}

export function roofTexture(): THREE.Texture {
  const key = 'roof';
  const hit = cache.get(key);
  if (hit) return hit;
  const s = 128;
  const [c, ctx] = makeCanvas(s, s);
  const rng = new Rng(18);
  ctx.fillStyle = '#4a4a4c';
  ctx.fillRect(0, 0, s, s);
  noise(ctx, s, s, rng, 20, 2500);
  return finish(key, c);
}

/** Simple radial glow sprite (for muzzle flash, lights, particles). */
export function glowTexture(): THREE.Texture {
  const key = 'glow';
  const hit = cache.get(key);
  if (hit) return hit;
  const s = 64;
  const [c, ctx] = makeCanvas(s, s);
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  return finish(key, c, false);
}

/** Smoke puff sprite. */
export function smokeTexture(): THREE.Texture {
  const key = 'smoke';
  const hit = cache.get(key);
  if (hit) return hit;
  const s = 64;
  const [c, ctx] = makeCanvas(s, s);
  const rng = new Rng(19);
  for (let i = 0; i < 14; i++) {
    const r = rng.range(8, 20);
    const x = rng.range(r, s - r);
    const y = rng.range(r, s - r);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  }
  return finish(key, c, false);
}

/** Skin/clothes palette for pedestrians — plain colours, no texture needed. */
export const SKIN_TONES = ['#f1c9a5', '#e0ac7e', '#c68642', '#8d5524', '#5c3a21', '#f6d7c3'];
export const SHIRT_COLORS = ['#e63946', '#457b9d', '#2a9d8f', '#f4a261', '#8338ec', '#ffbe0b', '#264653', '#ffffff', '#111111', '#06d6a0'];
export const PANTS_COLORS = ['#1d3557', '#3a3a3a', '#5a4632', '#2b2d42', '#6c757d', '#0b3954'];
export const CAR_COLORS = ['#c0392b', '#2980b9', '#27ae60', '#f1c40f', '#ecf0f1', '#2c3e50', '#8e44ad', '#e67e22', '#1abc9c', '#7f8c8d', '#111111', '#ffffff', '#95a5a6', '#d35400'];

export function disposeTextures(): void {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}

export function plankTexture(): THREE.Texture {
  const key = 'plank';
  const hit = cache.get(key);
  if (hit) return hit;
  const s = 256;
  const [c, ctx] = makeCanvas(s, s);
  const rng = new Rng(21);
  ctx.fillStyle = '#8a6a44';
  ctx.fillRect(0, 0, s, s);
  const planks = 8;
  for (let i = 0; i < planks; i++) {
    const y = (i * s) / planks;
    const shade = rng.int(-18, 18);
    ctx.fillStyle = `rgb(${138 + shade},${106 + shade},${68 + shade})`;
    ctx.fillRect(0, y, s, s / planks - 2);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, y + s / planks - 2, s, 2);
    for (let g = 0; g < 30; g++) {
      ctx.fillStyle = `rgba(0,0,0,${rng.range(0.03, 0.1)})`;
      ctx.fillRect(rng.range(0, s), y + rng.range(0, s / planks - 2), rng.range(10, 60), 1);
    }
  }
  return finish(key, c);
}

export function billboardTexture(variant: number): THREE.Texture {
  const key = `billboard_${variant}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const w = 512;
  const h = 256;
  const [c, ctx] = makeCanvas(w, h);
  const ads = [
    { bg: '#111111', fg: '#ffcc00', title: 'AMMU-NATION', sub: 'Protect yourself. Aggressively.' },
    { bg: '#0b3d91', fg: '#ffffff', title: 'PICO', sub: 'Small car. Big attitude.' },
    { bg: '#ff6f61', fg: '#ffffff', title: 'SUNSET SHORES', sub: 'Sand. Surf. Sirens.' },
    { bg: '#f7c600', fg: '#111111', title: 'CABBIE', sub: 'We drive. You survive.' },
    { bg: '#1f7a4d', fg: '#e9ffe9', title: 'GREENFIELD PARK', sub: 'Now with 40% fewer muggings' },
    { bg: '#2c2c2c', fg: '#66d9ff', title: 'OPEN CITY', sub: 'Everything is a rental.' },
  ];
  const ad = ads[variant % ads.length];
  ctx.fillStyle = ad.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = ad.fg;
  ctx.font = 'bold 72px Impact, "Arial Black", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(ad.title, w / 2, h * 0.4);
  ctx.font = '28px Arial, sans-serif';
  ctx.fillText(ad.sub, w / 2, h * 0.72);
  ctx.strokeStyle = ad.fg;
  ctx.lineWidth = 6;
  ctx.strokeRect(10, 10, w - 20, h - 20);
  return finish(key, c, false);
}

/** Runway / helipad style painted-marking texture is done with plain geometry; this is a subtle tile texture for plazas. */
export function plazaTexture(): THREE.Texture {
  const key = 'plaza';
  const hit = cache.get(key);
  if (hit) return hit;
  const s = 256;
  const [c, ctx] = makeCanvas(s, s);
  const rng = new Rng(23);
  const tiles = 4;
  for (let i = 0; i < tiles; i++) {
    for (let j = 0; j < tiles; j++) {
      const shade = (i + j) % 2 === 0 ? 168 : 150;
      const v = shade + rng.int(-6, 6);
      ctx.fillStyle = `rgb(${v},${v - 4},${v - 10})`;
      ctx.fillRect((i * s) / tiles, (j * s) / tiles, s / tiles - 2, s / tiles - 2);
    }
  }
  return finish(key, c);
}
