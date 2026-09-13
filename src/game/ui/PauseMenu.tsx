import { useEffect, useState } from 'react';
import { ControlsPanel } from './ControlsPanel';
import { useBridge, useHud } from './hooks';
import { SettingsPanel } from './SettingsPanel';
import { BTN_DANGER, BTN_GHOST, BTN_PRIMARY, LABEL, OVERLAY, PANEL, formatDuration, formatMoney, tabCls } from './styles';
import { getUiBridge } from './uiBridge';

type Tab = 'controls' | 'settings' | 'stats' | 'newgame';

export function PauseMenu() {
  const hud = useHud();
  const [tab, setTab] = useState<Tab>('controls');

  const resume = () => {
    const b = getUiBridge();
    if (!b) return;
    b.resume();
    b.requestPointerLock();
  };

  return (
    <div className={`${OVERLAY} z-30 flex items-center justify-center bg-black/60 backdrop-blur-[2px] p-3`}>
      <div className={`${PANEL} w-[min(94vw,880px)] max-h-[92vh] flex flex-col`}>
        <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-white/10">
          <div>
            <div className="gta-font text-5xl leading-none tracking-wider hud-text">PAUSED</div>
            <div className="mt-1 text-xs text-white/55 uppercase tracking-[0.18em]">
              {hud.clock} · {hud.district || 'Open City'} · {formatMoney(hud.money)}
            </div>
          </div>
          <button className={BTN_PRIMARY} onClick={resume} autoFocus>
            Resume
          </button>
        </div>

        <div className="flex flex-wrap gap-1 px-4 pt-3">
          <button className={tabCls(tab === 'controls')} onClick={() => setTab('controls')}>
            Controls
          </button>
          <button className={tabCls(tab === 'settings')} onClick={() => setTab('settings')}>
            Settings
          </button>
          <button className={tabCls(tab === 'stats')} onClick={() => setTab('stats')}>
            Stats
          </button>
          <button className={tabCls(tab === 'newgame')} onClick={() => setTab('newgame')}>
            New game
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto oc-scroll px-6 py-4">
          {tab === 'controls' && <ControlsPanel />}
          {tab === 'settings' && <SettingsPanel />}
          {tab === 'stats' && <StatsPanel />}
          {tab === 'newgame' && <NewGamePanel />}
        </div>

        <div className="px-6 py-3 border-t border-white/10 text-[11px] text-white/45 uppercase tracking-[0.18em] flex justify-between">
          <span>
            <kbd className="kbd">Esc</kbd> resume
          </span>
          <span>Open City</span>
        </div>
      </div>
    </div>
  );
}

function StatsPanel() {
  const bridge = useBridge();
  const hud = useHud();
  const [stats, setStats] = useState(() => getUiBridge()?.stats() ?? null);
  useEffect(() => {
    if (bridge) setStats(bridge.stats());
  }, [bridge]);
  const rows: [string, string][] = stats
    ? [
        ['Play time', formatDuration(stats.playTimeSec)],
        ['Money earned', formatMoney(stats.moneyEarned)],
        ['Missions completed', String(stats.missionsDone)],
        ['Kills', String(stats.kills)],
        ['Vehicles stolen', String(stats.vehiclesStolen)],
        ['Distance travelled', `${stats.distanceKm.toFixed(1)} km`],
        ['Highest wanted level', '★'.repeat(stats.maxWanted) || '—'],
        ['Deaths', String(stats.deaths)],
      ]
    : [
        ['Missions completed', String(hud.stats.missionsDone)],
        ['Kills', String(hud.stats.kills)],
        ['Vehicles stolen', String(hud.stats.vehiclesStolen)],
        ['Distance travelled', `${hud.stats.distanceKm.toFixed(1)} km`],
        ['Highest wanted level', '★'.repeat(hud.stats.maxWanted) || '—'],
      ];
  return (
    <div>
      <div className={LABEL}>Statistics</div>
      <dl className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-8">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4 py-1.5 border-b border-white/5 text-sm">
            <dt className="text-white/70">{k}</dt>
            <dd className="tabular-nums text-white font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function NewGamePanel() {
  const [confirm, setConfirm] = useState(false);
  return (
    <div>
      <div className={LABEL}>New game</div>
      <p className="mt-2 text-sm text-white/80 max-w-prose">Start over with a fresh character: money, weapons, missions and statistics are reset. Your current progress will be lost.</p>
      {!confirm ? (
        <button className={`${BTN_DANGER} mt-4`} onClick={() => setConfirm(true)}>
          New game…
        </button>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-3 fade-in">
          <span className="text-sm text-red-300 font-semibold">Are you sure?</span>
          <button
            className={BTN_DANGER}
            autoFocus
            onClick={() => {
              const b = getUiBridge();
              if (!b) return;
              b.newGame();
              b.requestPointerLock();
            }}
          >
            Yes, start over
          </button>
          <button className={BTN_GHOST} onClick={() => setConfirm(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
