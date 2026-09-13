import { useEffect, useRef, useState } from 'react';
import { useHud } from './hooks';
import { BTN_PRIMARY, OVERLAY } from './styles';
import { getUiBridge } from './uiBridge';

interface Props {
  kind: 'dead' | 'busted';
}

export function DeathScreen({ kind }: Props) {
  const hud = useHud();
  const [ready, setReady] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const wasted = kind === 'dead';

  useEffect(() => {
    const t = window.setTimeout(() => setReady(true), 1600);
    return () => window.clearTimeout(t);
  }, []);
  useEffect(() => {
    if (ready) btnRef.current?.focus();
  }, [ready]);

  const respawn = () => {
    const b = getUiBridge();
    if (!b) return;
    b.respawn();
    b.requestPointerLock();
  };

  return (
    <div className={`${OVERLAY} z-30 flex flex-col items-center justify-center backdrop-grayscale bg-black/45 px-4`}>
      <div
        className={`death-fade gta-font text-[22vw] md:text-[10rem] leading-none uppercase ${wasted ? 'text-[#c81e1e]' : 'text-[#2f6fd6]'}`}
        style={{ textShadow: '0 5px 0 #000, 0 0 40px rgba(0,0,0,0.9), 0 0 90px rgba(0,0,0,0.7)' }}
      >
        {wasted ? 'Wasted' : 'Busted'}
      </div>
      {hud.deathMessage && (
        <div className="mt-2 text-base md:text-xl text-white/85 hud-text fade-in uppercase tracking-[0.15em] text-center max-w-2xl" style={{ animationDelay: '0.9s' }}>
          {hud.deathMessage}
        </div>
      )}
      <div className="mt-10 h-16 flex items-center">
        {ready && (
          <button ref={btnRef} className={`${BTN_PRIMARY} fade-in`} onClick={respawn}>
            Respawn
          </button>
        )}
      </div>
    </div>
  );
}
