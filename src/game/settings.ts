/**
 * One guarded gateway to localStorage.
 *
 * Every read and write is wrapped: in a sandboxed iframe (the published
 * artifact) merely touching `window.localStorage` can throw, and the game must
 * be fully playable with storage dead — settings just do not stick.
 */

const SETTINGS_KEY = 'nac-racing:settings:v2';
const BEST_PREFIX = 'nac-racing:best:';

// v1 keys, migrated on first load.
const LEGACY_BEST_KEY = 'nac-racing:best-time:v1';
const LEGACY_MUTE_KEY = 'nac-racing:muted:v1';

export interface StoredSettings {
  carId: string;
  timeOfDay: string;
  quality: 'low' | 'high' | 'auto';
  muted: boolean;
  music: boolean;
  tilt: boolean;
  haptics: boolean;
  autoThrottle: boolean;
  eventId: string;
}

export const DEFAULT_SETTINGS: StoredSettings = {
  carId: 'horizon',
  timeOfDay: 'golden',
  quality: 'auto',
  muted: false,
  music: true,
  tilt: false,
  haptics: true,
  autoThrottle: true,
  eventId: 'circuit',
};

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable or full; the game keeps running without it.
  }
};

const remove = (key: string): void => {
  try {
    localStorage.removeItem(key);
  } catch {
    // Same as above.
  }
};

/** String fields are looked up in typed tables downstream (QUALITY[tier],
 * sky PRESETS, CARS, EVENTS), so a stale or hand-edited value must never get
 * through — an unknown key would crash the game at startup. */
const VALID: Record<string, ReadonlySet<string>> = {
  quality: new Set(['low', 'high', 'auto']),
  timeOfDay: new Set(['dawn', 'golden', 'noon', 'dusk', 'night']),
  carId: new Set(['horizon', 'drifter', 'rally', 'vulcan', 'dune', 'spectre']),
  eventId: new Set(['circuit', 'sprint', 'reverse']),
};

export const loadSettings = (): StoredSettings => {
  const merged: StoredSettings = { ...DEFAULT_SETTINGS };
  const raw = read(SETTINGS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<StoredSettings>;
      for (const key of Object.keys(merged) as Array<keyof StoredSettings>) {
        const value = parsed[key];
        if (value === undefined || typeof value !== typeof merged[key]) continue;
        const allowed = VALID[key];
        if (allowed && !allowed.has(value as string)) continue;
        (merged as unknown as Record<string, unknown>)[key] = value;
      }
    } catch {
      // Corrupt JSON: fall back to defaults.
    }
  } else if (read(LEGACY_MUTE_KEY) === '1') {
    merged.muted = true;
  }
  return merged;
};

export const saveSettings = (settings: StoredSettings): void => {
  write(SETTINGS_KEY, JSON.stringify(settings));
  remove(LEGACY_MUTE_KEY);
};

export const loadBestTime = (eventId: string): number | null => {
  let raw = read(BEST_PREFIX + eventId);
  if (raw === null && eventId === 'circuit') {
    // The v1 build stored a single best time; it was the circuit's.
    raw = read(LEGACY_BEST_KEY);
    if (raw !== null) {
      write(BEST_PREFIX + eventId, raw);
      remove(LEGACY_BEST_KEY);
    }
  }
  if (raw === null) return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
};

export const saveBestTime = (eventId: string, time: number): void => {
  write(BEST_PREFIX + eventId, String(time));
};
