import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Game } from '../Game';
import type { RivalResult } from '../race/opponents';
import { eventById } from '../race/route';
import { loadSettings, saveSettings, type StoredSettings } from '../settings';
import { CARS, type GamePhase, type QualityTier } from '../types';
import type { TimeOfDay } from '../world/sky';
import { Hud } from './Hud';
import { LoadingScreen, PauseOverlay, ResultsOverlay, StartScreen } from './Menu';
import { TouchControls } from './TouchControls';

/** Devices that are clearly not phones get the high tier without probing. */
const guessQuality = (): QualityTier => {
  const cores = navigator.hardwareConcurrency ?? 4;
  const dpr = window.devicePixelRatio || 1;
  const smallScreen = Math.min(window.screen.width, window.screen.height) < 500;
  if (cores <= 4 && (smallScreen || dpr > 2.5)) return 'low';
  return 'high';
};

const resolveTier = (setting: StoredSettings['quality']): QualityTier =>
  setting === 'auto' ? guessQuality() : setting;

/**
 * Browser niceties that only work from a user gesture, and only outside a
 * sandboxed iframe. Every one is a best-effort no-op on failure.
 */
const enterImmersiveMode = (): void => {
  try {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.()?.catch(() => undefined);
    }
  } catch {
    // Sandboxed or unsupported.
  }
  try {
    type Lockable = { lock?: (o: string) => Promise<void> };
    (screen.orientation as unknown as Lockable)?.lock?.('landscape')?.catch(() => undefined);
  } catch {
    // Desktop browsers throw synchronously; that is fine.
  }
};

/** Keeps the screen awake while driving; harmless where unsupported. */
const useWakeLock = (active: boolean): void => {
  useEffect(() => {
    if (!active) return;
    type WakeLockSentinel = { release?: () => Promise<void> };
    type WakeLockNav = Navigator & {
      wakeLock?: { request: (t: string) => Promise<WakeLockSentinel> };
    };
    let sentinel: WakeLockSentinel | null = null;
    let disposed = false;

    const acquire = () => {
      try {
        (navigator as WakeLockNav).wakeLock
          ?.request('screen')
          .then((s) => {
            if (disposed) void s.release?.();
            else sentinel = s;
          })
          .catch(() => undefined);
      } catch {
        // Unsupported.
      }
    };

    const onVisibility = () => {
      if (!document.hidden) acquire();
    };

    acquire();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      void sentinel?.release?.();
    };
  }, [active]);
};

export const RacingGame: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);

  const [ready, setReady] = useState(false);
  const [phase, setPhase] = useState<GamePhase>('menu');
  const [settings, setSettings] = useState<StoredSettings>(() => loadSettings());
  const [portrait, setPortrait] = useState(false);
  const [results, setResults] = useState<{
    time: number | null;
    best: number | null;
    position: number;
    drift: number;
    rivals: RivalResult[];
  }>({ time: null, best: null, position: 1, drift: 0, rivals: [] });

  const applySettingsToGame = useCallback((game: Game, s: StoredSettings) => {
    const car = CARS.find((c) => c.id === s.carId) ?? CARS[0];
    game.setCar(car);
    game.setTimeOfDay(s.timeOfDay as TimeOfDay);
    game.applyQuality(resolveTier(s.quality));
    game.setMuted(s.muted);
    game.setMusic(s.music);
    game.hapticsEnabled = s.haptics;
    game.input.autoThrottle = s.autoThrottle;
    game.setEvent(s.eventId);
    if (!s.tilt) game.disableTilt();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let game: Game | null = null;

    // Let the loading screen paint before the world generation blocks the thread.
    const handle = window.setTimeout(() => {
      if (disposed) return;
      const stored = loadSettings();
      game = new Game(canvas, resolveTier(stored.quality));
      gameRef.current = game;
      game.onPhaseChange = (next) => {
        setPhase(next);
        if (next === 'finished' && game) {
          setResults({
            time: game.hud.lastTime,
            best: game.hud.bestTime,
            position: game.hud.position,
            drift: game.hud.driftScore,
            rivals: game.rivalResults(),
          });
        }
      };
      applySettingsToGame(game, stored);
      if (stored.tilt) {
        void game.enableTilt().then((ok) => {
          if (!ok) {
            const reverted = { ...settingsRef.current, tilt: false };
            settingsRef.current = reverted;
            saveSettings(reverted);
            setSettings(reverted);
          }
        });
      }
      game.setCameraMode('cinematic');
      game.start();
      setReady(true);
      // Debug handle: lets the perf harness read renderer stats and drive the
      // car without going through the UI. Harmless to leave in a browser game.
      (window as unknown as { __horizonRush?: Game }).__horizonRush = game;
    }, 30);

    return () => {
      disposed = true;
      window.clearTimeout(handle);
      game?.dispose();
      gameRef.current = null;
      setReady(false);
      delete (window as unknown as { __horizonRush?: Game }).__horizonRush;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const check = () => setPortrait(window.innerHeight > window.innerWidth * 1.15);
    check();
    window.addEventListener('resize', check, { passive: true });
    window.addEventListener('orientationchange', check, { passive: true });
    return () => {
      window.removeEventListener('resize', check);
      window.removeEventListener('orientationchange', check);
    };
  }, []);

  // Escape doubles as the pause key on desktop.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Escape') return;
      const game = gameRef.current;
      if (!game) return;
      if (game.currentPhase === 'paused') game.resume();
      else if (game.currentPhase === 'freeroam' || game.currentPhase === 'racing') game.pause();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Interruptions (calls, tab switches) pause the game rather than dropping
  // the player back in at speed. The engine already freezes its loop when
  // hidden; this makes the return deliberate too.
  useEffect(() => {
    const onVisibility = () => {
      const game = gameRef.current;
      if (!game || !document.hidden) return;
      const p = game.currentPhase;
      if (p === 'freeroam' || p === 'racing' || p === 'countdown') game.pause();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Rivals keep racing after the player finishes; refresh their times on the
  // results screen until the last one is home.
  useEffect(() => {
    if (phase !== 'finished') return;
    const id = window.setInterval(() => {
      const game = gameRef.current;
      if (!game) return;
      const rivals = game.rivalResults();
      setResults((r) => ({ ...r, rivals }));
      if (rivals.every((rv) => rv.time !== null)) window.clearInterval(id);
    }, 600);
    return () => window.clearInterval(id);
  }, [phase]);

  const driving = phase === 'freeroam' || phase === 'racing' || phase === 'countdown';
  useWakeLock(driving);

  const withGame = useCallback((fn: (game: Game) => void) => {
    const game = gameRef.current;
    if (game) fn(game);
  }, []);

  // Mirror of `settings` for handlers, so side effects can run outside the
  // React state updater (StrictMode double-invokes updaters in dev).
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const handleSettings = useCallback((patch: Partial<StoredSettings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    saveSettings(next);
    setSettings(next);

    const game = gameRef.current;
    if (!game) return;
    if (patch.carId !== undefined) {
      game.setCar(CARS.find((c) => c.id === next.carId) ?? CARS[0]);
    }
    if (patch.timeOfDay !== undefined) game.setTimeOfDay(next.timeOfDay as TimeOfDay);
    if (patch.quality !== undefined) game.applyQuality(resolveTier(next.quality));
    if (patch.muted !== undefined) game.setMuted(next.muted);
    if (patch.music !== undefined) game.setMusic(next.music);
    if (patch.haptics !== undefined) game.hapticsEnabled = next.haptics;
    if (patch.autoThrottle !== undefined) game.input.autoThrottle = next.autoThrottle;
    if (patch.eventId !== undefined) game.setEvent(next.eventId);
    if (patch.tilt !== undefined) {
      if (next.tilt) {
        void game.enableTilt().then((ok) => {
          if (!ok) {
            const reverted = { ...settingsRef.current, tilt: false };
            settingsRef.current = reverted;
            saveSettings(reverted);
            setSettings(reverted);
          }
        });
      } else {
        game.disableTilt();
      }
    }
  }, []);

  const beginDriving = useCallback(
    (race: boolean) => {
      enterImmersiveMode();
      withGame((game) => {
        void game.audio.resume();
        game.setCameraMode('chase');
        if (race) game.startRace();
        else game.beginFreeRoam();
      });
    },
    [withGame],
  );

  const handleDrive = useCallback(() => beginDriving(false), [beginDriving]);
  const handleRace = useCallback(() => beginDriving(true), [beginDriving]);

  return (
    <div
      className="fixed inset-0 overflow-hidden bg-[#070b12] font-sans text-white select-none"
      style={{ touchAction: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />

      {!ready && <LoadingScreen />}

      {ready && gameRef.current && <Hud game={gameRef.current} phase={phase} />}

      {ready && gameRef.current && (
        <TouchControls
          input={gameRef.current.input}
          autoThrottle={settings.autoThrottle}
          visible={driving}
          onPause={() => withGame((game) => game.pause())}
          onCamera={() => withGame((game) => game.cycleCamera())}
        />
      )}

      {ready && phase === 'freeroam' && (
        <div className="pointer-events-none absolute top-3 right-3 z-20 flex justify-center pt-12">
          <button
            onClick={handleRace}
            className="pointer-events-auto rounded-full border border-cyan-300/50 bg-cyan-400/25 px-4 py-2 text-[11px] font-black tracking-[0.16em] text-cyan-50 uppercase backdrop-blur-md active:scale-95"
          >
            Start race
          </button>
        </div>
      )}

      {ready && phase === 'menu' && (
        <StartScreen
          settings={settings}
          onSettings={handleSettings}
          bestFor={(id) => gameRef.current?.bestTimeFor(id) ?? null}
          onDrive={handleDrive}
          onRace={handleRace}
        />
      )}

      {ready && phase === 'paused' && (
        <PauseOverlay
          muted={settings.muted}
          onMuted={(m) => handleSettings({ muted: m })}
          racing={gameRef.current?.pausedFromRace ?? false}
          onResume={() => withGame((game) => game.resume())}
          onRestart={() => withGame((game) => game.startRace())}
          onMenu={() => withGame((game) => game.returnToMenu())}
        />
      )}

      {ready && phase === 'finished' && (
        <ResultsOverlay
          time={results.time}
          best={results.best}
          position={results.position}
          racers={gameRef.current?.hud.racerCount ?? 1}
          driftScore={results.drift}
          rivals={results.rivals}
          eventName={eventById(settings.eventId).name}
          onRestart={handleRace}
          onFreeRoam={() => withGame((game) => game.beginFreeRoam())}
          onMenu={() => withGame((game) => game.returnToMenu())}
        />
      )}

      {ready && portrait && driving && (
        <div className="pointer-events-none absolute top-1/2 left-1/2 z-20 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/55 px-4 py-2 text-[11px] tracking-wide text-white/70 backdrop-blur-md">
          Rotate your phone for the full view
        </div>
      )}
    </div>
  );
};

export default RacingGame;
