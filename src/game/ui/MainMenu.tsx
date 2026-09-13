import { useState } from 'react';
import { ControlsPanel } from './ControlsPanel';
import { useBridge } from './hooks';
import { SettingsPanel } from './SettingsPanel';
import { BTN_GHOST, BTN_PRIMARY, OVERLAY, PANEL } from './styles';
import { getUiBridge } from './uiBridge';

type Panel = 'controls' | 'settings' | null;

export function MainMenu() {
  const bridge = useBridge();
  const [panel, setPanel] = useState<Panel>(null);

  const play = () => {
    const b = getUiBridge();
    if (!b) return;
    b.start();
    b.requestPointerLock();
  };
  const toggle = (p: Exclude<Panel, null>) => setPanel((cur) => (cur === p ? null : p));

  return (
    <div
      className={`${OVERLAY} z-30 flex flex-col md:flex-row overflow-y-auto oc-scroll`}
      style={{ background: 'linear-gradient(100deg, rgba(3,5,10,0.94) 0%, rgba(3,5,10,0.82) 45%, rgba(3,5,10,0.45) 100%)' }}
    >
      {/* Left column: title + actions */}
      <div className="flex flex-col justify-center px-8 md:px-16 py-10 w-full md:w-[46%] md:max-w-[640px] shrink-0">
        <div className="text-[#f5b700] tracking-[0.35em] text-xs font-bold uppercase mb-3">Welcome to</div>
        <h1 className="gta-font text-7xl md:text-8xl lg:text-9xl hud-text-strong leading-[0.85] uppercase">
          <span className="text-white">Open</span>
          <br />
          <span className="text-[#f5b700]">City</span>
        </h1>
        <p className="mt-4 text-white/85 text-lg md:text-xl italic">“Every street has a price. Every siren knows your name.”</p>
        <p className="mt-3 text-sm text-white/60 max-w-md leading-relaxed">A procedurally generated 2 km² city — drive, walk, shoot, evade the police, take missions. Everything runs in your browser.</p>

        <div className="mt-8 flex flex-col gap-3 w-64">
          <button className={BTN_PRIMARY} onClick={play} disabled={!bridge} autoFocus>
            Play
          </button>
          <button className={`${BTN_GHOST} ${panel === 'controls' ? 'bg-white/10 border-white/50' : ''}`} onClick={() => toggle('controls')} aria-pressed={panel === 'controls'}>
            Controls
          </button>
          <button className={`${BTN_GHOST} ${panel === 'settings' ? 'bg-white/10 border-white/50' : ''}`} onClick={() => toggle('settings')} aria-pressed={panel === 'settings'}>
            Settings
          </button>
        </div>
        {!bridge && <div className="mt-3 text-xs text-white/50 hud-pulse">Engine starting…</div>}

        <div className="mt-10 text-[11px] text-white/40 uppercase tracking-[0.2em]">Click Play to grab the mouse · Esc pauses</div>
      </div>

      {/* Right column: panel */}
      {panel && (
        <div className="flex-1 flex items-start md:items-center justify-center p-4 md:p-8 fade-in">
          <div className={`${PANEL} w-full max-w-xl max-h-[85vh] overflow-y-auto oc-scroll p-6`}>{panel === 'controls' ? <ControlsPanel /> : <SettingsPanel />}</div>
        </div>
      )}
    </div>
  );
}
