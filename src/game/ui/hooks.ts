import { useEffect, useState, useSyncExternalStore } from 'react';
import { store, type HudState } from '../core/store';
import { getUiBridge, type UiBridge } from './uiBridge';

/** Read-only HUD snapshot published by the engine (~10 Hz). */
export function useHud(): HudState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/**
 * The engine bridge. It may be null before the engine finishes booting, so poll briefly
 * until it appears; components must still null-check on every action.
 */
export function useBridge(): UiBridge | null {
  const [bridge, setBridge] = useState<UiBridge | null>(() => getUiBridge());
  useEffect(() => {
    if (bridge) return;
    const id = window.setInterval(() => {
      const b = getUiBridge();
      if (b) {
        setBridge(b);
        window.clearInterval(id);
      }
    }, 200);
    return () => window.clearInterval(id);
  }, [bridge]);
  return bridge;
}

/** Re-render on an interval (for cheap bridge reads that are not in the store). */
export function useTicker(ms: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return tick;
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => (typeof window !== 'undefined' ? window.matchMedia(query).matches : false));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
