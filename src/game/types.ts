/** Shared types for the racing game. */

export type QualityTier = 'low' | 'high';

export interface QualitySettings {
  tier: QualityTier;
  /** Upper bound applied to devicePixelRatio. */
  maxPixelRatio: number;
  shadows: boolean;
  shadowMapSize: number;
  /** Multiplier on scattered scenery counts. */
  sceneryDensity: number;
  /** Multiplier on particle budgets. */
  particleDensity: number;
  /** Lowest allowed adaptive resolution scale. */
  minResolutionScale: number;
  drawDistance: number;
}

export const QUALITY: Record<QualityTier, QualitySettings> = {
  high: {
    tier: 'high',
    maxPixelRatio: 2,
    shadows: true,
    shadowMapSize: 1024,
    sceneryDensity: 1,
    particleDensity: 1,
    minResolutionScale: 0.6,
    drawDistance: 620,
  },
  low: {
    tier: 'low',
    maxPixelRatio: 1.25,
    shadows: false,
    shadowMapSize: 512,
    sceneryDensity: 0.5,
    particleDensity: 0.5,
    minResolutionScale: 0.5,
    drawDistance: 460,
  },
};

export type GamePhase =
  | 'menu'
  | 'freeroam'
  | 'countdown'
  | 'racing'
  | 'finished'
  | 'paused';

export type CameraMode = 'chase' | 'hood' | 'cinematic';

/**
 * Mutable snapshot the engine writes every frame and the React HUD samples on a
 * slow interval. Never replaced, only mutated, so the frame loop allocates nothing.
 */
export interface HudState {
  phase: GamePhase;
  speedKmh: number;
  rpm01: number;
  gear: number;
  /** Position along the road, 0..1, used by the minimap. */
  carX: number;
  carZ: number;
  carHeading: number;
  offRoad: boolean;
  // Race
  checkpoint: number;
  checkpointTotal: number;
  raceTime: number;
  bestTime: number | null;
  lastTime: number | null;
  countdown: number;
  position: number;
  racerCount: number;
  eventId: string;
  wrongWay: boolean;
  /** Flat [x, z] pairs of rival cars, valid up to rivalCount. */
  rivals: Float32Array;
  rivalCount: number;
  nitro01: number;
  boosting: boolean;
  // Free roam
  driftScore: number;
  driftChain: number;
  driftActive: boolean;
  bankedScore: number;
  nearStartGate: boolean;
  // Diagnostics
  fps: number;
  resolutionScale: number;
  quality: QualityTier;
}

export const createHudState = (): HudState => ({
  phase: 'menu',
  speedKmh: 0,
  rpm01: 0,
  gear: 1,
  carX: 0,
  carZ: 0,
  carHeading: 0,
  offRoad: false,
  checkpoint: 0,
  checkpointTotal: 0,
  raceTime: 0,
  bestTime: null,
  lastTime: null,
  countdown: 0,
  position: 1,
  racerCount: 1,
  eventId: 'circuit',
  wrongWay: false,
  rivals: new Float32Array(8),
  rivalCount: 0,
  nitro01: 0,
  boosting: false,
  driftScore: 0,
  driftChain: 0,
  driftActive: false,
  bankedScore: 0,
  nearStartGate: false,
  fps: 60,
  resolutionScale: 1,
  quality: 'high',
});

export type BodyStyle = 'coupe' | 'muscle' | 'buggy';

export interface CarSpec {
  id: string;
  name: string;
  body: BodyStyle;
  color: number;
  accentColor: number;
  /** Peak engine force, newtons-ish. Tuned by feel, not realism. */
  power: number;
  mass: number;
  grip: number;
  /** How readily the rear steps out. Higher = more playful. */
  looseness: number;
  topSpeed: number;
}

export const CARS: CarSpec[] = [
  {
    id: 'horizon',
    name: 'Meridian GT',
    body: 'coupe',
    color: 0xff5a3c,
    accentColor: 0x1c1f26,
    power: 15200,
    mass: 1280,
    grip: 1.0,
    looseness: 1.0,
    topSpeed: 84,
  },
  {
    id: 'drifter',
    name: 'Kessel Drift',
    body: 'coupe',
    color: 0x36c7f0,
    accentColor: 0x14212b,
    power: 14200,
    mass: 1180,
    grip: 0.88,
    looseness: 1.45,
    topSpeed: 78,
  },
  {
    id: 'rally',
    name: 'Terra Rally',
    body: 'buggy',
    color: 0xf5d020,
    accentColor: 0x2b2415,
    power: 13600,
    mass: 1400,
    grip: 1.18,
    looseness: 0.78,
    topSpeed: 72,
  },
  {
    id: 'vulcan',
    name: 'Vulcan V8',
    body: 'muscle',
    color: 0x7b3fd4,
    accentColor: 0x191423,
    power: 16400,
    mass: 1520,
    grip: 0.94,
    looseness: 1.2,
    topSpeed: 88,
  },
  {
    id: 'dune',
    name: 'Dune Hopper',
    body: 'buggy',
    color: 0xff9530,
    accentColor: 0x2b1d10,
    power: 12800,
    mass: 1240,
    grip: 1.26,
    looseness: 0.9,
    topSpeed: 68,
  },
  {
    id: 'spectre',
    name: 'Spectre S',
    body: 'muscle',
    color: 0xe8ecef,
    accentColor: 0x0f3d2e,
    power: 15600,
    mass: 1360,
    grip: 1.06,
    looseness: 1.05,
    topSpeed: 82,
  },
];

/** 0..1 stat bars for the garage, normalized across the roster. */
export const carStats = (spec: CarSpec): { speed: number; grip: number; drift: number } => ({
  speed: (spec.topSpeed - 62) / 30,
  grip: (spec.grip - 0.8) / 0.55,
  drift: (spec.looseness - 0.6) / 0.95,
});
