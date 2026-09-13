/** Shared Tailwind class strings so every menu/panel has the same GTA-flavoured look. */
export const ACCENT = '#f5b700';

export const OVERLAY = 'fixed inset-0 select-none text-white';
export const PANEL = 'bg-[#0b0e14]/85 backdrop-blur-md border border-white/10 rounded-xl shadow-2xl';
export const PANEL_SOFT = 'bg-black/45 backdrop-blur-sm border border-white/10 rounded-lg';

export const BTN_PRIMARY =
  'gta-font tracking-wider uppercase text-2xl leading-none px-8 py-3 rounded-md bg-[#f5b700] text-black hover:bg-[#ffd23f] active:translate-y-px transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80 disabled:opacity-40 disabled:cursor-not-allowed';
export const BTN_GHOST =
  'gta-font tracking-wider uppercase text-xl leading-none px-6 py-2.5 rounded-md border border-white/20 text-white/90 hover:bg-white/10 hover:border-white/40 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#f5b700] disabled:opacity-40 disabled:cursor-not-allowed';
export const BTN_DANGER =
  'gta-font tracking-wider uppercase text-xl leading-none px-6 py-2.5 rounded-md border border-red-500/50 text-red-300 hover:bg-red-500/20 hover:border-red-400 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400';
export const BTN_SMALL =
  'text-xs font-bold uppercase tracking-wider px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 border border-white/15 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#f5b700] disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:bg-white/10';
export const BTN_SMALL_ACCENT =
  'text-xs font-bold uppercase tracking-wider px-3 py-1.5 rounded bg-[#f5b700] text-black hover:bg-[#ffd23f] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80 disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:bg-[#f5b700]';

export function tabCls(active: boolean): string {
  return (
    'gta-font uppercase tracking-wider text-lg leading-none px-4 py-2 rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#f5b700] ' +
    (active ? 'bg-[#f5b700] text-black' : 'text-white/70 hover:text-white hover:bg-white/10')
  );
}

export const H1 = 'gta-font uppercase leading-none tracking-wide';
export const LABEL = 'text-[11px] uppercase tracking-[0.18em] text-white/50 font-semibold';

export function formatMoney(v: number): string {
  const n = Math.round(Math.abs(v));
  return `${v < 0 ? '-' : ''}$${n.toLocaleString('en-US')}`;
}

export function formatTimer(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  return `${m.toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
}

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}h ${m.toString().padStart(2, '0')}m` : `${m}:${r.toString().padStart(2, '0')}`;
}
