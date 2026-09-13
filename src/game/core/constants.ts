/**
 * Global tuning constants. Distances in metres, time in seconds, angles in radians.
 * The map is a flat XZ plane; +Y is up. Yaw 0 faces +Z, increasing toward +X.
 */

// ---------- World layout ----------
/** Distance between adjacent intersection centres. */
export const BLOCK_PITCH = 80;
/** Number of intersections along each axis (grid is GRID_N x GRID_N). */
export const GRID_N = 26; // 25 blocks * 80 m = 2000 m across
export const WORLD_HALF = ((GRID_N - 1) * BLOCK_PITCH) / 2; // 1000 m
export const WORLD_SIZE = WORLD_HALF * 2;
/** Every AVENUE_EVERY-th grid line is a wide avenue. */
export const AVENUE_EVERY = 4;
/** Half widths of the drivable asphalt. */
export const STREET_HALF_WIDTH = 5; // 2 lanes (one each way) 10 m total
export const AVENUE_HALF_WIDTH = 9; // 4 lanes 18 m total
export const LANE_WIDTH = 3.5;
export const SIDEWALK_WIDTH = 3;
export const SIDEWALK_HEIGHT = 0.15;
/** Extra margin between sidewalk and building fronts. */
export const LOT_SETBACK = 1.0;
/** World is split into square chunks for culling / streaming of static geometry. */
export const CHUNK_SIZE = BLOCK_PITCH * 3; // 240 m
export const CHUNKS_PER_SIDE = Math.ceil(WORLD_SIZE / CHUNK_SIZE) + 1;
/** Invisible boundary wall thickness to keep entities inside the map. */
export const WORLD_BOUNDARY_MARGIN = 20;

// ---------- Simulation ----------
export const FIXED_DT = 1 / 60;
export const MAX_SUBSTEPS = 4;
export const GRAVITY = 20;
/** Radius (m) around the player where NPC traffic/pedestrians are kept alive. */
export const SIM_RADIUS = 220;
export const SPAWN_RADIUS_MIN = 90;
export const SPAWN_RADIUS_MAX = 200;
export const DESPAWN_RADIUS = 260;
export const MAX_PEDESTRIANS = 60;
export const MAX_TRAFFIC = 34;
export const MAX_POLICE_VEHICLES = 8;
export const MAX_BULLET_TRACERS = 48;
export const MAX_PARTICLES = 600;

// ---------- Player ----------
export const PLAYER_RADIUS = 0.4;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_WALK_SPEED = 4.2;
export const PLAYER_RUN_SPEED = 7.5;
export const PLAYER_AIM_SPEED = 2.6;
export const PLAYER_ACCEL = 28;
export const PLAYER_JUMP_SPEED = 7.5;
export const PLAYER_MAX_HEALTH = 100;
export const PLAYER_MAX_ARMOR = 100;
export const PLAYER_REGEN_DELAY = 8; // seconds without damage before regen to 50%
export const PLAYER_REGEN_RATE = 4; // hp/s up to 50
export const PLAYER_INTERACT_RANGE = 3.2;
export const VEHICLE_ENTER_RANGE = 4.5;

// ---------- Camera ----------
export const CAM_FOLLOW_DIST_FOOT = 4.2;
export const CAM_FOLLOW_HEIGHT_FOOT = 1.9;
export const CAM_AIM_DIST = 2.2;
export const CAM_AIM_SIDE = 0.65;
export const CAM_FOLLOW_DIST_CAR = 7.5;
export const CAM_FOLLOW_HEIGHT_CAR = 2.8;
export const CAM_FOV = 65;
export const CAM_AIM_FOV = 45;
export const CAM_PITCH_MIN = -0.9;
export const CAM_PITCH_MAX = 1.1;
export const MOUSE_SENS = 0.0022;
export const CAM_NEAR = 0.2;
export const CAM_FAR = 1400;

// ---------- Day / night ----------
/** Real seconds for a full in-game day. */
export const DAY_LENGTH_SEC = 24 * 60; // 24 minutes
export const START_TIME_OF_DAY = 0.42; // ~10:00

// ---------- Wanted system ----------
export const WANTED_THRESHOLDS = [0, 60, 200, 450, 900, 1600]; // heat needed for stars 0..5
export const WANTED_DECAY_PER_SEC = 6; // heat/s when out of sight
export const WANTED_OUT_OF_SIGHT_DELAY = 10; // seconds without police LOS before decay
export const HEAT = {
  shotFired: 4,
  hitPed: 40,
  killPed: 90,
  carjack: 60,
  hitPedWithCar: 50,
  destroyVehicle: 120,
  shootPolice: 120,
  killPolice: 260,
  destroyPoliceVehicle: 300,
} as const;
export const POLICE_PER_STAR = [0, 1, 2, 3, 5, 7]; // police vehicles alive at each star level
export const COPS_ON_FOOT_PER_STAR = [0, 2, 4, 6, 8, 10];

// ---------- Economy ----------
export const START_MONEY = 500;
export const DEATH_MONEY_LOSS_FRAC = 0.1;
export const PICKUP_RESPAWN_SEC = 90;
export const HOSPITAL_POS: [number, number] = [-40, 120];
export const SPAWN_POS: [number, number, number] = [12, 0, 12];
export const SAVE_KEY = 'open-city-save-v1';

// ---------- Rendering ----------
export const SHADOW_MAP_SIZE = 2048;
export const SHADOW_RADIUS = 90;
export const FOG_NEAR_DAY = 400;
export const FOG_FAR_DAY = 1300;
export const FOG_NEAR_NIGHT = 150;
export const FOG_FAR_NIGHT = 700;
