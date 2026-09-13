import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Game } from './game/Game';
import { store } from './game/core/store';
import { DeathScreen, FullMap, Hud, MainMenu, PauseMenu, ShopMenu } from './game/ui';

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);
  const hud = useSyncExternalStore(store.subscribe, store.getSnapshot);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || gameRef.current) return;
    const game = new Game(canvas, {});
    gameRef.current = game;
    game.init().catch((err) => {
      console.error(err);
      store.set('loadingText', `Failed to start: ${String(err)}`);
      store.commit();
    });
    return () => {
      game.dispose();
      gameRef.current = null;
    };
  }, []);

  const phase = hud.phase;

  return (
    <div className="relative w-full h-full select-none">
      <canvas id="game-canvas" ref={canvasRef} tabIndex={0} />
      {phase === 'boot' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black text-white">
          <div className="gta-font text-5xl mb-6">OPEN CITY</div>
          <div className="w-72 h-2 bg-white/20 rounded overflow-hidden">
            <div className="h-full bg-amber-400" style={{ width: `${Math.round(hud.loading * 100)}%` }} />
          </div>
          <div className="mt-3 text-sm text-white/70">{hud.loadingText}</div>
        </div>
      )}
      {(phase === 'playing' || phase === 'map') && <Hud showMinimap={phase === 'playing'} />}
      {phase === 'map' && <FullMap />}
      {phase === 'menu' && <MainMenu />}
      {phase === 'paused' && <PauseMenu />}
      {(phase === 'dead' || phase === 'busted') && <DeathScreen kind={phase} />}
      {phase === 'shop' && <ShopMenu />}
    </div>
  );
}
