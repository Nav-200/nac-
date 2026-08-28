import React, { useEffect, useRef } from 'react';
import type { Game } from '../Game';
import { driftGradeFor } from '../Game';
import { clamp01 } from '../engine/math';
import { formatTime } from '../race/route';
import type { GamePhase } from '../types';

const MAX_SPEED_KMH = 320;
const GAUGE_START = 150;
const GAUGE_SWEEP = 240;

const polar = (cx: number, cy: number, r: number, deg: number) => {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
};

const arcPath = (cx: number, cy: number, r: number, from: number, to: number): string => {
  const start = polar(cx, cy, r, to);
  const end = polar(cx, cy, r, from);
  const large = to - from <= 180 ? 0 : 1;
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${large} 0 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
};

const TICKS = Array.from({ length: 17 }, (_, i) => {
  const frac = i / 16;
  const angle = GAUGE_START + frac * GAUGE_SWEEP;
  const major = i % 2 === 0;
  const outer = polar(80, 80, 66, angle);
  const inner = polar(80, 80, major ? 55 : 60, angle);
  return { key: i, x1: inner.x, y1: inner.y, x2: outer.x, y2: outer.y, major, label: Math.round(frac * MAX_SPEED_KMH) };
});

interface Props {
  game: Game;
  phase: GamePhase;
}

/**
 * The HUD runs its own animation frame and writes through refs. Driving the
 * needle and the timer from React state would re-render this subtree sixty
 * times a second for no benefit; this way React only renders when the phase
 * changes.
 */
export const Hud: React.FC<Props> = ({ game, phase }) => {
  const speedRef = useRef<HTMLSpanElement>(null);
  const gearRef = useRef<HTMLSpanElement>(null);
  const needleRef = useRef<SVGGElement>(null);
  const rpmRef = useRef<SVGPathElement>(null);
  const timerRef = useRef<HTMLSpanElement>(null);
  const checkpointRef = useRef<HTMLSpanElement>(null);
  const positionRef = useRef<HTMLSpanElement>(null);
  const driftRef = useRef<HTMLDivElement>(null);
  const driftValueRef = useRef<HTMLSpanElement>(null);
  const driftGradeRef = useRef<HTMLSpanElement>(null);
  const countdownRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLDivElement>(null);
  const offroadRef = useRef<HTMLDivElement>(null);
  const minimapRef = useRef<HTMLCanvasElement>(null);

  // Static route layer for the minimap, drawn once.
  const routeLayer = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const size = 128;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const layer = document.createElement('canvas');
    layer.width = size * dpr;
    layer.height = size * dpr;
    const ctx = layer.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const extent = game.mapHalfExtent;
    const toPx = (v: number) => ((v + extent) / (extent * 2)) * (size - 12) + 6;

    const route = game.getRoutePolyline(4);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2.4;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < route.length / 2; i++) {
      const x = toPx(route[i * 2]);
      const y = toPx(route[i * 2 + 1]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();

    routeLayer.current = layer;
  }, [game]);

  useEffect(() => {
    let raf = 0;
    const canvas = minimapRef.current;
    const size = 128;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let ctx: CanvasRenderingContext2D | null = null;
    if (canvas) {
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      ctx = canvas.getContext('2d');
      ctx?.scale(dpr, dpr);
    }
    const gates = game.getGatePositions();
    const extent = game.mapHalfExtent;
    const toPx = (v: number) => ((v + extent) / (extent * 2)) * (size - 12) + 6;

    let lastGrade = '';

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const h = game.hud;

      if (speedRef.current) speedRef.current.textContent = String(Math.round(h.speedKmh));
      if (gearRef.current) gearRef.current.textContent = h.speedKmh < 1 ? 'N' : String(h.gear);

      if (needleRef.current) {
        const frac = clamp01(h.speedKmh / MAX_SPEED_KMH);
        needleRef.current.style.transform = `rotate(${GAUGE_START + frac * GAUGE_SWEEP}deg)`;
      }
      if (rpmRef.current) {
        const to = GAUGE_START + clamp01(h.rpm01) * GAUGE_SWEEP;
        rpmRef.current.setAttribute('d', arcPath(80, 80, 66, GAUGE_START, Math.max(GAUGE_START + 0.5, to)));
        rpmRef.current.setAttribute('stroke', h.rpm01 > 0.86 ? '#ff5d5d' : '#53e0ff');
      }

      if (timerRef.current) timerRef.current.textContent = formatTime(h.raceTime);
      if (checkpointRef.current) {
        checkpointRef.current.textContent = `${h.checkpoint}/${h.checkpointTotal}`;
      }
      if (positionRef.current) positionRef.current.textContent = `${h.position}/${h.racerCount}`;

      if (driftRef.current) {
        const active = h.driftChain > 40;
        driftRef.current.style.opacity = active ? '1' : '0';
        driftRef.current.style.transform = active ? 'translateY(0)' : 'translateY(6px)';
        if (active) {
          if (driftValueRef.current) {
            driftValueRef.current.textContent = h.driftChain.toLocaleString();
          }
          const grade = driftGradeFor(h.driftChain);
          if (grade !== lastGrade && driftGradeRef.current) {
            driftGradeRef.current.textContent = grade;
            lastGrade = grade;
          }
        }
      }

      if (countdownRef.current) {
        if (h.countdown > 0) {
          const n = Math.ceil(h.countdown);
          countdownRef.current.textContent = n > 3 ? 'READY' : String(n);
          countdownRef.current.style.opacity = '1';
          const pulse = 1 - (h.countdown % 1);
          countdownRef.current.style.transform = `scale(${1.35 - pulse * 0.35})`;
        } else if (h.phase === 'racing' && h.raceTime < 1.1) {
          countdownRef.current.textContent = 'GO!';
          countdownRef.current.style.opacity = String(1 - h.raceTime / 1.1);
          countdownRef.current.style.transform = `scale(${1 + h.raceTime * 0.5})`;
        } else {
          countdownRef.current.style.opacity = '0';
        }
      }

      if (promptRef.current) {
        promptRef.current.style.opacity = h.nearStartGate ? '1' : '0';
      }
      if (offroadRef.current) {
        offroadRef.current.style.opacity = h.offRoad && h.speedKmh > 30 ? '1' : '0';
      }

      if (ctx && routeLayer.current) {
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(routeLayer.current, 0, 0, size, size);

        // Gates: the next one pops, the rest are faint markers.
        const next = h.checkpoint;
        for (let i = 0; i < gates.length / 2; i++) {
          const x = toPx(gates[i * 2]);
          const y = toPx(gates[i * 2 + 1]);
          const isNext = i === next && (h.phase === 'racing' || h.phase === 'countdown');
          ctx.beginPath();
          ctx.arc(x, y, isNext ? 4 : 2, 0, Math.PI * 2);
          ctx.fillStyle = isNext ? '#53e0ff' : 'rgba(255,255,255,0.4)';
          ctx.fill();
        }

        // The car, as an arrow pointing the way it is facing.
        const cx = toPx(h.carX);
        const cy = toPx(h.carZ);
        ctx.save();
        ctx.translate(cx, cy);
        // World +Z is down on the map, and heading is measured from +Z.
        ctx.rotate(-h.carHeading);
        ctx.beginPath();
        ctx.moveTo(0, -6);
        ctx.lineTo(4, 4);
        ctx.lineTo(0, 1.6);
        ctx.lineTo(-4, 4);
        ctx.closePath();
        ctx.fillStyle = '#ffce4a';
        ctx.fill();
        ctx.restore();
      }
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [game]);

  const racing = phase === 'racing' || phase === 'countdown';

  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 font-sans text-white"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
      }}
    >
      {/* Minimap */}
      <div className="absolute top-3 left-3 rounded-2xl border border-white/15 bg-black/35 p-1.5 backdrop-blur-md">
        <canvas ref={minimapRef} className="h-24 w-24 sm:h-32 sm:w-32" />
      </div>

      {/* Race readout */}
      <div
        className={`absolute top-3 left-1/2 -translate-x-1/2 rounded-2xl border border-white/15 bg-black/40 px-4 py-2 text-center backdrop-blur-md transition-opacity duration-300 ${
          racing ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <span
          ref={timerRef}
          className="block font-mono text-xl leading-none font-semibold tabular-nums sm:text-2xl"
        >
          0:00.00
        </span>
        <div className="mt-1 flex items-center justify-center gap-3 text-[10px] tracking-widest text-white/65 uppercase">
          <span>
            CP <span ref={checkpointRef} className="text-white">0/0</span>
          </span>
          <span>
            POS <span ref={positionRef} className="text-white">1/1</span>
          </span>
        </div>
      </div>

      {/* Drift chain */}
      <div
        ref={driftRef}
        className="absolute top-[27%] right-3 rounded-xl border border-amber-200/30 bg-amber-500/15 px-3 py-2 text-right opacity-0 backdrop-blur-md transition-all duration-200"
      >
        <span
          ref={driftGradeRef}
          className="block text-[10px] font-bold tracking-[0.2em] text-amber-200"
        >
          DRIFT
        </span>
        <span ref={driftValueRef} className="block font-mono text-lg leading-tight font-bold tabular-nums">
          0
        </span>
      </div>

      {/* Countdown / GO */}
      <div
        ref={countdownRef}
        className="absolute top-[30%] left-1/2 -translate-x-1/2 text-5xl font-black tracking-tight opacity-0 drop-shadow-[0_4px_18px_rgba(0,0,0,0.7)] transition-opacity duration-150 sm:text-7xl"
      />

      {/* Contextual prompts, stacked under the race panel and clear of the car */}
      <div className="absolute top-2 left-1/2 flex -translate-x-1/2 flex-col items-center gap-1.5">
        <div className={racing ? 'h-[52px]' : 'h-0'} />
        <div
          ref={promptRef}
          className="rounded-full border border-cyan-200/40 bg-cyan-400/20 px-4 py-1.5 text-[11px] font-semibold tracking-wide opacity-0 backdrop-blur-md transition-opacity duration-200"
        >
          At the start line
        </div>
        <div
          ref={offroadRef}
          className="rounded-full bg-amber-500/25 px-3 py-1 text-[10px] font-semibold tracking-wide text-amber-100 opacity-0 transition-opacity duration-200"
        >
          OFF ROAD
        </div>
      </div>

      {/* Speedometer */}
      <div className="absolute -bottom-5 left-1/2 -translate-x-1/2 sm:-bottom-3">
        <div className="relative">
          <svg width="116" height="116" viewBox="0 0 160 160" className="drop-shadow-[0_2px_10px_rgba(0,0,0,0.55)]">
            <circle cx="80" cy="80" r="74" fill="rgba(8,12,18,0.42)" />
            <path
              d={arcPath(80, 80, 66, GAUGE_START, GAUGE_START + GAUGE_SWEEP)}
              fill="none"
              stroke="rgba(255,255,255,0.16)"
              strokeWidth="5"
              strokeLinecap="round"
            />
            <path
              ref={rpmRef}
              d={arcPath(80, 80, 66, GAUGE_START, GAUGE_START + 1)}
              fill="none"
              stroke="#53e0ff"
              strokeWidth="5"
              strokeLinecap="round"
            />
            {TICKS.map((t) => (
              <line
                key={t.key}
                x1={t.x1}
                y1={t.y1}
                x2={t.x2}
                y2={t.y2}
                stroke={t.major ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.35)'}
                strokeWidth={t.major ? 2 : 1.2}
                strokeLinecap="round"
              />
            ))}
            <g ref={needleRef} style={{ transformOrigin: '80px 80px' }}>
              <line
                x1="80"
                y1="80"
                x2="80"
                y2="24"
                stroke="#ffce4a"
                strokeWidth="3"
                strokeLinecap="round"
              />
            </g>
            <circle cx="80" cy="80" r="6" fill="#1b2029" stroke="#ffce4a" strokeWidth="2" />
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center pt-5">
            <span
              ref={speedRef}
              className="font-mono text-2xl leading-none font-bold tabular-nums drop-shadow"
            >
              0
            </span>
            <div className="mt-0.5 flex items-baseline gap-1.5">
              <span className="text-[8px] tracking-[0.22em] text-white/55">KM/H</span>
              <span ref={gearRef} className="font-mono text-[11px] font-bold text-cyan-200">
                N
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
