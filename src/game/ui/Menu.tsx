import React from 'react';
import type { RivalResult } from '../race/opponents';
import { EVENTS, formatTime } from '../race/route';
import type { StoredSettings } from '../settings';
import { CARS, carStats, type CarSpec } from '../types';
import type { TimeOfDay } from '../world/sky';

/** Set by the artifact wrapper: sandboxed hosting, so no tilt permission and
 * no simulator route to link to. */
const IS_ARTIFACT =
  typeof window !== 'undefined' &&
  Boolean((window as unknown as { __HR_ARTIFACT__?: boolean }).__HR_ARTIFACT__);

const TIMES: Array<{ id: TimeOfDay; label: string }> = [
  { id: 'dawn', label: 'Dawn' },
  { id: 'golden', label: 'Golden' },
  { id: 'noon', label: 'Noon' },
  { id: 'dusk', label: 'Dusk' },
  { id: 'night', label: 'Night' },
];

const panel =
  'rounded-3xl border border-white/12 bg-[#0b0f16]/80 backdrop-blur-xl shadow-[0_20px_60px_rgba(0,0,0,0.5)]';

const primaryButton =
  'w-full rounded-2xl px-5 py-3 text-sm font-black tracking-[0.14em] uppercase transition ' +
  'active:scale-[0.98] disabled:opacity-40';

/** Same look, but short enough that three of them fit a landscape phone. */
const compactButton =
  'w-full rounded-xl px-3 py-2.5 text-[11px] font-black tracking-[0.12em] uppercase transition ' +
  'active:scale-[0.98]';

const Chip: React.FC<{
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ active, onClick, children }) => (
  <button
    onClick={onClick}
    className={`rounded-full border px-3 py-1.5 text-[11px] font-semibold tracking-wide transition active:scale-95 ${
      active
        ? 'border-cyan-300/60 bg-cyan-400/25 text-cyan-50'
        : 'border-white/12 bg-white/5 text-white/60'
    }`}
  >
    {children}
  </button>
);

const StatBar: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <div className="flex items-center gap-1">
    <span className="w-3 text-[7px] font-bold text-white/40">{label}</span>
    <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
      <div
        className="h-full rounded-full bg-cyan-300/80"
        style={{ width: `${Math.round(Math.min(1, Math.max(0.06, value)) * 100)}%` }}
      />
    </div>
  </div>
);

interface StartProps {
  settings: StoredSettings;
  onSettings: (patch: Partial<StoredSettings>) => void;
  /** Session-aware best-time lookup (falls back to storage). */
  bestFor: (eventId: string) => number | null;
  onDrive: () => void;
  onRace: () => void;
}

export const StartScreen: React.FC<StartProps> = ({
  settings, onSettings, bestFor, onDrive, onRace,
}) => {
  const car: CarSpec = CARS.find((c) => c.id === settings.carId) ?? CARS[0];
  const best = bestFor(settings.eventId);
  return (
    <div className="pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-gradient-to-b from-black/70 via-black/45 to-black/80 p-3">
      {/*
        Two columns from the small breakpoint up. A phone held in landscape is
        only ~390px tall, so a single stacked column would run off the screen —
        the settings sit beside the title rather than under it.
      */}
      <div
        className={`${panel} grid w-full max-w-3xl gap-x-6 gap-y-4 overflow-y-auto p-4 sm:grid-cols-[1fr_1.15fr] sm:p-5`}
        style={{ maxHeight: 'calc(100dvh - 1.5rem)' }}
      >
        <div className="flex flex-col">
          <p className="text-[9px] font-bold tracking-[0.42em] text-cyan-300/80 uppercase">
            Open road
          </p>
          <h1 className="mt-0.5 bg-gradient-to-r from-white via-cyan-100 to-amber-200 bg-clip-text text-2xl leading-none font-black text-transparent sm:text-3xl">
            HORIZON RUSH
          </h1>

          <p className="mt-3 text-[9px] font-bold tracking-[0.24em] text-white/45 uppercase">
            Event
          </p>
          <div className="mt-1.5 grid gap-1.5">
            {EVENTS.map((e) => {
              const eventBest = bestFor(e.id);
              const active = e.id === settings.eventId;
              return (
                <button
                  key={e.id}
                  onClick={() => onSettings({ eventId: e.id })}
                  className={`flex items-center justify-between rounded-xl border px-3 py-2 text-left transition active:scale-[0.98] ${
                    active
                      ? 'border-cyan-300/60 bg-cyan-400/12'
                      : 'border-white/10 bg-white/[0.03]'
                  }`}
                >
                  <span>
                    <span className="block text-[11px] leading-tight font-bold">{e.name}</span>
                    <span className="block text-[9px] text-white/45">{e.blurb}</span>
                  </span>
                  {eventBest !== null && (
                    <span className="ml-2 font-mono text-[10px] text-amber-200">
                      {formatTime(eventBest)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="mt-auto grid gap-2 pt-3">
            <button
              onClick={onRace}
              className={`${primaryButton} bg-gradient-to-r from-cyan-400 to-sky-500 text-[#04121a] shadow-[0_10px_30px_-8px_rgba(83,224,255,0.8)]`}
            >
              Start race
            </button>
            <button
              onClick={onDrive}
              className={`${primaryButton} border border-white/15 bg-white/5 text-white/85`}
            >
              Free roam
            </button>
            {best !== null && (
              <p className="text-center text-[10px] tracking-wide text-white/45">
                Best <span className="font-mono text-amber-200">{formatTime(best)}</span>
              </p>
            )}
          </div>
        </div>

        <div>
          <p className="text-[9px] font-bold tracking-[0.24em] text-white/45 uppercase">Garage</p>
          <div className="mt-1.5 grid grid-cols-3 gap-1.5">
            {CARS.map((c) => {
              const stats = carStats(c);
              return (
                <button
                  key={c.id}
                  onClick={() => onSettings({ carId: c.id })}
                  className={`rounded-xl border p-2 text-left transition active:scale-[0.97] ${
                    c.id === car.id
                      ? 'border-cyan-300/60 bg-cyan-400/12'
                      : 'border-white/10 bg-white/[0.03]'
                  }`}
                >
                  <span
                    className="block h-2 w-full rounded-full"
                    style={{ background: `#${c.color.toString(16).padStart(6, '0')}` }}
                  />
                  <span className="mt-1.5 block truncate text-[10px] leading-tight font-bold">
                    {c.name}
                  </span>
                  <div className="mt-1 grid gap-0.5">
                    <StatBar label="SPD" value={stats.speed} />
                    <StatBar label="GRP" value={stats.grip} />
                    <StatBar label="DRF" value={stats.drift} />
                  </div>
                </button>
              );
            })}
          </div>

          <p className="mt-3 text-[9px] font-bold tracking-[0.24em] text-white/45 uppercase">
            Time of day
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {TIMES.map((t) => (
              <Chip
                key={t.id}
                active={t.id === settings.timeOfDay}
                onClick={() => onSettings({ timeOfDay: t.id })}
              >
                {t.label}
              </Chip>
            ))}
          </div>

          <p className="mt-3 text-[9px] font-bold tracking-[0.24em] text-white/45 uppercase">
            Options
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Chip
              active={settings.quality !== 'low'}
              onClick={() =>
                onSettings({ quality: settings.quality === 'low' ? 'high' : 'low' })
              }
            >
              {settings.quality === 'low' ? 'Performance' : 'High detail'}
            </Chip>
            <Chip active={!settings.muted} onClick={() => onSettings({ muted: !settings.muted })}>
              {settings.muted ? 'Sound off' : 'Sound on'}
            </Chip>
            <Chip active={settings.music} onClick={() => onSettings({ music: !settings.music })}>
              Music
            </Chip>
            <Chip
              active={settings.autoThrottle}
              onClick={() => onSettings({ autoThrottle: !settings.autoThrottle })}
            >
              Auto gas
            </Chip>
            <Chip
              active={settings.haptics}
              onClick={() => onSettings({ haptics: !settings.haptics })}
            >
              Haptics
            </Chip>
            {!IS_ARTIFACT && (
              <Chip active={settings.tilt} onClick={() => onSettings({ tilt: !settings.tilt })}>
                Tilt steering
              </Chip>
            )}
          </div>

          <p className="mt-3 text-[9px] leading-relaxed text-white/30">
            WASD / arrows drive · Shift nitro · Space handbrake · C camera · R respawn
            {!IS_ARTIFACT && (
              <>
                {' · '}
                <a href="#simulator" className="underline decoration-white/25 hover:text-white/60">
                  navQtracker simulator
                </a>
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
};

interface PauseProps {
  onResume: () => void;
  onRestart: () => void;
  onMenu: () => void;
  muted: boolean;
  onMuted: (m: boolean) => void;
  racing: boolean;
}

export const PauseOverlay: React.FC<PauseProps> = ({
  onResume, onRestart, onMenu, muted, onMuted, racing,
}) => (
  <div className="pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm">
    <div
      className={`${panel} w-full max-w-xs overflow-y-auto p-5`}
      style={{ maxHeight: 'calc(100dvh - 2rem)' }}
    >
      <h2 className="text-lg font-black tracking-tight">Paused</h2>
      <div className="mt-3 grid gap-1.5">
        <button
          onClick={onResume}
          className={`${compactButton} bg-gradient-to-r from-cyan-400 to-sky-500 text-[#04121a]`}
        >
          Resume
        </button>
        <div className="grid grid-cols-2 gap-1.5">
          {racing && (
            <button
              onClick={onRestart}
              className={`${compactButton} border border-white/15 bg-white/5 text-white/85`}
            >
              Restart
            </button>
          )}
          <button
            onClick={onMenu}
            className={`${compactButton} border border-white/15 bg-white/5 text-white/85 ${
              racing ? '' : 'col-span-2'
            }`}
          >
            Menu
          </button>
        </div>
        <div className="mt-1 flex justify-center">
          <Chip active={!muted} onClick={() => onMuted(!muted)}>
            {muted ? 'Sound off' : 'Sound on'}
          </Chip>
        </div>
      </div>
    </div>
  </div>
);

interface ResultsProps {
  time: number | null;
  best: number | null;
  position: number;
  racers: number;
  driftScore: number;
  rivals: RivalResult[];
  eventName: string;
  onRestart: () => void;
  onFreeRoam: () => void;
  onMenu: () => void;
}

export const ResultsOverlay: React.FC<ResultsProps> = ({
  time, best, position, racers, driftScore, rivals, eventName, onRestart, onFreeRoam, onMenu,
}) => {
  const isBest = time !== null && best !== null && Math.abs(time - best) < 1e-6;
  return (
    <div className="pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div
        className={`${panel} w-full max-w-sm overflow-y-auto p-5 text-center`}
        style={{ maxHeight: 'calc(100dvh - 2rem)' }}
      >
        <p className="text-[9px] font-bold tracking-[0.4em] text-cyan-300/80 uppercase">
          {eventName} complete
        </p>
        <p className="mt-1 text-4xl leading-none font-black tracking-tight">
          P{position}
          <span className="text-base font-semibold text-white/40">/{racers}</span>
        </p>
        <p className="mt-2 font-mono text-xl font-bold tabular-nums">
          {time !== null ? formatTime(time) : '—'}
        </p>
        {isBest ? (
          <p className="mt-1 text-[10px] font-bold tracking-[0.2em] text-amber-300 uppercase">
            New personal best
          </p>
        ) : (
          best !== null && (
            <p className="mt-1 text-[11px] text-white/45">
              Best <span className="font-mono text-amber-200">{formatTime(best)}</span>
            </p>
          )
        )}
        {rivals.length > 0 && (
          <div className="mt-2 grid gap-0.5 text-[10px] text-white/50">
            {rivals.map((r) => (
              <div key={r.name} className="flex items-center justify-between px-4">
                <span>{r.name}</span>
                <span className="font-mono text-white/70">
                  {r.time !== null ? formatTime(r.time) : 'DNF'}
                </span>
              </div>
            ))}
          </div>
        )}
        {driftScore > 0 && (
          <p className="mt-1.5 text-[11px] text-white/45">
            Drift score{' '}
            <span className="font-mono text-amber-200">{driftScore.toLocaleString()}</span>
          </p>
        )}

        <div className="mt-4 grid grid-cols-3 gap-1.5">
          <button
            onClick={onRestart}
            className={`${compactButton} bg-gradient-to-r from-cyan-400 to-sky-500 text-[#04121a]`}
          >
            Again
          </button>
          <button
            onClick={onFreeRoam}
            className={`${compactButton} border border-white/15 bg-white/5 text-white/85`}
          >
            Roam
          </button>
          <button
            onClick={onMenu}
            className={`${compactButton} border border-white/15 bg-white/5 text-white/85`}
          >
            Menu
          </button>
        </div>
      </div>
    </div>
  );
};

interface LoadingProps {
  progress?: string;
}

export const LoadingScreen: React.FC<LoadingProps> = ({ progress = 'Building the valley' }) => (
  <div className="absolute inset-0 z-40 flex items-center justify-center bg-[#070b12]">
    <div className="text-center">
      <div className="mx-auto h-1 w-40 overflow-hidden rounded-full bg-white/10">
        <div className="h-full w-1/3 animate-[loading_1.1s_ease-in-out_infinite] rounded-full bg-cyan-400" />
      </div>
      <p className="mt-4 text-[11px] tracking-[0.3em] text-white/45 uppercase">{progress}</p>
    </div>
    <style>{`@keyframes loading { 0% { transform: translateX(-110%);} 100% { transform: translateX(320%);} }`}</style>
  </div>
);
