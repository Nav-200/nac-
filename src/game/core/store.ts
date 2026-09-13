/**
 * Tiny external store bridging the engine (plain TS) and the React HUD.
 * The engine mutates `hud` fields at most a few times per second (or on events) and
 * calls `commit()`; React subscribes with useSyncExternalStore.
 */
export type GamePhase = 'boot' | 'menu' | 'playing' | 'paused' | 'dead' | 'busted' | 'map' | 'shop';

export interface HudNotification {
  id: number;
  text: string;
  kind: 'info' | 'money' | 'mission' | 'warning';
  until: number; // seconds (game clock) when it expires
}

export interface HudMission {
  active: boolean;
  id: string;
  title: string;
  objective: string;
  timeLeft: number | null; // seconds, null = untimed
  progress: string; // e.g. "2/5"
  reward: number;
}

export interface HudState {
  phase: GamePhase;
  loading: number; // 0..1 progress
  loadingText: string;
  health: number;
  maxHealth: number;
  armor: number;
  money: number;
  wanted: number; // 0..5
  wantedFlash: boolean; // true while police are actively searching
  weaponId: string;
  weaponName: string;
  ammoInClip: number;
  ammoReserve: number;
  clipSize: number;
  reloading: boolean;
  inVehicle: boolean;
  vehicleName: string;
  speedKmh: number;
  vehicleHealth: number; // 0..1
  headlights: boolean;
  timeOfDay: number; // 0..1 (0 = midnight, 0.5 = noon)
  clock: string; // "HH:MM"
  district: string;
  mission: HudMission | null;
  notifications: HudNotification[];
  interactPrompt: string; // e.g. "Press F to enter Sedan"
  crosshair: boolean;
  aiming: boolean;
  hitMarker: number; // seconds remaining
  damageFlash: number; // 0..1
  fps: number;
  stats: { kills: number; vehiclesStolen: number; missionsDone: number; distanceKm: number; maxWanted: number };
  deathMessage: string;
  pointerLocked: boolean;
  /** Large centre-screen text (mission passed/failed, wasted…). */
  bigText: { title: string; sub: string; until: number; color: string } | null;
  radioName: string;
  /** Distance in metres to the active waypoint / mission marker (-1 = none). */
  waypointDist: number;
  cameraMode: 'near' | 'far' | 'first';
  /** Total cash spent / earned info for the shop UI. */
  shopMessage: string;
  paused: boolean;
}

export function createInitialHud(): HudState {
  return {
    phase: 'boot',
    loading: 0,
    loadingText: 'Booting…',
    health: 100,
    maxHealth: 100,
    armor: 0,
    money: 500,
    wanted: 0,
    wantedFlash: false,
    weaponId: 'fist',
    weaponName: 'Fists',
    ammoInClip: 0,
    ammoReserve: 0,
    clipSize: 0,
    reloading: false,
    inVehicle: false,
    vehicleName: '',
    speedKmh: 0,
    vehicleHealth: 1,
    headlights: false,
    timeOfDay: 0.4,
    clock: '09:36',
    district: '',
    mission: null,
    notifications: [],
    interactPrompt: '',
    crosshair: false,
    aiming: false,
    hitMarker: 0,
    damageFlash: 0,
    fps: 0,
    stats: { kills: 0, vehiclesStolen: 0, missionsDone: 0, distanceKm: 0, maxWanted: 0 },
    deathMessage: '',
    pointerLocked: false,
    bigText: null,
    radioName: 'Off',
    waypointDist: -1,
    cameraMode: 'near',
    shopMessage: '',
    paused: false,
  };
}

type Listener = () => void;

export class GameStore {
  /** Mutable working copy; engine writes here. */
  readonly hud: HudState = createInitialHud();
  private snapshot: HudState = { ...this.hud, stats: { ...this.hud.stats } };
  private listeners = new Set<Listener>();
  private dirty = true;
  private nextNotifId = 1;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): HudState => this.snapshot;

  /** Mark dirty; the next commit() publishes a new immutable snapshot. */
  invalidate(): void {
    this.dirty = true;
  }

  /** Publish the current hud state to React (cheap if nothing changed). */
  commit(force = false): void {
    if (!this.dirty && !force) return;
    this.dirty = false;
    this.snapshot = {
      ...this.hud,
      stats: { ...this.hud.stats },
      mission: this.hud.mission ? { ...this.hud.mission } : null,
      bigText: this.hud.bigText ? { ...this.hud.bigText } : null,
      notifications: this.hud.notifications.slice(),
    };
    for (const l of this.listeners) l();
  }

  set<K extends keyof HudState>(key: K, value: HudState[K]): void {
    if (this.hud[key] !== value) {
      this.hud[key] = value;
      this.dirty = true;
    }
  }

  setPhase(phase: GamePhase): void {
    this.set('phase', phase);
    this.commit();
  }

  notify(text: string, kind: HudNotification['kind'] = 'info', durationSec = 4, now = 0): void {
    const n: HudNotification = { id: this.nextNotifId++, text, kind, until: now + durationSec };
    this.hud.notifications = [...this.hud.notifications.slice(-4), n];
    this.dirty = true;
    this.commit();
  }

  /** Drop expired notifications / big text; call once per frame with the game clock. */
  pruneNotifications(now: number): void {
    if (this.hud.bigText && this.hud.bigText.until <= now) {
      this.hud.bigText = null;
      this.dirty = true;
    }
    const before = this.hud.notifications.length;
    if (!before) return;
    const kept = this.hud.notifications.filter((n) => n.until > now);
    if (kept.length !== before) {
      this.hud.notifications = kept;
      this.dirty = true;
    }
  }

  bigText(title: string, sub: string, durationSec: number, now: number, color = '#ffffff'): void {
    this.hud.bigText = { title, sub, until: now + durationSec, color };
    this.dirty = true;
    this.commit();
  }
}

export const store = new GameStore();
