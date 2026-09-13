/** Canvas glyphs shared by the minimap and the full map. Drawn at the origin in CSS px. */
import type { BlipKind } from './uiBridge';

export const BLIP_COLORS: Record<BlipKind, string> = {
  player: '#ffffff',
  vehicle: '#ffffff',
  police: '#3b82f6',
  cop: '#3b82f6',
  ped: '#9ca3af',
  pickup: '#22c55e',
  mission: '#f5b700',
  target: '#ef4444',
  waypoint: '#a855f7',
  checkpoint: '#facc15',
  gunshop: '#166534',
  hospital: '#ffffff',
  poi: '#d4d4d8',
  objective: '#f5b700',
  passenger: '#22d3ee',
};

export const BLIP_LABELS: Record<BlipKind, string> = {
  player: 'You',
  vehicle: 'Vehicle',
  police: 'Police',
  cop: 'Officer',
  ped: 'Pedestrian',
  pickup: 'Pickup',
  mission: 'Mission',
  target: 'Target',
  waypoint: 'Waypoint',
  checkpoint: 'Checkpoint',
  gunshop: 'Ammu-Nation',
  hospital: 'Hospital',
  poi: 'Point of interest',
  objective: 'Objective',
  passenger: 'Passenger',
};

/** Draw order priority (higher = drawn later / on top). */
export const BLIP_PRIORITY: Record<BlipKind, number> = {
  ped: 0,
  vehicle: 1,
  pickup: 2,
  poi: 3,
  gunshop: 3,
  hospital: 3,
  passenger: 4,
  police: 5,
  cop: 5,
  checkpoint: 6,
  mission: 6,
  objective: 7,
  target: 8,
  waypoint: 9,
  player: 10,
};

function outlined(ctx: CanvasRenderingContext2D, fill: string, draw: () => void, lineWidth = 1.5): void {
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.fillStyle = fill;
  draw();
  ctx.fill();
  ctx.stroke();
}

/** Player / vehicle arrow pointing "up" (caller rotates by π − heading). */
export function drawArrow(ctx: CanvasRenderingContext2D, size: number, fill = '#ffffff'): void {
  ctx.beginPath();
  ctx.moveTo(0, -size);
  ctx.lineTo(size * 0.75, size * 0.8);
  ctx.lineTo(0, size * 0.4);
  ctx.lineTo(-size * 0.75, size * 0.8);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.stroke();
}

/**
 * Draw a blip glyph of `kind` at the origin. `r` is the nominal radius in px.
 * `phase` (0/1) alternates the police colours.
 */
export function drawBlip(ctx: CanvasRenderingContext2D, kind: BlipKind, r: number, color?: string, phase = 0): void {
  const c = color ?? BLIP_COLORS[kind];
  switch (kind) {
    case 'ped':
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(1, r * 0.45), 0, Math.PI * 2);
      ctx.fill();
      return;
    case 'vehicle':
      outlined(ctx, c, () => {
        ctx.beginPath();
        ctx.rect(-r * 0.7, -r * 0.7, r * 1.4, r * 1.4);
      });
      return;
    case 'police':
    case 'cop': {
      const blue = '#3b82f6';
      const red = '#ef4444';
      const left = phase ? red : blue;
      const right = phase ? blue : red;
      ctx.beginPath();
      ctx.arc(0, 0, r, Math.PI / 2, (Math.PI * 3) / 2);
      ctx.closePath();
      ctx.fillStyle = left;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2);
      ctx.closePath();
      ctx.fillStyle = right;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.stroke();
      if (kind === 'cop') {
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.3, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }
    case 'pickup':
      outlined(ctx, c, () => {
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.75, 0, Math.PI * 2);
      });
      return;
    case 'mission':
      outlined(ctx, c, () => {
        ctx.beginPath();
        ctx.moveTo(0, -r * 1.25);
        ctx.lineTo(r * 1.05, 0);
        ctx.lineTo(0, r * 1.25);
        ctx.lineTo(-r * 1.05, 0);
        ctx.closePath();
      });
      return;
    case 'target':
      outlined(ctx, c, () => {
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
      });
      ctx.fillStyle = '#1a0505';
      ctx.beginPath();
      ctx.arc(-r * 0.32, -r * 0.15, r * 0.22, 0, Math.PI * 2);
      ctx.arc(r * 0.32, -r * 0.15, r * 0.22, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(-r * 0.3, r * 0.35, r * 0.6, r * 0.2);
      return;
    case 'waypoint':
      outlined(ctx, c, () => {
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
      });
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.35, 0, Math.PI * 2);
      ctx.fill();
      return;
    case 'checkpoint':
    case 'objective':
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.1, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(2, r * 0.5);
      ctx.strokeStyle = c;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.1 + ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.stroke();
      return;
    case 'gunshop':
      outlined(ctx, c, () => {
        ctx.beginPath();
        ctx.rect(-r, -r, r * 2, r * 2);
      });
      ctx.fillStyle = '#d1fae5';
      ctx.fillRect(-r * 0.6, -r * 0.3, r * 1.2, r * 0.35);
      ctx.fillRect(-r * 0.05, -r * 0.3, r * 0.35, r * 0.85);
      return;
    case 'hospital':
      outlined(ctx, '#dc2626', () => {
        ctx.beginPath();
        ctx.rect(-r, -r, r * 2, r * 2);
      });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-r * 0.6, -r * 0.2, r * 1.2, r * 0.4);
      ctx.fillRect(-r * 0.2, -r * 0.6, r * 0.4, r * 1.2);
      return;
    case 'passenger':
      outlined(ctx, c, () => {
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.8, 0, Math.PI * 2);
      });
      return;
    case 'poi':
      outlined(ctx, c, () => {
        ctx.beginPath();
        ctx.moveTo(0, -r);
        ctx.lineTo(r, 0);
        ctx.lineTo(0, r);
        ctx.lineTo(-r, 0);
        ctx.closePath();
      });
      return;
    case 'player':
      drawArrow(ctx, r * 1.3, c);
      return;
    default:
      return;
  }
}

/** Sort blips so important ones draw last. */
export function blipOrder(a: BlipKind, b: BlipKind): number {
  return BLIP_PRIORITY[a] - BLIP_PRIORITY[b];
}
