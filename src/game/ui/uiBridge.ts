/**
 * Contract between the React UI and the engine. The Game installs an implementation via
 * setUiBridge(); UI components only ever talk to this object (plus the read-only HUD store).
 */
import type { WeaponId, WorldData } from '../core/types';

export type BlipKind = 'player' | 'vehicle' | 'police' | 'ped' | 'pickup' | 'mission' | 'target' | 'waypoint' | 'checkpoint' | 'gunshop' | 'hospital' | 'poi' | 'objective' | 'passenger' | 'cop';

export interface MinimapBlip {
  x: number;
  z: number;
  kind: BlipKind;
  /** CSS colour override. */
  color?: string;
  /** Heading in radians (yaw 0 = +Z) for directional blips. */
  heading?: number;
  /** Optional short label for the full map. */
  label?: string;
}

export interface MinimapState {
  x: number;
  z: number;
  /** Player / vehicle heading (yaw 0 = +Z, increasing toward +X). */
  yaw: number;
  /** Camera look yaw (same convention). The minimap rotates so the camera direction points up. */
  camYaw: number;
  inVehicle: boolean;
  blips: MinimapBlip[];
  /** GPS route polyline as flat [x0, z0, x1, z1, ...] in world coordinates (empty = none). */
  route: number[];
  waypoint: { x: number; z: number } | null;
  wanted: number;
  /** World-space radius shown by the minimap (metres). */
  zoomRadius: number;
}

export interface UiSettings {
  sensitivity: number; // 0.3 .. 3
  shadows: boolean;
  quality: 'low' | 'medium' | 'high';
  masterVolume: number;
  sfxVolume: number;
  musicVolume: number;
  invertY: boolean;
  showFps: boolean;
}

export interface ShopItem {
  id: WeaponId;
  name: string;
  price: number;
  ammoPrice: number;
  ammoAmount: number;
  owned: boolean;
  clipSize: number;
}

export interface MissionSummary {
  id: string;
  title: string;
  type: string;
  x: number;
  z: number;
  done: boolean;
  bestTime: number | null;
}

export interface UiBridge {
  world(): WorldData | null;
  /** Called every animation frame by the minimap; must be cheap. */
  minimap(): MinimapState;
  start(): void;
  resume(): void;
  pause(): void;
  /** Toggle the full-screen map. */
  toggleMap(): void;
  respawn(): void;
  newGame(): void;
  setWaypoint(x: number, z: number): void;
  clearWaypoint(): void;
  settings(): UiSettings;
  applySettings(patch: Partial<UiSettings>): void;
  radioStations(): string[];
  radioStation(): number;
  setRadioStation(i: number): void;
  shopItems(): ShopItem[];
  buyWeapon(id: WeaponId): boolean;
  buyAmmo(id: WeaponId): boolean;
  buyArmor(): boolean;
  buyHealth(): boolean;
  closeShop(): void;
  missions(): MissionSummary[];
  requestPointerLock(): void;
  /** Player money (for the shop). */
  money(): number;
  /** Stats summary for the pause menu. */
  stats(): { kills: number; vehiclesStolen: number; missionsDone: number; distanceKm: number; maxWanted: number; deaths: number; moneyEarned: number; playTimeSec: number };
  setCameraMode(mode: 'near' | 'far' | 'first'): void;
}

let bridge: UiBridge | null = null;

export function setUiBridge(b: UiBridge | null): void {
  bridge = b;
}

export function getUiBridge(): UiBridge | null {
  return bridge;
}
