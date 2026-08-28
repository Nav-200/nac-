import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Game } from '../Game';
import { CARS, type CarSpec, type GamePhase, type QualityTier } from '../types';
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

export const RacingGame: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);

  const [ready, setReady] = useState(false);
  const [phase, setPhase] = useState<GamePhase>('menu');
  const [car, setCar] = useState<CarSpec>(CARS[0]);
  const [time, setTime] = useState<TimeOfDay>('golden');
  const [quality, setQuality] = useState<QualityTier>('high');
  const [muted, setMuted] = useState(false);
  const [tilt, setTilt] = useState(false);
  const [portrait, setPortrait] = useState(false);
  const [results, setResults] = useState<{ time: number | null; best: number | null; position: number; drift: number }>({
    time: null,
    best: null,
    position: 1,
    drift: 0,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let game: Game | null = null;

    // Let the loading screen paint before the world generation blocks the thread.
    const handle = window.setTimeout(() => {
      if (disposed) return;
      const tier = guessQuality();
      game = new Game(canvas, tier);
      gameRef.current = game;
      game.onPhaseChange = (next) => {
        setPhase(next);
        if (next === 'finished' && game) {
          setResults({
            time: game.hud.lastTime,
            best: game.hud.bestTime,
            position: game.hud.position,
            drift: game.hud.driftScore,
          });
        }
      };
      game.setCameraMode('cinematic');
      game.start();
      // Debug handle: lets the perf harness read renderer stats and drive the
      // car without going through the UI. Harmless to leave in a browser game.
      (window as unknown as { __horizonRush?: Game }).__horizonRush = game;
      setQuality(tier);
      setMuted(game.audio.muted);
      setReady(true);
    }, 30);

    return () => {
      disposed = true;
      window.clearTimeout(handle);
      game?.dispose();
      gameRef.current = null;
      delete (window as unknown as { __horizonRush?: Game }).__horizonRush;
      setReady(false);
    };
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

  const withGame = useCallback((fn: (game: Game) => void) => {
    const game = gameRef.current;
    if (game) fn(game);
  }, []);

  const handleDrive = useCallback(() => {
    withGame((game) => {
      void game.audio.resume();
      game.setCameraMode('chase');
      game.beginFreeRoam();
    });
  }, [withGame]);

  const handleRace = useCallback(() => {
    withGame((game) => {
      void game.audio.resume();
      game.setCameraMode('chase');
      game.startRace();
    });
  }, [withGame]);

  const handleCar = useCallback(
    (next: CarSpec) => {
      setCar(next);
      withGame((game) => game.setCar(next));
    },
    [withGame],
  );

  const handleTime = useCallback(
    (next: TimeOfDay) => {
      setTime(next);
      withGame((game) => game.setTimeOfDay(next));
    },
    [withGame],
  );

  const handleQuality = useCallback(
    (next: QualityTier) => {
      setQuality(next);
      withGame((game) => game.applyQuality(next));
    },
    [withGame],
  );

  const handleMuted = useCallback(
    (next: boolean) => {
      setMuted(next);
      withGame((game) => game.setMuted(next));
    },
    [withGame],
  );

  const handleTilt = useCallback(
    (next: boolean) => {
      const game = gameRef.current;
      if (!game) return;
      if (!next) {
        game.disableTilt();
        setTilt(false);
        return;
      }
      void game.enableTilt().then((ok) => setTilt(ok));
    },
    [],
  );

  const driving = phase === 'freeroam' || phase === 'racing' || phase === 'countdown';

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
          car={car}
          onCar={handleCar}
          time={time}
          onTime={handleTime}
          quality={quality}
          onQuality={handleQuality}
          muted={muted}
          onMuted={handleMuted}
          tilt={tilt}
          onTilt={handleTilt}
          bestTime={gameRef.current?.hud.bestTime ?? null}
          onDrive={handleDrive}
          onRace={handleRace}
        />
      )}

      {ready && phase === 'paused' && (
        <PauseOverlay
          muted={muted}
          onMuted={handleMuted}
          racing={gameRef.current?.hud.checkpointTotal !== undefined}
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
          onRestart={() => withGame((game) => game.startRace())}
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
