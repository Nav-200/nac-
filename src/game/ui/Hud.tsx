import { MapPin, Radio, Star } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { HudMission, HudNotification, HudState } from '../core/store';
import { useBridge, useHud, useMediaQuery } from './hooks';
import { Minimap } from './Minimap';
import { PANEL_SOFT, formatMoney, formatTimer } from './styles';
import { WeaponIcon } from './WeaponIcon';

/** Survives HUD remounts (pause/resume) so the hint only shows for the first ~20 s. */
let hintDismissed = false;

interface Props {
  /** Hidden while the full-screen map is open (it has its own drawing loop). */
  showMinimap?: boolean;
}

export function Hud({ showMinimap = true }: Props) {
  const hud = useHud();
  const bridge = useBridge();
  const compact = useMediaQuery('(max-width: 1000px)');
  const showFps = bridge?.settings().showFps ?? false;
  const lowHealth = hud.health < 25;

  return (
    <div className="fixed inset-0 z-10 pointer-events-none select-none text-white overflow-hidden">
      {/* Vignettes */}
      {hud.damageFlash > 0 && (
        <div
          className="absolute inset-0"
          style={{ opacity: Math.min(1, hud.damageFlash), background: 'radial-gradient(ellipse at center, rgba(220,20,20,0) 35%, rgba(220,20,20,0.85) 100%)' }}
        />
      )}
      {lowHealth && <div className="absolute inset-0 low-health-pulse" style={{ background: 'radial-gradient(ellipse at center, rgba(170,0,0,0) 45%, rgba(170,0,0,0.85) 100%)' }} />}

      {/* Top-left: fps + mission */}
      <div className="absolute top-3 left-3 md:top-4 md:left-4 flex flex-col gap-2 items-start">
        {showFps && <div className="font-mono text-xs text-white/70 hud-text bg-black/40 rounded px-1.5 py-0.5">{hud.fps} FPS</div>}
        {hud.mission?.active && <MissionPanel m={hud.mission} />}
      </div>

      {/* Top-right: money, stars, clock, weapon */}
      <div className="absolute top-3 right-3 md:top-4 md:right-4 flex flex-col items-end gap-1.5">
        <MoneyDisplay money={hud.money} />
        <WantedStars wanted={hud.wanted} flash={hud.wantedFlash} />
        <div className="flex items-center gap-2 text-sm hud-text">
          <span className="gta-font text-xl tabular-nums tracking-wider">{hud.clock}</span>
          {hud.district && (
            <>
              <span className="text-white/40">·</span>
              <span className="uppercase tracking-[0.15em] text-[11px] font-semibold text-white/80">{hud.district}</span>
            </>
          )}
        </div>
        <WeaponPanel hud={hud} />
      </div>

      {/* Right-middle: notifications */}
      {hud.notifications.length > 0 && (
        <div className="absolute right-3 md:right-4 top-[48%] flex flex-col items-end gap-1.5 max-w-[min(340px,60vw)]">
          {hud.notifications.map((n) => (
            <Notification key={n.id} n={n} />
          ))}
        </div>
      )}

      {/* Centre: big text, crosshair, hit marker */}
      {hud.bigText && (
        <div key={hud.bigText.until} className="absolute inset-x-0 top-[30%] flex flex-col items-center big-text-in px-4 text-center">
          <div className="gta-font hud-text-strong uppercase leading-none" style={{ color: hud.bigText.color, fontSize: 'clamp(2.25rem, 7vw, 6.5rem)' }}>
            {hud.bigText.title}
          </div>
          {hud.bigText.sub && <div className="mt-3 uppercase tracking-[0.2em] text-white/90 hud-text" style={{ fontSize: 'clamp(0.95rem, 1.6vw, 1.5rem)' }}>{hud.bigText.sub}</div>}
        </div>
      )}
      {hud.crosshair && <Crosshair expanded={hud.inVehicle || hud.reloading} />}
      {hud.hitMarker > 0 && <HitMarker />}

      {/* Bottom-centre: interact prompt */}
      {hud.interactPrompt && (
        <div className="absolute left-1/2 bottom-[20%] -translate-x-1/2 fade-in">
          <div className="bg-black/65 backdrop-blur-sm border border-white/20 rounded-full px-4 py-1.5 text-sm font-semibold hud-text whitespace-nowrap">
            <PromptText text={hud.interactPrompt} />
          </div>
        </div>
      )}

      {/* Bottom-left: minimap, bars, vehicle */}
      <div className="absolute bottom-3 left-3 md:bottom-4 md:left-4 flex items-end gap-3">
        <div className="flex flex-col gap-1.5">
          {hud.waypointDist >= 0 && (
            <div className="flex items-center gap-1 text-xs font-semibold text-purple-300 hud-text">
              <MapPin size={12} />
              {formatDistance(hud.waypointDist)}
            </div>
          )}
          {showMinimap && <Minimap size={compact ? 160 : 200} />}
          <div className="flex flex-col gap-1" style={{ width: compact ? 160 : 200 }}>
            <HealthBar value={hud.health} max={hud.maxHealth} />
            <ArmorBar value={hud.armor} />
          </div>
        </div>
        {hud.inVehicle && <VehiclePanel hud={hud} />}
      </div>

      <Hint />
    </div>
  );
}

// ------------------------------------------------------------------ pieces

function MoneyDisplay({ money }: { money: number }) {
  const prev = useRef(money);
  const [flash, setFlash] = useState<{ up: boolean; delta: number; key: number } | null>(null);
  useEffect(() => {
    const d = money - prev.current;
    prev.current = money;
    if (d === 0) return;
    setFlash({ up: d > 0, delta: d, key: Date.now() });
    const t = window.setTimeout(() => setFlash(null), 1400);
    return () => window.clearTimeout(t);
  }, [money]);
  const color = flash ? (flash.up ? 'text-green-400' : 'text-red-400') : 'text-white';
  return (
    <div className="relative flex flex-col items-end">
      <div key={flash?.key ?? 0} className={`gta-font text-3xl md:text-4xl leading-none hud-text-strong tabular-nums ${color} ${flash ? 'money-pop' : ''}`}>
        {formatMoney(money)}
      </div>
      {flash && (
        <div className={`absolute top-full mt-0.5 right-0 text-xs font-bold fade-in hud-text ${flash.up ? 'text-green-300' : 'text-red-300'}`}>
          {flash.up ? '+' : '−'}
          {formatMoney(Math.abs(flash.delta))}
        </div>
      )}
    </div>
  );
}

function WantedStars({ wanted, flash }: { wanted: number; flash: boolean }) {
  return (
    <div className="flex gap-0.5 justify-end mt-1" aria-label={`Wanted level ${wanted}`}>
      {[0, 1, 2, 3, 4].map((i) => {
        const filled = i < wanted;
        return (
          <Star
            key={i}
            size={22}
            strokeWidth={2}
            fill={filled ? '#f5b700' : 'none'}
            className={`drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)] ${filled ? 'text-[#f5b700]' : 'text-white/35'} ${filled && flash ? 'hud-pulse' : ''}`}
          />
        );
      })}
    </div>
  );
}

function WeaponPanel({ hud }: { hud: HudState }) {
  const melee = hud.weaponId === 'fist' || hud.weaponId === 'bat' || (hud.clipSize === 0 && hud.ammoReserve === 0);
  return (
    <div className={`${PANEL_SOFT} flex items-center gap-3 px-3 py-2 min-w-[190px] mt-1`}>
      <WeaponIcon id={hud.weaponId} className="w-14 h-7 text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.9)]" title={hud.weaponName} />
      <div className="flex flex-col items-end flex-1 leading-none">
        <div className="text-[11px] uppercase tracking-[0.18em] text-white/70 font-semibold mb-1">{hud.weaponName}</div>
        {melee ? (
          <div className="gta-font text-lg text-white/50 tracking-wider">MELEE</div>
        ) : hud.reloading ? (
          <div className="gta-font text-xl text-[#f5b700] hud-pulse tracking-wider">RELOADING</div>
        ) : (
          <div className="gta-font text-2xl tabular-nums hud-text">
            <span className={hud.ammoInClip === 0 ? 'text-red-400' : ''}>{hud.ammoInClip}</span>
            <span className="text-white/50 text-lg"> / {hud.ammoReserve}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function HealthBar({ value, max }: { value: number; max: number }) {
  const pct = Math.max(0, Math.min(100, (value / Math.max(1, max)) * 100));
  return (
    <div className="h-2.5 rounded-sm bg-black/65 border border-white/20 overflow-hidden shadow" title={`Health ${Math.round(value)}`}>
      <div
        className="h-full transition-[clip-path] duration-200"
        style={{ background: 'linear-gradient(90deg, #dc2626 0%, #f59e0b 45%, #22c55e 100%)', clipPath: `inset(0 ${100 - pct}% 0 0)` }}
      />
    </div>
  );
}

function ArmorBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="h-2 rounded-sm bg-black/65 border border-white/20 overflow-hidden shadow" title={`Armor ${Math.round(value)}`}>
      <div className="h-full transition-[width] duration-200" style={{ width: `${pct}%`, background: 'linear-gradient(90deg, #2563eb, #60a5fa)' }} />
    </div>
  );
}

function VehiclePanel({ hud }: { hud: HudState }) {
  const vh = Math.max(0, Math.min(1, hud.vehicleHealth));
  const vhColor = vh > 0.5 ? '#22c55e' : vh > 0.25 ? '#f59e0b' : '#ef4444';
  return (
    <div className="flex flex-col gap-1 pb-1 fade-in">
      <div className="text-[11px] uppercase tracking-[0.18em] text-white/75 font-semibold hud-text">{hud.vehicleName || 'Vehicle'}</div>
      <div className="flex items-end gap-2">
        <div className="gta-font text-5xl leading-none tabular-nums hud-text-strong">{Math.round(Math.abs(hud.speedKmh))}</div>
        <div className="text-xs text-white/60 mb-1 hud-text">km/h</div>
        <HeadlightIcon on={hud.headlights} />
      </div>
      <div className="h-1.5 w-28 rounded-sm bg-black/65 border border-white/20 overflow-hidden" title="Vehicle condition">
        <div className="h-full" style={{ width: `${vh * 100}%`, background: vhColor }} />
      </div>
      <div className="flex items-center gap-1.5 text-xs text-white/75 hud-text">
        <Radio size={12} className={hud.radioName && hud.radioName !== 'Off' ? 'text-[#f5b700]' : 'text-white/40'} />
        <span className="truncate max-w-[140px]">{hud.radioName || 'Off'}</span>
      </div>
    </div>
  );
}

function HeadlightIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 28 16" width="28" height="16" className={`mb-1 ${on ? 'text-[#f5b700]' : 'text-white/30'}`} aria-label={on ? 'Headlights on' : 'Headlights off'}>
      <path d="M10 2 a6 6 0 0 0 0 12 h3 v-12 z" fill="currentColor" />
      <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <line x1="16" y1="4" x2="26" y2="3" />
        <line x1="16" y1="8" x2="26" y2="8" />
        <line x1="16" y1="12" x2="26" y2="13" />
      </g>
    </svg>
  );
}

function Crosshair({ expanded }: { expanded: boolean }) {
  const gap = expanded ? 9 : 5;
  const len = 7;
  const ticks = [
    { x1: 0, y1: -gap, x2: 0, y2: -gap - len },
    { x1: 0, y1: gap, x2: 0, y2: gap + len },
    { x1: -gap, y1: 0, x2: -gap - len, y2: 0 },
    { x1: gap, y1: 0, x2: gap + len, y2: 0 },
  ];
  return (
    <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
      <svg viewBox="-22 -22 44 44" width="44" height="44">
        <g stroke="rgba(0,0,0,0.7)" strokeWidth="4" strokeLinecap="round">
          {ticks.map((t, i) => (
            <line key={i} {...t} style={{ transition: 'all 0.12s ease-out' }} />
          ))}
        </g>
        <g stroke="#fff" strokeWidth="2" strokeLinecap="round">
          {ticks.map((t, i) => (
            <line key={i} {...t} style={{ transition: 'all 0.12s ease-out' }} />
          ))}
        </g>
        <circle r="1.7" fill="#fff" stroke="rgba(0,0,0,0.7)" strokeWidth="1" />
      </svg>
    </div>
  );
}

function HitMarker() {
  return (
    <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
      <svg viewBox="-16 -16 32 32" width="32" height="32">
        <g stroke="rgba(0,0,0,0.7)" strokeWidth="4" strokeLinecap="round">
          <line x1="-11" y1="-11" x2="-4" y2="-4" />
          <line x1="11" y1="-11" x2="4" y2="-4" />
          <line x1="-11" y1="11" x2="-4" y2="4" />
          <line x1="11" y1="11" x2="4" y2="4" />
        </g>
        <g stroke="#ff5a5a" strokeWidth="2.2" strokeLinecap="round">
          <line x1="-11" y1="-11" x2="-4" y2="-4" />
          <line x1="11" y1="-11" x2="4" y2="-4" />
          <line x1="-11" y1="11" x2="-4" y2="4" />
          <line x1="11" y1="11" x2="4" y2="4" />
        </g>
      </svg>
    </div>
  );
}

function MissionPanel({ m }: { m: HudMission }) {
  const urgent = m.timeLeft !== null && m.timeLeft < 10;
  return (
    <div className={`${PANEL_SOFT} px-3 py-2 min-w-[230px] max-w-[min(340px,70vw)] fade-in border-l-4 border-l-[#f5b700]`}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="gta-font text-xl tracking-wide text-[#f5b700] hud-text truncate">{m.title}</div>
        {m.timeLeft !== null && <div className={`gta-font text-xl tabular-nums ${urgent ? 'text-red-400 hud-pulse' : 'text-white'}`}>{formatTimer(m.timeLeft)}</div>}
      </div>
      <div className="text-sm text-white/90 hud-text leading-snug">{m.objective}</div>
      <div className="flex justify-between gap-3 text-[11px] uppercase tracking-wider text-white/55 mt-1">
        <span>{m.progress}</span>
        {m.reward > 0 && <span className="text-green-400/80">Reward {formatMoney(m.reward)}</span>}
      </div>
    </div>
  );
}

const NOTIF_CLS: Record<HudNotification['kind'], string> = {
  money: 'text-green-400 border-green-400',
  mission: 'text-[#f5b700] border-[#f5b700]',
  warning: 'text-red-400 border-red-400',
  info: 'text-white border-white/60',
};

function Notification({ n }: { n: HudNotification }) {
  return <div className={`fade-in bg-black/55 backdrop-blur-sm border-r-4 rounded px-3 py-1.5 text-sm font-semibold hud-text text-right ${NOTIF_CLS[n.kind]}`}>{n.text}</div>;
}

function PromptText({ text }: { text: string }) {
  const m = /^(Press|Hold)\s+(\S+)\s+(.*)$/i.exec(text);
  if (!m) return <>{text}</>;
  return (
    <>
      {m[1]} <kbd className="kbd">{m[2]}</kbd> {m[3]}
    </>
  );
}

function Hint() {
  const [show, setShow] = useState(!hintDismissed);
  useEffect(() => {
    if (!show) return;
    const t = window.setTimeout(() => {
      hintDismissed = true;
      setShow(false);
    }, 20000);
    return () => window.clearTimeout(t);
  }, [show]);
  if (!show) return null;
  const items: [string, string][] = [
    ['WASD', 'move'],
    ['Shift', 'sprint'],
    ['F', 'enter car'],
    ['Mouse', 'aim'],
    ['LMB', 'fire'],
    ['M', 'map'],
    ['Esc', 'menu'],
  ];
  return (
    <div className="absolute bottom-3 right-3 md:bottom-4 md:right-4 hint-in text-xs text-white/70 hud-text bg-black/45 rounded-md px-3 py-1.5 border border-white/10 max-w-[min(520px,70vw)] text-right leading-relaxed">
      {items.map(([k, v], i) => (
        <span key={k} className="whitespace-nowrap">
          <kbd className="kbd">{k}</kbd> {v}
          {i < items.length - 1 && <span className="text-white/30 mx-1">·</span>}
        </span>
      ))}
    </div>
  );
}

function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}
