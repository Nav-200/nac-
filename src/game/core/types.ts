/**
 * Shared data types. Runtime classes live in their own modules; these are the plain
 * records exchanged between world generation, physics, AI, rendering and UI.
 */
import type { BoxCollider } from './collision';

export type District = 'downtown' | 'midtown' | 'residential' | 'industrial' | 'park' | 'beach' | 'airfield' | 'harbor';

export const DISTRICT_NAMES: Record<District, string> = {
  downtown: 'Downtown',
  midtown: 'Midtown',
  residential: 'Maple Heights',
  industrial: 'Rustbelt Yards',
  park: 'Greenfield Park',
  beach: 'Sunset Shores',
  airfield: 'Redwing Airfield',
  harbor: 'Old Harbor',
};

// ---------- Road network ----------
export interface RoadNode {
  id: number;
  /** Grid indices. */
  gx: number;
  gz: number;
  x: number;
  z: number;
  /** Outgoing edge ids (edges are directed; each street has two). */
  out: number[];
  /** Incoming edge ids. */
  in: number[];
  /** Whether this node has a traffic light cycle (4-way intersections). */
  hasSignal: boolean;
  /** Signal phase offset in seconds. */
  signalOffset: number;
}

export interface Lane {
  /** Signed lateral offset from the edge centreline (positive = right of travel). */
  offset: number;
}

export interface RoadEdge {
  id: number;
  from: number;
  to: number;
  /** Unit direction from->to. */
  dx: number;
  dz: number;
  length: number;
  /** Half width of the asphalt (street or avenue). */
  halfWidth: number;
  isAvenue: boolean;
  /** Lanes travelling from->to, ordered inner (nearest centre) to outer. */
  lanes: Lane[];
  /** Id of the opposite-direction edge. */
  twin: number;
  /** Axis: true if the edge runs along X. */
  alongX: boolean;
}

export interface RoadNetwork {
  nodes: RoadNode[];
  edges: RoadEdge[];
  /** Lookup node id by grid indices (-1 if the intersection was removed). */
  nodeAt(gx: number, gz: number): number;
  /** Nearest node to a world position. */
  nearestNode(x: number, z: number): RoadNode;
  /** Nearest edge + projected t (0..1) and lateral distance. */
  nearestEdge(x: number, z: number): { edge: RoadEdge; t: number; lateral: number } | null;
}

// ---------- Static world ----------
export interface BuildingRecord {
  id: number;
  x: number; // centre
  z: number;
  w: number; // size along X
  d: number; // size along Z
  h: number;
  yaw: number;
  style: number; // facade style index
  district: District;
  collider: BoxCollider;
  /** Roof detail flags */
  hasAntenna: boolean;
  hasRoofBox: boolean;
  /** Optional stacked tiers above the base box (each centred, sitting on the previous). */
  tiers?: { w: number; d: number; h: number }[];
  /** Named landmark (hospital, police HQ, gun shop…). */
  name?: string;
}

export type PropKind =
  | 'lamp'
  | 'tree'
  | 'palm'
  | 'bush'
  | 'bench'
  | 'hydrant'
  | 'trash'
  | 'bollard'
  | 'sign'
  | 'container'
  | 'crate'
  | 'fence'
  | 'billboard'
  | 'crane'
  | 'ship'
  | 'plane'
  | 'hangar'
  | 'tower'
  | 'hut'
  | 'pier'
  | 'fountain'
  | 'trafficlight';

export type GroundKind = 'grass' | 'concrete' | 'sand' | 'dirt' | 'asphalt';

/** A raised ground slab (block interior + sidewalk ring). Top surface at SIDEWALK_HEIGHT. */
export interface SlabRecord {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  top: GroundKind;
  /** Draw a sidewalk-textured ring of SIDEWALK_WIDTH around the edge. */
  ring: boolean;
  district: District;
}

/** Flat decorative strip drawn just above a slab (paths, runway, boardwalk, parking). */
export interface DecalRecord {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  kind: 'path' | 'runway' | 'taxiway' | 'boardwalk' | 'parking' | 'helipad' | 'plaza';
}

export interface PropRecord {
  id: number;
  kind: PropKind;
  x: number;
  z: number;
  /** Base elevation (slab top, pier deck…). */
  y: number;
  yaw: number;
  scale: number;
  collider: BoxCollider | null;
  /** Health for breakable props (lamps, hydrants, trash) — null for indestructible. */
  health: number | null;
  /** Instance index in its InstancedMesh (set by the renderer). */
  instanceIndex: number;
  destroyed: boolean;
}

export interface ChunkRecord {
  cx: number;
  cz: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  buildings: BuildingRecord[];
  props: PropRecord[];
  district: District;
}

export interface WaterArea {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface PickupSpawn {
  id: number;
  kind: 'health' | 'armor' | 'money' | 'weapon';
  weaponId?: WeaponId;
  x: number;
  z: number;
  amount: number;
}

export type MissionType = 'delivery' | 'race' | 'hit' | 'taxi' | 'vigilante' | 'rampage' | 'courier';

export interface MissionSpawn {
  id: string;
  type: MissionType;
  x: number;
  z: number;
  title: string;
}

export type PoiIcon = 'hospital' | 'police' | 'gun' | 'taxi' | 'airport' | 'harbor' | 'park' | 'beach' | 'plaza' | 'spawn' | 'garage';

export interface Poi {
  name: string;
  x: number;
  z: number;
  icon: PoiIcon;
}

export interface ParkingSpot {
  x: number;
  z: number;
  yaw: number;
  district: District;
}

export interface WorldData {
  seed: number;
  roads: RoadNetwork;
  buildings: BuildingRecord[];
  props: PropRecord[];
  chunks: ChunkRecord[];
  slabs: SlabRecord[];
  decals: DecalRecord[];
  water: WaterArea[];
  /** Static boundary / shoreline / pier-rail walls. */
  walls: BoxCollider[];
  /** District of each block, indexed [bz * (GRID_N-1) + bx]. */
  blockDistrict: District[];
  districtAt(x: number, z: number): District;
  /** True when (x,z) is on asphalt (road or intersection). */
  isRoadAt(x: number, z: number): boolean;
  /** Walkable ground elevation at (x,z): 0 on roads, SIDEWALK_HEIGHT on slabs, pier deck height on piers. */
  groundHeightAt(x: number, z: number): number;
  /** True if (x,z) is over deep water (outside the shoreline wall or in the ocean). */
  isWaterAt(x: number, z: number): boolean;
  pickups: PickupSpawn[];
  missions: MissionSpawn[];
  parkingSpots: ParkingSpot[];
  poi: Poi[];
  hospital: { x: number; z: number };
  playerSpawn: { x: number; z: number; yaw: number };
  gunShops: { x: number; z: number }[];
  policeStations: { x: number; z: number }[];
}

// ---------- Vehicles ----------
export type VehicleType = 'compact' | 'sedan' | 'taxi' | 'sports' | 'suv' | 'pickup' | 'van' | 'truck' | 'bus' | 'police';

export interface VehicleSpec {
  type: VehicleType;
  name: string;
  length: number;
  width: number;
  height: number;
  mass: number;
  /** Top speed in m/s (forward). */
  maxSpeed: number;
  /** Peak engine acceleration m/s². */
  accel: number;
  brake: number;
  /** Lateral grip: how quickly sideways velocity is killed (1/s). */
  grip: number;
  /** Max steer angle (rad) at low speed. */
  steerMax: number;
  /** How fast the wheels turn toward the target angle (rad/s). */
  steerRate: number;
  /** Hit points before the vehicle catches fire / explodes. */
  health: number;
  /** Cosmetic. */
  colors: string[] | null; // null = fixed livery
  seats: number;
  /** Spawn weight in traffic. */
  trafficWeight: number;
  /** Cabin y-offset for the camera / driver. */
  cabinHeight: number;
  price: number;
}

export const VEHICLE_SPECS: Record<VehicleType, VehicleSpec> = {
  compact: { type: 'compact', name: 'Pico', length: 3.6, width: 1.7, height: 1.5, mass: 900, maxSpeed: 36, accel: 7, brake: 18, grip: 7, steerMax: 0.62, steerRate: 3.2, health: 250, colors: null, seats: 2, trafficWeight: 5, cabinHeight: 1.2, price: 8000 },
  sedan: { type: 'sedan', name: 'Stallion GT', length: 4.6, width: 1.85, height: 1.45, mass: 1400, maxSpeed: 44, accel: 8.5, brake: 20, grip: 7.5, steerMax: 0.58, steerRate: 3.0, health: 320, colors: null, seats: 4, trafficWeight: 8, cabinHeight: 1.15, price: 18000 },
  taxi: { type: 'taxi', name: 'Cabbie', length: 4.6, width: 1.85, height: 1.5, mass: 1450, maxSpeed: 42, accel: 8, brake: 20, grip: 7.5, steerMax: 0.58, steerRate: 3.0, health: 320, colors: ['#f7c600'], seats: 4, trafficWeight: 4, cabinHeight: 1.15, price: 14000 },
  sports: { type: 'sports', name: 'Comet R', length: 4.3, width: 1.9, height: 1.2, mass: 1250, maxSpeed: 62, accel: 13, brake: 26, grip: 9.5, steerMax: 0.55, steerRate: 3.6, health: 260, colors: null, seats: 2, trafficWeight: 2, cabinHeight: 0.95, price: 95000 },
  suv: { type: 'suv', name: 'Ranger XL', length: 4.9, width: 2.0, height: 1.85, mass: 2100, maxSpeed: 41, accel: 7.5, brake: 19, grip: 6.5, steerMax: 0.55, steerRate: 2.8, health: 420, colors: null, seats: 4, trafficWeight: 5, cabinHeight: 1.5, price: 32000 },
  pickup: { type: 'pickup', name: 'Bobcat', length: 5.3, width: 2.0, height: 1.9, mass: 2200, maxSpeed: 39, accel: 7, brake: 18, grip: 6.2, steerMax: 0.52, steerRate: 2.7, health: 450, colors: null, seats: 2, trafficWeight: 4, cabinHeight: 1.55, price: 26000 },
  van: { type: 'van', name: 'Boxer', length: 5.2, width: 2.05, height: 2.3, mass: 2300, maxSpeed: 35, accel: 6, brake: 17, grip: 5.8, steerMax: 0.5, steerRate: 2.5, health: 480, colors: null, seats: 2, trafficWeight: 3, cabinHeight: 1.7, price: 22000 },
  truck: { type: 'truck', name: 'Hauler', length: 8.0, width: 2.5, height: 3.4, mass: 6000, maxSpeed: 30, accel: 4.5, brake: 14, grip: 5, steerMax: 0.45, steerRate: 2.0, health: 900, colors: null, seats: 2, trafficWeight: 2, cabinHeight: 2.4, price: 60000 },
  bus: { type: 'bus', name: 'Metro Bus', length: 11.0, width: 2.6, height: 3.2, mass: 9000, maxSpeed: 27, accel: 3.8, brake: 12, grip: 4.8, steerMax: 0.42, steerRate: 1.8, health: 1200, colors: ['#2f6fd6'], seats: 6, trafficWeight: 1, cabinHeight: 2.2, price: 80000 },
  police: { type: 'police', name: 'Interceptor', length: 4.8, width: 1.9, height: 1.5, mass: 1600, maxSpeed: 54, accel: 11, brake: 24, grip: 8.5, steerMax: 0.58, steerRate: 3.4, health: 380, colors: ['#ffffff'], seats: 4, trafficWeight: 0, cabinHeight: 1.15, price: 0 },
};

export const TRAFFIC_VEHICLE_TYPES: VehicleType[] = ['compact', 'sedan', 'taxi', 'sports', 'suv', 'pickup', 'van', 'truck', 'bus'];

// ---------- Weapons ----------
export type WeaponId = 'fist' | 'bat' | 'pistol' | 'smg' | 'shotgun' | 'rifle' | 'sniper' | 'rpg';

export interface WeaponSpec {
  id: WeaponId;
  name: string;
  slot: number;
  /** Damage per bullet/pellet. */
  damage: number;
  /** Seconds between shots. */
  fireInterval: number;
  automatic: boolean;
  clipSize: number; // 0 = melee
  maxReserve: number;
  reloadTime: number;
  range: number;
  /** Spread in radians (cone half-angle) when hip firing; aiming halves it. */
  spread: number;
  pellets: number;
  /** Damage multiplier against vehicles. */
  vehicleDamageMul: number;
  /** Explosive radius (m); 0 = none. */
  explosionRadius: number;
  /** Bullet impulse applied to hit pedestrians/vehicles. */
  knockback: number;
  price: number;
  /** Can be fired from the driver seat (drive-by). */
  driveBy: boolean;
}

export const WEAPON_SPECS: Record<WeaponId, WeaponSpec> = {
  fist: { id: 'fist', name: 'Fists', slot: 0, damage: 12, fireInterval: 0.45, automatic: false, clipSize: 0, maxReserve: 0, reloadTime: 0, range: 1.7, spread: 0, pellets: 1, vehicleDamageMul: 0.2, explosionRadius: 0, knockback: 3, price: 0, driveBy: false },
  bat: { id: 'bat', name: 'Baseball Bat', slot: 0, damage: 34, fireInterval: 0.6, automatic: false, clipSize: 0, maxReserve: 0, reloadTime: 0, range: 2.1, spread: 0, pellets: 1, vehicleDamageMul: 0.6, explosionRadius: 0, knockback: 6, price: 150, driveBy: false },
  pistol: { id: 'pistol', name: 'Pistol', slot: 1, damage: 26, fireInterval: 0.22, automatic: false, clipSize: 12, maxReserve: 144, reloadTime: 1.2, range: 90, spread: 0.018, pellets: 1, vehicleDamageMul: 0.5, explosionRadius: 0, knockback: 2, price: 400, driveBy: true },
  smg: { id: 'smg', name: 'SMG', slot: 2, damage: 14, fireInterval: 0.075, automatic: true, clipSize: 30, maxReserve: 300, reloadTime: 1.6, range: 80, spread: 0.035, pellets: 1, vehicleDamageMul: 0.5, explosionRadius: 0, knockback: 1.5, price: 1200, driveBy: true },
  shotgun: { id: 'shotgun', name: 'Shotgun', slot: 3, damage: 11, fireInterval: 0.85, automatic: false, clipSize: 8, maxReserve: 64, reloadTime: 2.2, range: 35, spread: 0.06, pellets: 9, vehicleDamageMul: 0.7, explosionRadius: 0, knockback: 10, price: 1500, driveBy: false },
  rifle: { id: 'rifle', name: 'Assault Rifle', slot: 4, damage: 30, fireInterval: 0.11, automatic: true, clipSize: 30, maxReserve: 240, reloadTime: 2.0, range: 160, spread: 0.02, pellets: 1, vehicleDamageMul: 0.9, explosionRadius: 0, knockback: 3, price: 3500, driveBy: false },
  sniper: { id: 'sniper', name: 'Sniper Rifle', slot: 5, damage: 120, fireInterval: 1.3, automatic: false, clipSize: 5, maxReserve: 40, reloadTime: 2.6, range: 400, spread: 0.002, pellets: 1, vehicleDamageMul: 1.2, explosionRadius: 0, knockback: 8, price: 6000, driveBy: false },
  rpg: { id: 'rpg', name: 'Rocket Launcher', slot: 6, damage: 250, fireInterval: 1.8, automatic: false, clipSize: 1, maxReserve: 10, reloadTime: 2.8, range: 250, spread: 0.004, pellets: 1, vehicleDamageMul: 3, explosionRadius: 7, knockback: 20, price: 12000, driveBy: false },
};

export const WEAPON_ORDER: WeaponId[] = ['fist', 'bat', 'pistol', 'smg', 'shotgun', 'rifle', 'sniper', 'rpg'];

// ---------- Events ----------
export type GameEventType =
  | 'shotFired'
  | 'pedHit'
  | 'pedKilled'
  | 'vehicleDestroyed'
  | 'carjack'
  | 'policeHit'
  | 'policeKilled'
  | 'explosion'
  | 'pickup'
  | 'missionStarted'
  | 'missionCompleted'
  | 'missionFailed'
  | 'playerDied'
  | 'playerDamaged'
  | 'vehicleEntered'
  | 'vehicleExited'
  | 'impact';

export interface GameEvent {
  type: GameEventType;
  x: number;
  y: number;
  z: number;
  /** Optional magnitude (damage, money, impact speed…). */
  value?: number;
  /** Optional payload id (vehicle id, ped id, weapon id, mission id). */
  ref?: number | string;
  byPlayer?: boolean;
}
