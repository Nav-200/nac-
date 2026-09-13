import { Minus, Plus, RotateCcw, X } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Poi, WorldData } from '../core/types';
import { BLIP_LABELS, blipOrder, drawArrow, drawBlip } from './blipGlyphs';
import { useBridge, useHud } from './hooks';
import { FULLMAP_PX_PER_METER, mapToWorld, renderMapImage, worldToMap } from './minimapImage';
import { BTN_SMALL, BTN_SMALL_ACCENT, LABEL } from './styles';
import { getUiBridge, type BlipKind, type MinimapState, type MissionSummary } from './uiBridge';

interface View {
  zoom: number;
  /** Image-px coordinate shown at the viewport centre. */
  cx: number;
  cy: number;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

const POI_COLORS: Record<Poi['icon'], string> = {
  hospital: '#ffffff',
  police: '#60a5fa',
  gun: '#166534',
  taxi: '#facc15',
  airport: '#cbd5e1',
  harbor: '#38bdf8',
  park: '#4ade80',
  beach: '#fde68a',
  plaza: '#e5e7eb',
  spawn: '#ffffff',
  garage: '#f472b6',
};

const LEGEND: { kind: BlipKind; label: string }[] = [
  { kind: 'player', label: 'You' },
  { kind: 'waypoint', label: BLIP_LABELS.waypoint },
  { kind: 'mission', label: BLIP_LABELS.mission },
  { kind: 'objective', label: BLIP_LABELS.objective },
  { kind: 'target', label: BLIP_LABELS.target },
  { kind: 'police', label: BLIP_LABELS.police },
  { kind: 'gunshop', label: BLIP_LABELS.gunshop },
  { kind: 'hospital', label: BLIP_LABELS.hospital },
  { kind: 'pickup', label: BLIP_LABELS.pickup },
  { kind: 'vehicle', label: BLIP_LABELS.vehicle },
  { kind: 'poi', label: BLIP_LABELS.poi },
];

export function FullMap() {
  const bridge = useBridge();
  const hud = useHud();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = useRef<View>({ zoom: 1, cx: 0, cy: 0 });
  const imgRef = useRef<HTMLCanvasElement | null>(null);
  const missionsRef = useRef<MissionSummary[]>([]);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  const [zoomUi, setZoomUi] = useState(1);
  const [waypoint, setWaypoint] = useState<{ x: number; z: number } | null>(null);
  const [missions, setMissions] = useState<MissionSummary[]>([]);

  useEffect(() => {
    if (!bridge) return;
    const list = bridge.missions();
    missionsRef.current = list;
    setMissions(list);
  }, [bridge, hud.stats.missionsDone]);

  // Drawing loop — reads bridge.minimap() directly, no React state in the hot path.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let world: WorldData | null = null;
    let lastWp = '';
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      if (cw === 0 || ch === 0) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const pw = Math.round(cw * dpr);
      const ph = Math.round(ch * dpr);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const b = getUiBridge();
      if (!b) {
        ctx.fillStyle = '#060a14';
        ctx.fillRect(0, 0, cw, ch);
        return;
      }
      if (!world) {
        world = b.world();
        if (world) {
          imgRef.current = renderMapImage(world, FULLMAP_PX_PER_METER);
          view.current.cx = imgRef.current.width / 2;
          view.current.cy = imgRef.current.height / 2;
        }
      }
      const st = b.minimap();
      drawFullMap(ctx, cw, ch, imgRef.current, world, st, view.current, missionsRef.current);
      const key = st.waypoint ? `${Math.round(st.waypoint.x)},${Math.round(st.waypoint.z)}` : '';
      if (key !== lastWp) {
        lastWp = key;
        setWaypoint(st.waypoint ? { x: st.waypoint.x, z: st.waypoint.z } : null);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Wheel zoom (non-passive so we can prevent page scroll).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const img = imgRef.current;
      if (!img) return;
      const rect = container.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const v = view.current;
      const kFit = Math.min(rect.width, rect.height) / img.width;
      const K0 = kFit * v.zoom;
      const px = (mx - rect.width / 2) / K0 + v.cx;
      const py = (my - rect.height / 2) / K0 + v.cy;
      const zoom = clamp(v.zoom * Math.exp(-e.deltaY * 0.0015), MIN_ZOOM, MAX_ZOOM);
      const K1 = kFit * zoom;
      v.zoom = zoom;
      v.cx = px - (mx - rect.width / 2) / K1;
      v.cy = py - (my - rect.height / 2) / K1;
      clampView(v, img.width, rect.width, rect.height, K1);
      setZoomUi(zoom);
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, []);

  const setZoom = (zoom: number) => {
    const container = containerRef.current;
    const img = imgRef.current;
    const v = view.current;
    v.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    if (container && img) {
      const kFit = Math.min(container.clientWidth, container.clientHeight) / img.width;
      clampView(v, img.width, container.clientWidth, container.clientHeight, kFit * v.zoom);
    }
    setZoomUi(v.zoom);
  };

  const screenToWorld = (clientX: number, clientY: number): { x: number; z: number } | null => {
    const container = containerRef.current;
    const img = imgRef.current;
    if (!container || !img) return null;
    const rect = container.getBoundingClientRect();
    const v = view.current;
    const K = (Math.min(rect.width, rect.height) / img.width) * v.zoom;
    const mx = (clientX - rect.left - rect.width / 2) / K + v.cx;
    const my = (clientY - rect.top - rect.height / 2) / K + v.cy;
    return mapToWorld(mx, my, FULLMAP_PX_PER_METER);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, cx: view.current.cx, cy: view.current.cy, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const img = imgRef.current;
    const container = containerRef.current;
    if (!d || !img || !container) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    const rect = container.getBoundingClientRect();
    const K = (Math.min(rect.width, rect.height) / img.width) * view.current.zoom;
    view.current.cx = d.cx - dx / K;
    view.current.cy = d.cy - dy / K;
    clampView(view.current, img.width, rect.width, rect.height, K);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved || e.button !== 0) return;
    const w = screenToWorld(e.clientX, e.clientY);
    if (w) getUiBridge()?.setWaypoint(w.x, w.z);
  };

  const close = () => getUiBridge()?.toggleMap();

  return (
    <div className="fixed inset-0 z-20 select-none text-white flex bg-[#04070d]/92 backdrop-blur-sm">
      {/* Map viewport */}
      <div
        ref={containerRef}
        className="relative flex-1 min-w-0 overflow-hidden cursor-crosshair touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (drag.current = null)}
        onContextMenu={(e) => {
          e.preventDefault();
          getUiBridge()?.clearWaypoint();
        }}
      >
        <canvas ref={canvasRef} className="absolute inset-0 block" style={{ width: '100%', height: '100%' }} />
        <div className="absolute top-3 left-3 flex items-center gap-3 pointer-events-none">
          <div className="gta-font text-4xl tracking-wider hud-text-strong">MAP</div>
          <div className="hidden md:flex items-center gap-2 text-xs text-white/70 hud-text bg-black/40 rounded px-2 py-1 border border-white/10">
            <span>
              <kbd className="kbd">Click</kbd> waypoint
            </span>
            <span>
              <kbd className="kbd">Right-click</kbd> clear
            </span>
            <span>
              <kbd className="kbd">Wheel</kbd> zoom
            </span>
            <span>
              <kbd className="kbd">Drag</kbd> pan
            </span>
            <span>
              <kbd className="kbd">M</kbd> close
            </span>
          </div>
        </div>
        <div className="absolute bottom-3 left-3 flex items-center gap-1 bg-black/50 rounded-md border border-white/10 p-1">
          <button className={BTN_SMALL} onClick={() => setZoom(zoomUi / 1.25)} disabled={zoomUi <= MIN_ZOOM} aria-label="Zoom out">
            <Minus size={14} />
          </button>
          <div className="w-12 text-center text-xs tabular-nums text-white/80">{zoomUi.toFixed(1)}×</div>
          <button className={BTN_SMALL} onClick={() => setZoom(zoomUi * 1.25)} disabled={zoomUi >= MAX_ZOOM} aria-label="Zoom in">
            <Plus size={14} />
          </button>
          <button className={BTN_SMALL} onClick={() => setZoom(1)} aria-label="Reset zoom">
            <RotateCcw size={14} />
          </button>
        </div>
        <div className="absolute bottom-3 right-3 text-xs text-white/60 hud-text pointer-events-none">
          {hud.clock} · {hud.district}
        </div>
      </div>

      {/* Side panel */}
      <aside className="w-64 lg:w-72 shrink-0 flex flex-col border-l border-white/10 bg-[#0b0e14]/95">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <div className={LABEL}>Navigation</div>
          <button className={`${BTN_SMALL} flex items-center gap-1`} onClick={close}>
            <X size={14} /> Close
          </button>
        </div>

        <div className="px-4 py-3 border-b border-white/10">
          <div className={LABEL}>Waypoint</div>
          {waypoint ? (
            <div className="mt-1 flex items-center justify-between gap-2">
              <div className="text-sm text-purple-300 tabular-nums">
                {Math.round(waypoint.x)}, {Math.round(waypoint.z)}
                {hud.waypointDist >= 0 && <span className="text-white/60"> · {formatDistance(hud.waypointDist)}</span>}
              </div>
              <button className={BTN_SMALL} onClick={() => getUiBridge()?.clearWaypoint()}>
                Clear
              </button>
            </div>
          ) : (
            <div className="mt-1 text-sm text-white/55">Click the map to set a waypoint. The GPS route shows on your radar.</div>
          )}
        </div>

        <div className="px-4 py-3 border-b border-white/10">
          <div className={LABEL}>Legend</div>
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
            {LEGEND.map((l) => (
              <div key={l.kind} className="flex items-center gap-2 text-xs text-white/80">
                <LegendSwatch kind={l.kind} />
                <span className="truncate">{l.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex-1 min-h-0 flex flex-col">
          <div className="px-4 pt-3 pb-1 flex items-baseline justify-between">
            <div className={LABEL}>Missions</div>
            <div className="text-xs text-white/50 tabular-nums">
              {missions.filter((m) => m.done).length}/{missions.length}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto oc-scroll px-2 pb-2">
            {missions.length === 0 && <div className="px-2 py-2 text-sm text-white/45">No missions known yet.</div>}
            {missions.map((m) => (
              <button
                key={m.id}
                className="w-full text-left px-2 py-1.5 rounded hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#f5b700] flex items-center gap-2"
                onClick={() => getUiBridge()?.setWaypoint(m.x, m.z)}
                title="Set waypoint"
              >
                <span className={`w-2.5 h-2.5 rotate-45 shrink-0 ${m.done ? 'bg-white/30' : 'bg-[#f5b700]'}`} />
                <span className="flex-1 min-w-0">
                  <span className={`block text-sm truncate ${m.done ? 'text-white/50 line-through' : 'text-white'}`}>{m.title}</span>
                  <span className="block text-[10px] uppercase tracking-wider text-white/45">
                    {m.type}
                    {m.bestTime !== null && ` · best ${m.bestTime.toFixed(1)}s`}
                  </span>
                </span>
                {m.done && <span className="text-green-400 text-sm">✓</span>}
              </button>
            ))}
          </div>
        </div>

        <div className="p-3 border-t border-white/10">
          <button className={`${BTN_SMALL_ACCENT} w-full py-2`} onClick={close}>
            Back to game
          </button>
        </div>
      </aside>
    </div>
  );
}

function LegendSwatch({ kind }: { kind: BlipKind }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = 16 * dpr;
    c.height = 16 * dpr;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(8, 8);
    if (kind === 'player') drawArrow(ctx, 6);
    else drawBlip(ctx, kind, 5);
  }, [kind]);
  return <canvas ref={ref} style={{ width: 16, height: 16 }} className="shrink-0" />;
}

// ------------------------------------------------------------------ drawing

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clampView(v: View, imgSize: number, cw: number, ch: number, K: number): void {
  const hw = cw / 2 / K;
  const hh = ch / 2 / K;
  v.cx = imgSize <= hw * 2 ? imgSize / 2 : clamp(v.cx, hw, imgSize - hw);
  v.cy = imgSize <= hh * 2 ? imgSize / 2 : clamp(v.cy, hh, imgSize - hh);
}

function drawFullMap(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  img: HTMLCanvasElement | null,
  world: WorldData | null,
  st: MinimapState,
  v: View,
  missions: MissionSummary[],
): void {
  ctx.fillStyle = '#060a14';
  ctx.fillRect(0, 0, cw, ch);
  if (!img || !world) {
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '14px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Loading map…', cw / 2, ch / 2);
    return;
  }
  const kFit = Math.min(cw, ch) / img.width;
  const K = kFit * v.zoom;
  clampView(v, img.width, cw, ch, K);
  const ox = cw / 2 - v.cx * K;
  const oy = ch / 2 - v.cy * K;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, ox, oy, img.width * K, img.height * K);

  const toScreen = (x: number, z: number): [number, number] => {
    const m = worldToMap(x, z, FULLMAP_PX_PER_METER);
    return [m.x * K + ox, m.y * K + oy];
  };
  const glyphScale = 1 + (v.zoom - 1) * 0.15;
  const phase = Math.floor(performance.now() / 250) % 2;

  ctx.font = 'bold 11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const rawLabel = (text: string, x: number, y: number, color = '#ffffff') => {
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  };
  // Greedy label placement: try right, left, below the glyph; skip if everything collides.
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  const collides = (x: number, y: number, w: number, h: number) => placed.some((r) => x < r.x + r.w + 2 && x + w + 2 > r.x && y < r.y + r.h + 2 && y + h + 2 > r.y);
  const seen = new Set<string>();
  const label = (text: string, ax: number, ay: number, r: number, color = '#ffffff') => {
    // Missions can arrive both from the mission list and as live blips with the same title.
    const key = text.replace(' ✓', '');
    if (seen.has(key)) return;
    seen.add(key);
    const w = ctx.measureText(text).width;
    const h = 12;
    const candidates: [number, number][] = [
      [ax + r + 4, ay],
      [ax - r - 4 - w, ay],
      [ax - w / 2, ay + r + 9],
    ];
    for (const [x, y] of candidates) {
      if (collides(x, y - h / 2, w, h)) continue;
      placed.push({ x, y: y - h / 2, w, h });
      rawLabel(text, x, y, color);
      return;
    }
  };

  // Route
  if (st.route.length >= 4) {
    ctx.beginPath();
    for (let i = 0; i + 1 < st.route.length; i += 2) {
      const [x, y] = toScreen(st.route[i], st.route[i + 1]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#f5b700';
    ctx.stroke();
  }

  // Keep labels off the player arrow.
  {
    const [px, py] = toScreen(st.x, st.z);
    placed.push({ x: px - 12, y: py - 12, w: 24, h: 24 });
  }

  // Points of interest with names
  for (const p of world.poi) {
    const [x, y] = toScreen(p.x, p.z);
    if (x < -40 || y < -40 || x > cw + 40 || y > ch + 40) continue;
    const kind: BlipKind = p.icon === 'hospital' ? 'hospital' : p.icon === 'gun' ? 'gunshop' : 'poi';
    const r = (kind === 'poi' ? 5 : 6) * glyphScale;
    ctx.save();
    ctx.translate(x, y);
    drawBlip(ctx, kind, r, kind === 'poi' ? POI_COLORS[p.icon] : undefined);
    ctx.restore();
    label(p.name, x, y, r, 'rgba(255,255,255,0.92)');
  }

  // Missions with titles
  const missionList = missions.length > 0 ? missions : world.missions.map((m) => ({ id: m.id, title: m.title, type: m.type, x: m.x, z: m.z, done: false, bestTime: null }));
  for (const m of missionList) {
    const [x, y] = toScreen(m.x, m.z);
    if (x < -40 || y < -40 || x > cw + 40 || y > ch + 40) continue;
    const r = 6.5 * glyphScale;
    ctx.save();
    ctx.translate(x, y);
    drawBlip(ctx, 'mission', r, m.done ? '#6b7280' : '#f5b700');
    ctx.restore();
    label(m.done ? `${m.title} ✓` : m.title, x, y, r, m.done ? 'rgba(255,255,255,0.6)' : '#ffe082');
  }

  // Live blips (skip pedestrians and POI duplicates — POIs are drawn above with labels)
  const sorted = st.blips.filter((b) => b.kind !== 'ped' && b.kind !== 'player' && b.kind !== 'poi').sort((a, b) => blipOrder(a.kind, b.kind));
  let hasWaypointBlip = false;
  for (const b of sorted) {
    if (b.kind === 'waypoint') hasWaypointBlip = true;
    const [x, y] = toScreen(b.x, b.z);
    if (x < -20 || y < -20 || x > cw + 20 || y > ch + 20) continue;
    const r = (b.kind === 'waypoint' || b.kind === 'objective' || b.kind === 'target' ? 7 : b.kind === 'vehicle' ? 3.5 : 5) * glyphScale;
    ctx.save();
    ctx.translate(x, y);
    if (b.heading !== undefined && (b.kind === 'vehicle' || b.kind === 'police' || b.kind === 'cop')) ctx.rotate(Math.PI - b.heading);
    drawBlip(ctx, b.kind, r, b.color, phase);
    ctx.restore();
    if (b.label) label(b.label, x, y, r);
  }
  if (st.waypoint && !hasWaypointBlip) {
    const [x, y] = toScreen(st.waypoint.x, st.waypoint.z);
    ctx.save();
    ctx.translate(x, y);
    drawBlip(ctx, 'waypoint', 7 * glyphScale);
    ctx.restore();
    label('Waypoint', x, y, 7 * glyphScale, '#e9d5ff');
  }

  // Player
  {
    const [x, y] = toScreen(st.x, st.z);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI - st.yaw);
    drawArrow(ctx, 9 * glyphScale, '#ffffff');
    ctx.restore();
  }

  // Scale bar
  {
    const metres = 200;
    const len = metres * FULLMAP_PX_PER_METER * K;
    const x0 = cw - 20 - len;
    const y0 = ch - 46;
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + len, y0);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.textAlign = 'right';
    rawLabel(`${metres} m`, cw - 20, y0 - 10);
    ctx.textAlign = 'left';
  }

  // North arrow (top-right)
  {
    const x = cw - 24;
    const y = 28;
    ctx.save();
    ctx.translate(x, y);
    drawArrow(ctx, 9, '#f5b700');
    ctx.restore();
    ctx.textAlign = 'center';
    rawLabel('N', x, y + 20);
    ctx.textAlign = 'left';
  }
}

function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}
