import { useEffect, useRef } from 'react';
import { blipOrder, drawArrow, drawBlip } from './blipGlyphs';
import { MAP_BG, MAP_PX_PER_METER, renderMapImage, worldToMap } from './minimapImage';
import { getUiBridge, type BlipKind, type MinimapState } from './uiBridge';

interface Props {
  /** Outer diameter in CSS px (including the 3 px ring). */
  size?: number;
  className?: string;
}

const TAU = Math.PI * 2;
const RING = 3;

const BLIP_RADIUS: Record<BlipKind, number> = {
  player: 7,
  vehicle: 3.5,
  police: 4.5,
  cop: 4,
  ped: 2.2,
  pickup: 3.5,
  mission: 5,
  target: 4.5,
  waypoint: 5,
  checkpoint: 5,
  gunshop: 4.5,
  hospital: 4.5,
  poi: 3.5,
  objective: 5.5,
  passenger: 4,
};

/**
 * Circular radar. Draws in its own rAF loop straight from bridge.minimap() — React never
 * re-renders this component during play.
 */
export function Minimap({ size = 200, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const inner = size - RING * 2;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ring = ringRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let img: HTMLCanvasElement | null = null;
    let lastWanted = -1;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const px = Math.round(inner * dpr);
      if (canvas.width !== px || canvas.height !== px) {
        canvas.width = px;
        canvas.height = px;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const bridge = getUiBridge();
      if (!bridge) {
        ctx.fillStyle = MAP_BG;
        ctx.fillRect(0, 0, inner, inner);
        return;
      }
      if (!img) {
        const world = bridge.world();
        if (world) img = renderMapImage(world, MAP_PX_PER_METER);
      }
      const st = bridge.minimap();
      drawMinimap(ctx, inner, img, st);
      const wantedOn = st.wanted > 0 ? 1 : 0;
      if (ring && wantedOn !== lastWanted) {
        lastWanted = wantedOn;
        ring.dataset.wanted = String(wantedOn);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [inner]);

  return (
    <div ref={ringRef} data-wanted="0" className={`minimap-ring rounded-full overflow-hidden bg-[#0d1424] ${className ?? ''}`} style={{ width: size, height: size }}>
      <canvas ref={canvasRef} style={{ width: inner, height: inner, display: 'block' }} aria-label="Minimap" />
    </div>
  );
}

function drawMinimap(ctx: CanvasRenderingContext2D, S: number, img: HTMLCanvasElement | null, st: MinimapState): void {
  const R = S / 2;
  const zoom = st.zoomRadius > 0 ? st.zoomRadius : st.inVehicle ? 180 : 110;
  const s = (R - 2) / zoom; // screen px per metre
  const theta = st.camYaw - Math.PI; // rotate so the camera direction points up

  ctx.clearRect(0, 0, S, S);
  ctx.save();
  ctx.beginPath();
  ctx.arc(R, R, R, 0, TAU);
  ctx.clip();
  ctx.fillStyle = MAP_BG;
  ctx.fillRect(0, 0, S, S);

  ctx.translate(R, R);
  ctx.rotate(theta);

  // Map crop centred on the player.
  if (img) {
    const k = s / MAP_PX_PER_METER; // screen px per image px
    const pm = worldToMap(st.x, st.z, MAP_PX_PER_METER);
    const half = (R * 1.5) / k;
    let sx = pm.x - half;
    let sy = pm.y - half;
    let sw = half * 2;
    let sh = half * 2;
    let dx = -half * k;
    let dy = -half * k;
    if (sx < 0) {
      dx -= sx * k;
      sw += sx;
      sx = 0;
    }
    if (sy < 0) {
      dy -= sy * k;
      sh += sy;
      sy = 0;
    }
    if (sx + sw > img.width) sw = img.width - sx;
    if (sy + sh > img.height) sh = img.height - sy;
    if (sw > 0 && sh > 0) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img, sx, sy, sw, sh, dx, dy, sw * k, sh * k);
    }
  }

  // GPS route.
  if (st.route.length >= 4) {
    ctx.beginPath();
    for (let i = 0; i + 1 < st.route.length; i += 2) {
      const x = (st.route[i] - st.x) * s;
      const y = (st.route[i + 1] - st.z) * s;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.stroke();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#f5b700';
    ctx.stroke();
  }

  // Blips.
  const blips = st.blips;
  let pedCount = 0;
  let hasWaypointBlip = false;
  for (const b of blips) {
    if (b.kind === 'ped') pedCount++;
    else if (b.kind === 'waypoint') hasWaypointBlip = true;
  }
  const skipPeds = pedCount > 40;
  const sorted = blips.slice().sort((a, b) => blipOrder(a.kind, b.kind));
  const rim = R - 9;
  const phase = Math.floor(performance.now() / 250) % 2;
  const drawAt = (wx: number, wz: number, kind: BlipKind, color?: string, heading?: number) => {
    let x = (wx - st.x) * s;
    let y = (wz - st.z) * s;
    const d = Math.hypot(x, y);
    let clamped = false;
    if (d > rim) {
      if (kind === 'ped' || kind === 'vehicle' || kind === 'pickup' || kind === 'poi') return;
      x = (x / d) * rim;
      y = (y / d) * rim;
      clamped = true;
    }
    ctx.save();
    ctx.translate(x, y);
    if (clamped) ctx.globalAlpha = 0.85;
    if (heading !== undefined && (kind === 'vehicle' || kind === 'police' || kind === 'cop')) ctx.rotate(Math.PI - heading);
    drawBlip(ctx, kind, BLIP_RADIUS[kind], color, phase);
    ctx.restore();
  };
  for (const b of sorted) {
    if (b.kind === 'player') continue;
    if (b.kind === 'ped' && skipPeds) continue;
    drawAt(b.x, b.z, b.kind, b.color, b.heading);
  }
  if (st.waypoint && !hasWaypointBlip) drawAt(st.waypoint.x, st.waypoint.z, 'waypoint');

  // Player arrow (always at the centre).
  ctx.save();
  ctx.rotate(Math.PI - st.yaw);
  drawArrow(ctx, st.inVehicle ? 8 : 7, '#ffffff');
  ctx.restore();

  ctx.restore(); // rotation + clip

  // Inner rim shading.
  ctx.beginPath();
  ctx.arc(R, R, R - 1, 0, TAU);
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.stroke();

  // North indicator on the rim: north (-Z) after rotation lands at (-sin camYaw, cos camYaw).
  const nx = R + (R - 11) * -Math.sin(st.camYaw);
  const ny = R + (R - 11) * Math.cos(st.camYaw);
  ctx.beginPath();
  ctx.arc(nx, ny, 7.5, 0, TAU);
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 10px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', nx, ny + 0.5);
}
