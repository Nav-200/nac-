/**
 * Procedural city generator. Deterministic for a given seed.
 *
 * Layout: a 25x25 block grid (80 m pitch, 2 km across) with avenues every 4th line.
 * Districts: downtown towers in the centre, a midtown ring, residential north/west,
 * industrial south/west, a park superblock, an airfield superblock, a harbor in the
 * south-east and a beach + ocean along the east edge.
 */
import {
  AVENUE_HALF_WIDTH,
  BLOCK_PITCH,
  CHUNK_SIZE,
  GRID_N,
  LOT_SETBACK,
  SIDEWALK_HEIGHT,
  SIDEWALK_WIDTH,
  WORLD_BOUNDARY_MARGIN,
  WORLD_HALF,
} from '../core/constants';
import { makeBox, type BoxCollider } from '../core/collision';
import { Rng } from '../core/rng';
import type {
  BuildingRecord,
  ChunkRecord,
  DecalRecord,
  District,
  MissionSpawn,
  ParkingSpot,
  PickupSpawn,
  Poi,
  PropKind,
  PropRecord,
  SlabRecord,
  WaterArea,
  WeaponId,
  WorldData,
} from '../core/types';
import { GridRoadNetwork, edgeKey, gridToWorld, isAvenueLine, lineHalfWidth, nodeKey, rightOf, worldToGrid } from './roadNetwork';

const BLOCKS = GRID_N - 1; // 25
export const SHORE_X = 930; // water starts here
export const PIER_DECK_Y = 0.35;
export const WATER_Y = -0.12;

interface Region {
  kind: 'park' | 'airfield' | 'plaza';
  bx0: number;
  bz0: number;
  bx1: number;
  bz1: number;
}

const REGIONS: Region[] = [
  { kind: 'park', bx0: 14, bz0: 5, bx1: 17, bz1: 8 },
  { kind: 'airfield', bx0: 5, bz0: 21, bx1: 11, bz1: 23 },
  { kind: 'plaza', bx0: 12, bz0: 12, bx1: 12, bz1: 12 },
];

const PIERS = [
  { z: -330, halfWidth: 4, x0: SHORE_X - 10, x1: SHORE_X + 95 },
  { z: 420, halfWidth: 4, x0: SHORE_X - 10, x1: SHORE_X + 80 },
];

interface SpecialBlock {
  bx: number;
  bz: number;
  name: string;
  style: number;
  h: number;
  icon: Poi['icon'];
  poiName: string;
  kind: 'hospital' | 'police' | 'gun' | 'taxi' | 'garage';
}

const SPECIAL_BLOCKS: SpecialBlock[] = [
  { bx: 10, bz: 7, name: 'General Hospital', style: 5, h: 16, icon: 'hospital', poiName: 'General Hospital', kind: 'hospital' },
  { bx: 16, bz: 10, name: 'Police HQ', style: 2, h: 20, icon: 'police', poiName: 'Police HQ', kind: 'police' },
  { bx: 7, bz: 12, name: 'Ammu-Nation', style: 6, h: 8, icon: 'gun', poiName: 'Ammu-Nation (Midtown)', kind: 'gun' },
  { bx: 4, bz: 20, name: 'Ammu-Nation', style: 6, h: 8, icon: 'gun', poiName: 'Ammu-Nation (Rustbelt)', kind: 'gun' },
  { bx: 20, bz: 3, name: 'Ammu-Nation', style: 6, h: 7, icon: 'gun', poiName: 'Ammu-Nation (Heights)', kind: 'gun' },
  { bx: 17, bz: 13, name: 'Cabbie Depot', style: 5, h: 9, icon: 'taxi', poiName: 'Cabbie Depot', kind: 'taxi' },
  { bx: 3, bz: 6, name: 'Pay n Spray', style: 4, h: 7, icon: 'garage', poiName: 'Pay n Spray', kind: 'garage' },
];

export function districtOfBlock(bx: number, bz: number): District {
  if (bx >= 23) return 'beach';
  for (const r of REGIONS) {
    if (bx >= r.bx0 && bx <= r.bx1 && bz >= r.bz0 && bz <= r.bz1) {
      if (r.kind === 'park') return 'park';
      if (r.kind === 'airfield') return 'airfield';
      return 'downtown';
    }
  }
  if (bx >= 18 && bx <= 22 && bz >= 21) return 'harbor';
  if (bx >= 9 && bx <= 15 && bz >= 9 && bz <= 15) return 'downtown';
  if (bx >= 6 && bx <= 18 && bz >= 6 && bz <= 18) return 'midtown';
  if (bz >= 19 && bx <= 17) return 'industrial';
  if (bx <= 3 && bz >= 11) return 'industrial';
  return 'residential';
}

function regionAt(bx: number, bz: number): Region | null {
  for (const r of REGIONS) if (bx >= r.bx0 && bx <= r.bx1 && bz >= r.bz0 && bz <= r.bz1) return r;
  return null;
}

function slabTopFor(d: District): SlabRecord['top'] {
  switch (d) {
    case 'downtown':
    case 'midtown':
    case 'harbor':
    case 'industrial':
      return 'concrete';
    case 'park':
    case 'residential':
      return 'grass';
    case 'beach':
      return 'sand';
    case 'airfield':
      return 'concrete';
  }
}

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export class CityGenerator {
  private rng: Rng;
  private buildings: BuildingRecord[] = [];
  private props: PropRecord[] = [];
  private slabs: SlabRecord[] = [];
  private decals: DecalRecord[] = [];
  private water: WaterArea[] = [];
  private walls: BoxCollider[] = [];
  private pickups: PickupSpawn[] = [];
  private missions: MissionSpawn[] = [];
  private parking: ParkingSpot[] = [];
  private poi: Poi[] = [];
  private gunShops: { x: number; z: number }[] = [];
  private policeStations: { x: number; z: number }[] = [];
  private hospital = { x: 0, z: 0 };
  private blockDistrict: District[] = [];
  private nextBuildingId = 1;
  private nextPropId = 1;
  private roads!: GridRoadNetwork;

  constructor(public readonly seed: number) {
    this.rng = new Rng(seed);
  }

  generate(): WorldData {
    const removedNodes = new Set<number>();
    const removedEdges = new Set<string>();
    // Region interiors have no roads.
    for (const r of REGIONS) {
      for (let gx = r.bx0 + 1; gx <= r.bx1; gx++) for (let gz = r.bz0 + 1; gz <= r.bz1; gz++) removedNodes.add(nodeKey(gx, gz));
    }
    // Beach / ocean: no roads east of the coastal road.
    for (let gz = 0; gz < GRID_N; gz++) {
      removedNodes.add(nodeKey(24, gz));
      removedNodes.add(nodeKey(25, gz));
    }
    // Residential variety: drop some minor street segments (never avenues, never near removed nodes).
    const vr = this.rng.fork(1);
    for (let bz = 0; bz < BLOCKS; bz++) {
      for (let bx = 0; bx < BLOCKS; bx++) {
        if (districtOfBlock(bx, bz) !== 'residential') continue;
        // segment on vertical line gx=bx+1 between gz=bz and bz+1
        if (!isAvenueLine(bx + 1) && bx + 1 < 23 && vr.chance(0.1) && districtOfBlock(bx + 1, bz) === 'residential') {
          removedEdges.add(edgeKey(nodeKey(bx + 1, bz), nodeKey(bx + 1, bz + 1)));
        }
        if (!isAvenueLine(bz + 1) && vr.chance(0.1) && districtOfBlock(bx, bz + 1) === 'residential') {
          removedEdges.add(edgeKey(nodeKey(bx, bz + 1), nodeKey(bx + 1, bz + 1)));
        }
      }
    }
    // Never remove both edges around one node leaving degree < 2: validate.
    this.roads = new GridRoadNetwork({ removedNodes, removedEdges });
    for (const n of this.roads.nodes) {
      if (n.out.length < 2) {
        // Dead end: restore by rebuilding without removed edges touching this node.
        for (const k of Array.from(removedEdges)) {
          const [a, b] = k.split('-').map(Number);
          if (a === nodeKey(n.gx, n.gz) || b === nodeKey(n.gx, n.gz)) removedEdges.delete(k);
        }
      }
    }
    this.roads = new GridRoadNetwork({ removedNodes, removedEdges });

    for (let bz = 0; bz < BLOCKS; bz++) for (let bx = 0; bx < BLOCKS; bx++) this.blockDistrict.push(districtOfBlock(bx, bz));

    this.buildSlabsAndBlocks();
    this.buildRegions();
    this.buildBeachAndOcean();
    this.buildStreetFurniture();
    this.buildBoundary();
    this.placePickups();
    this.placeMissionsAndPoi();

    const chunks = this.buildChunks();
    const roads = this.roads;
    const blockDistrict = this.blockDistrict;
    const piers = PIERS;
    const isRoadAt = (x: number, z: number): boolean => this.isRoadAt(x, z);
    const world: WorldData = {
      seed: this.seed,
      roads,
      buildings: this.buildings,
      props: this.props,
      chunks,
      slabs: this.slabs,
      decals: this.decals,
      water: this.water,
      walls: this.walls,
      blockDistrict,
      districtAt(x: number, z: number): District {
        const bx = Math.floor(worldToGrid(x));
        const bz = Math.floor(worldToGrid(z));
        if (bx < 0 || bz < 0 || bx >= BLOCKS || bz >= BLOCKS) return x >= WORLD_HALF - BLOCK_PITCH ? 'beach' : 'residential';
        return blockDistrict[bz * BLOCKS + bx];
      },
      isRoadAt,
      groundHeightAt(x: number, z: number): number {
        for (const p of piers) {
          if (x >= p.x0 && x <= p.x1 && Math.abs(z - p.z) <= p.halfWidth) return PIER_DECK_Y;
        }
        if (x > SHORE_X) return WATER_Y;
        return isRoadAt(x, z) ? 0 : SIDEWALK_HEIGHT;
      },
      isWaterAt(x: number, z: number): boolean {
        if (x <= SHORE_X) return false;
        for (const p of piers) if (x >= p.x0 && x <= p.x1 && Math.abs(z - p.z) <= p.halfWidth) return false;
        return true;
      },
      pickups: this.pickups,
      missions: this.missions,
      parkingSpots: this.parking,
      poi: this.poi,
      hospital: this.hospital,
      playerSpawn: { x: -18, z: 22, yaw: Math.PI * 0.25 },
      gunShops: this.gunShops,
      policeStations: this.policeStations,
    };
    return world;
  }

  // ---------------------------------------------------------------- roads
  isRoadAt(x: number, z: number): boolean {
    const gxf = worldToGrid(x);
    const gzf = worldToGrid(z);
    const gxn = Math.round(gxf);
    const gzn = Math.round(gzf);
    // Intersection square
    if (gxn >= 0 && gxn < GRID_N && gzn >= 0 && gzn < GRID_N) {
      const nid = this.roads.nodeAt(gxn, gzn);
      if (nid >= 0 && Math.abs(x - gridToWorld(gxn)) <= lineHalfWidth(gxn) && Math.abs(z - gridToWorld(gzn)) <= lineHalfWidth(gzn)) return true;
    }
    // Vertical road on line gxn
    if (gxn >= 0 && gxn < GRID_N && Math.abs(x - gridToWorld(gxn)) <= lineHalfWidth(gxn)) {
      const seg = Math.floor(gzf);
      if (this.roads.hasEdgeOnLine(false, gxn, seg)) return true;
    }
    // Horizontal road on line gzn
    if (gzn >= 0 && gzn < GRID_N && Math.abs(z - gridToWorld(gzn)) <= lineHalfWidth(gzn)) {
      const seg = Math.floor(gxf);
      if (this.roads.hasEdgeOnLine(true, gzn, seg)) return true;
    }
    return false;
  }

  /** Slab rectangle of a block, accounting for road widths and missing streets. */
  private blockSlabRect(bx: number, bz: number): Rect {
    const xA = gridToWorld(bx);
    const xB = gridToWorld(bx + 1);
    const zA = gridToWorld(bz);
    const zB = gridToWorld(bz + 1);
    // Left edge: vertical line gx=bx between gz=bz..bz+1
    const leftRoad = this.roads.hasEdgeOnLine(false, bx, bz);
    const rightRoad = this.roads.hasEdgeOnLine(false, bx + 1, bz);
    const topRoad = this.roads.hasEdgeOnLine(true, bz, bx);
    const botRoad = this.roads.hasEdgeOnLine(true, bz + 1, bx);
    return {
      x0: leftRoad ? xA + lineHalfWidth(bx) : xA,
      x1: rightRoad ? xB - lineHalfWidth(bx + 1) : xB,
      z0: topRoad ? zA + lineHalfWidth(bz) : zA,
      z1: botRoad ? zB - lineHalfWidth(bz + 1) : zB,
    };
  }

  private regionRect(r: Region): Rect {
    return {
      x0: gridToWorld(r.bx0) + lineHalfWidth(r.bx0),
      x1: gridToWorld(r.bx1 + 1) - lineHalfWidth(r.bx1 + 1),
      z0: gridToWorld(r.bz0) + lineHalfWidth(r.bz0),
      z1: gridToWorld(r.bz1 + 1) - lineHalfWidth(r.bz1 + 1),
    };
  }

  // ---------------------------------------------------------------- blocks
  private buildSlabsAndBlocks(): void {
    for (let bz = 0; bz < BLOCKS; bz++) {
      for (let bx = 0; bx < BLOCKS; bx++) {
        const d = districtOfBlock(bx, bz);
        if (d === 'beach') continue;
        if (regionAt(bx, bz)) continue;
        const rect = this.blockSlabRect(bx, bz);
        this.slabs.push({ minX: rect.x0, minZ: rect.z0, maxX: rect.x1, maxZ: rect.z1, top: slabTopFor(d), ring: true, district: d });
        const lot: Rect = { x0: rect.x0 + SIDEWALK_WIDTH + LOT_SETBACK, z0: rect.z0 + SIDEWALK_WIDTH + LOT_SETBACK, x1: rect.x1 - SIDEWALK_WIDTH - LOT_SETBACK, z1: rect.z1 - SIDEWALK_WIDTH - LOT_SETBACK };
        const special = SPECIAL_BLOCKS.find((s) => s.bx === bx && s.bz === bz);
        const rng = this.rng.fork(1000 + bz * 100 + bx);
        if (special) this.buildSpecialBlock(lot, special, d, rng, rect);
        else this.buildBlock(lot, d, rng, bx, bz);
      }
    }
    // Outer margins (west/north/south) so the world doesn't end at a road.
    const edge = WORLD_HALF + WORLD_BOUNDARY_MARGIN;
    const w0 = -WORLD_HALF - lineHalfWidth(0);
    this.slabs.push({ minX: -edge, minZ: -edge, maxX: w0, maxZ: edge, top: 'grass', ring: true, district: 'residential' });
    this.slabs.push({ minX: w0, minZ: -edge, maxX: SHORE_X, maxZ: w0, top: 'grass', ring: true, district: 'residential' });
    this.slabs.push({ minX: w0, minZ: WORLD_HALF + lineHalfWidth(GRID_N - 1), maxX: SHORE_X, maxZ: edge, top: 'dirt', ring: true, district: 'industrial' });
  }

  private addBuilding(x: number, z: number, w: number, d: number, h: number, style: number, district: District, rng: Rng, extra?: Partial<BuildingRecord>): BuildingRecord {
    const b: BuildingRecord = {
      id: this.nextBuildingId++,
      x,
      z,
      w,
      d,
      h,
      yaw: 0,
      style,
      district,
      collider: makeBox('building', x, z, w / 2, d / 2, 0, h + SIDEWALK_HEIGHT),
      hasAntenna: h > 40 && rng.chance(0.5),
      hasRoofBox: h > 15 && rng.chance(0.6),
      ...extra,
    };
    this.buildings.push(b);
    return b;
  }

  private addProp(kind: PropKind, x: number, z: number, yaw: number, scale: number, y = SIDEWALK_HEIGHT): PropRecord {
    let collider: BoxCollider | null = null;
    let health: number | null = null;
    switch (kind) {
      case 'lamp':
        collider = makeBox('lamp', x, z, 0.18, 0.18, yaw, 7);
        health = 40;
        break;
      case 'trafficlight':
        collider = makeBox('lamp', x, z, 0.2, 0.2, yaw, 5);
        health = 60;
        break;
      case 'tree':
        collider = makeBox('tree', x, z, 0.35 * scale, 0.35 * scale, yaw, 7 * scale);
        break;
      case 'palm':
        collider = makeBox('tree', x, z, 0.3, 0.3, yaw, 8 * scale);
        break;
      case 'bench':
        collider = makeBox('prop', x, z, 0.9, 0.35, yaw, 0.9);
        health = 30;
        break;
      case 'hydrant':
        collider = makeBox('prop', x, z, 0.2, 0.2, yaw, 0.9);
        health = 25;
        break;
      case 'trash':
        collider = makeBox('prop', x, z, 0.35, 0.35, yaw, 1.1);
        health = 10;
        break;
      case 'bollard':
        collider = makeBox('prop', x, z, 0.15, 0.15, yaw, 0.9);
        break;
      case 'sign':
        collider = makeBox('prop', x, z, 0.1, 0.1, yaw, 3);
        health = 20;
        break;
      case 'container':
        collider = makeBox('prop', x, z, 3.05 * scale, 1.22 * scale, yaw, 2.6 * scale);
        break;
      case 'crate':
        collider = makeBox('prop', x, z, 0.7 * scale, 0.7 * scale, yaw, 1.4 * scale);
        health = 30;
        break;
      case 'fence':
        collider = makeBox('wall', x, z, 3 * scale, 0.08, yaw, 2, false);
        health = 60;
        break;
      case 'billboard':
        collider = makeBox('prop', x, z, 4, 0.4, yaw, 9);
        break;
      case 'crane':
        collider = makeBox('prop', x, z, 2.5, 2.5, yaw, 30);
        break;
      case 'ship':
        collider = makeBox('prop', x, z, 45, 9, yaw, 14);
        break;
      case 'plane':
        collider = makeBox('prop', x, z, 4, 4, yaw, 4); // fuselage only; wings are overhead
        break;
      case 'hangar':
        collider = makeBox('building', x, z, 16, 12, yaw, 11);
        break;
      case 'tower':
        collider = makeBox('building', x, z, 3.5, 3.5, yaw, 24);
        break;
      case 'hut':
        collider = makeBox('prop', x, z, 1.8, 1.8, yaw, 3);
        break;
      case 'fountain':
        collider = makeBox('prop', x, z, 4.5, 4.5, yaw, 1);
        break;
      case 'bush':
      case 'pier':
        collider = null;
        break;
    }
    const p: PropRecord = { id: this.nextPropId++, kind, x, z, y, yaw, scale, collider, health, instanceIndex: -1, destroyed: false };
    this.props.push(p);
    return p;
  }

  private buildSpecialBlock(lot: Rect, s: SpecialBlock, d: District, rng: Rng, slab: Rect): void {
    const w = lot.x1 - lot.x0;
    const dd = lot.z1 - lot.z0;
    const cx = (lot.x0 + lot.x1) / 2;
    const cz = (lot.z0 + lot.z1) / 2;
    if (s.kind === 'hospital') {
      this.addBuilding(cx, cz - dd * 0.15, w * 0.8, dd * 0.55, s.h, s.style, d, rng, { name: s.name, hasAntenna: true, hasRoofBox: true });
      this.decals.push({ minX: lot.x0, minZ: cz + dd * 0.15, maxX: lot.x1, maxZ: lot.z1, kind: 'helipad' });
      this.hospital = { x: cx, z: slab.z1 - SIDEWALK_WIDTH / 2 };
      this.poi.push({ name: s.poiName, x: this.hospital.x, z: this.hospital.z, icon: s.icon });
    } else if (s.kind === 'police') {
      this.addBuilding(cx, cz, w * 0.7, dd * 0.6, s.h, s.style, d, rng, { name: s.name, hasAntenna: true });
      // parking lot beside it
      this.decals.push({ minX: lot.x0, minZ: lot.z0, maxX: cx - w * 0.36, maxZ: lot.z1, kind: 'parking' });
      const px = slab.x0 + SIDEWALK_WIDTH / 2;
      this.policeStations.push({ x: px, z: cz });
      this.poi.push({ name: s.poiName, x: px, z: cz, icon: s.icon });
      for (let i = 0; i < 4; i++) this.parking.push({ x: lot.x0 + 3, z: lot.z0 + 6 + i * 7, yaw: Math.PI / 2, district: d });
    } else if (s.kind === 'gun') {
      this.addBuilding(cx, cz, Math.min(w, 24), Math.min(dd, 18), s.h, s.style, d, rng, { name: s.name });
      this.addProp('billboard', cx, cz - Math.min(dd, 18) / 2 - 2, 0, 1);
      const gx = cx;
      const gz = slab.z1 - SIDEWALK_WIDTH / 2;
      this.gunShops.push({ x: gx, z: gz });
      this.poi.push({ name: s.poiName, x: gx, z: gz, icon: s.icon });
      this.fillLotRemainder(lot, d, rng, [{ x0: cx - 14, z0: cz - 11, x1: cx + 14, z1: cz + 11 }]);
    } else if (s.kind === 'taxi') {
      this.addBuilding(cx + w * 0.2, cz, w * 0.5, dd * 0.5, s.h, s.style, d, rng, { name: s.name });
      this.decals.push({ minX: lot.x0, minZ: lot.z0, maxX: cx - w * 0.08, maxZ: lot.z1, kind: 'parking' });
      for (let i = 0; i < 5; i++) this.parking.push({ x: lot.x0 + 4, z: lot.z0 + 5 + i * 6.5, yaw: Math.PI / 2, district: d });
      const tx = slab.x0 + SIDEWALK_WIDTH / 2;
      this.poi.push({ name: s.poiName, x: tx, z: cz, icon: s.icon });
    } else {
      this.addBuilding(cx, cz, Math.min(w, 22), Math.min(dd, 16), s.h, s.style, d, rng, { name: s.name });
      this.decals.push({ minX: lot.x0, minZ: lot.z0, maxX: lot.x1, maxZ: cz - 8, kind: 'parking' });
      this.poi.push({ name: s.poiName, x: cx, z: slab.z1 - SIDEWALK_WIDTH / 2, icon: s.icon });
    }
  }

  private buildBlock(lot: Rect, d: District, rng: Rng, bx: number, bz: number): void {
    switch (d) {
      case 'downtown':
        this.buildDowntownBlock(lot, rng);
        break;
      case 'midtown':
        this.buildMidtownBlock(lot, rng);
        break;
      case 'residential':
        this.buildResidentialBlock(lot, rng);
        break;
      case 'industrial':
        this.buildIndustrialBlock(lot, rng, false);
        break;
      case 'harbor':
        this.buildIndustrialBlock(lot, rng, true, bx, bz);
        break;
      default:
        break;
    }
  }

  private buildDowntownBlock(lot: Rect, rng: Rng): void {
    const w = lot.x1 - lot.x0;
    const d = lot.z1 - lot.z0;
    const cx = (lot.x0 + lot.x1) / 2;
    const cz = (lot.z0 + lot.z1) / 2;
    const distC = Math.hypot(cx, cz);
    const hMax = 150 - Math.min(1, distC / 320) * 95; // 150 m in the core, ~55 m at the ring
    const layout = rng.next();
    const subLots: Rect[] = [];
    if (layout < 0.3) subLots.push(lot);
    else if (layout < 0.62) {
      const gap = 6;
      if (rng.chance(0.5)) {
        subLots.push({ x0: lot.x0, z0: lot.z0, x1: cx - gap / 2, z1: lot.z1 }, { x0: cx + gap / 2, z0: lot.z0, x1: lot.x1, z1: lot.z1 });
      } else {
        subLots.push({ x0: lot.x0, z0: lot.z0, x1: lot.x1, z1: cz - gap / 2 }, { x0: lot.x0, z0: cz + gap / 2, x1: lot.x1, z1: lot.z1 });
      }
    } else {
      const gap = 5;
      subLots.push(
        { x0: lot.x0, z0: lot.z0, x1: cx - gap / 2, z1: cz - gap / 2 },
        { x0: cx + gap / 2, z0: lot.z0, x1: lot.x1, z1: cz - gap / 2 },
        { x0: lot.x0, z0: cz + gap / 2, x1: cx - gap / 2, z1: lot.z1 },
        { x0: cx + gap / 2, z0: cz + gap / 2, x1: lot.x1, z1: lot.z1 },
      );
    }
    const styles = [0, 2, 3, 3, 0, 1];
    for (const sl of subLots) {
      if (subLots.length === 4 && rng.chance(0.15)) {
        // small plaza with trees instead of a tower
        this.sprinkleTrees(sl, rng, 3, 'tree');
        this.addProp('bench', (sl.x0 + sl.x1) / 2, (sl.z0 + sl.z1) / 2, rng.range(0, Math.PI), 1);
        continue;
      }
      const inset = rng.range(0.8, 3.5);
      const bw = sl.x1 - sl.x0 - inset * 2;
      const bd = sl.z1 - sl.z0 - inset * 2;
      if (bw < 8 || bd < 8) continue;
      const h = Math.max(28, rng.range(0.4, 1) * hMax);
      const style = rng.pick(styles);
      const bcx = (sl.x0 + sl.x1) / 2;
      const bcz = (sl.z0 + sl.z1) / 2;
      const tiers: { w: number; d: number; h: number }[] = [];
      if (h > 60 && rng.chance(0.55)) {
        let tw = bw;
        let td = bd;
        const n = rng.int(1, 2);
        for (let i = 0; i < n; i++) {
          tw *= rng.range(0.55, 0.8);
          td *= rng.range(0.55, 0.8);
          tiers.push({ w: tw, d: td, h: rng.range(8, 30) });
        }
      }
      this.addBuilding(bcx, bcz, bw, bd, h, style, 'downtown', rng, tiers.length ? { tiers } : undefined);
    }
    // Sidewalk planters: a couple of trees on big blocks
    if (w > 40 && d > 40 && rng.chance(0.5)) {
      this.addProp('tree', lot.x0 - LOT_SETBACK - 1.2, lot.z0 + rng.range(5, 15), 0, 0.8);
    }
  }

  private buildMidtownBlock(lot: Rect, rng: Rng): void {
    const cols = rng.int(2, 3);
    const rows = rng.int(2, 3);
    const w = (lot.x1 - lot.x0) / cols;
    const d = (lot.z1 - lot.z0) / rows;
    const styles = [0, 1, 2, 4, 5, 1, 4];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const sl: Rect = { x0: lot.x0 + c * w, z0: lot.z0 + r * d, x1: lot.x0 + (c + 1) * w, z1: lot.z0 + (r + 1) * d };
        if (rng.chance(0.14)) {
          // parking lot or pocket park
          if (rng.chance(0.5)) {
            this.decals.push({ minX: sl.x0 + 0.5, minZ: sl.z0 + 0.5, maxX: sl.x1 - 0.5, maxZ: sl.z1 - 0.5, kind: 'parking' });
            const spots = Math.floor((sl.x1 - sl.x0) / 3.2);
            for (let i = 0; i < spots; i++) {
              if (rng.chance(0.5)) this.parking.push({ x: sl.x0 + 2 + i * 3.2, z: sl.z0 + 4, yaw: 0, district: 'midtown' });
            }
          } else {
            this.sprinkleTrees(sl, rng, 3, 'tree');
            this.addProp('bench', (sl.x0 + sl.x1) / 2, (sl.z0 + sl.z1) / 2, 0, 1);
          }
          continue;
        }
        const inset = rng.range(0.6, 2.2);
        const bw = w - inset * 2;
        const bd = d - inset * 2;
        if (bw < 6 || bd < 6) continue;
        const h = rng.range(10, 38);
        this.addBuilding((sl.x0 + sl.x1) / 2, (sl.z0 + sl.z1) / 2, bw, bd, h, rng.pick(styles), 'midtown', rng);
      }
    }
  }

  private buildResidentialBlock(lot: Rect, rng: Rng): void {
    const n = 3;
    const w = (lot.x1 - lot.x0) / n;
    const d = (lot.z1 - lot.z0) / n;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const sl: Rect = { x0: lot.x0 + c * w, z0: lot.z0 + r * d, x1: lot.x0 + (c + 1) * w, z1: lot.z0 + (r + 1) * d };
        const inner = r === 1 && c === 1;
        if (inner && rng.chance(0.6)) {
          this.sprinkleTrees(sl, rng, 3, 'tree');
          continue;
        }
        if (rng.chance(0.12)) {
          this.sprinkleTrees(sl, rng, 2, 'tree');
          continue;
        }
        const bw = rng.range(8, Math.min(13, w - 4));
        const bd = rng.range(7, Math.min(12, d - 4));
        const hx = (sl.x0 + sl.x1) / 2 + rng.range(-1.5, 1.5);
        const hz = (sl.z0 + sl.z1) / 2 + rng.range(-1.5, 1.5);
        const floors = rng.chance(0.55) ? 1 : 2;
        const h = floors * 3.4 + rng.range(0.8, 1.8);
        const style = rng.weighted([7, 4, 5, 1], [5, 2, 2, 1]);
        this.addBuilding(hx, hz, bw, bd, h, style, 'residential', rng, { hasRoofBox: false, hasAntenna: rng.chance(0.2) });
        // yard trees & bushes
        const tcount = rng.int(0, 2);
        for (let i = 0; i < tcount; i++) {
          const tx = rng.range(sl.x0 + 1, sl.x1 - 1);
          const tz = rng.range(sl.z0 + 1, sl.z1 - 1);
          if (Math.abs(tx - hx) < bw / 2 + 1.2 && Math.abs(tz - hz) < bd / 2 + 1.2) continue;
          this.addProp('tree', tx, tz, rng.range(0, 6.28), rng.range(0.8, 1.2));
        }
        if (rng.chance(0.6)) this.addProp('bush', rng.range(sl.x0 + 0.5, sl.x1 - 0.5), sl.z0 + 0.6, 0, rng.range(0.7, 1.2));
      }
    }
  }

  private buildIndustrialBlock(lot: Rect, rng: Rng, harbor: boolean, bx = 0, bz = 0): void {
    const w = lot.x1 - lot.x0;
    const d = lot.z1 - lot.z0;
    const cx = (lot.x0 + lot.x1) / 2;
    const cz = (lot.z0 + lot.z1) / 2;
    const used: Rect[] = [];
    if (harbor && bz === BLOCKS - 1 && bx >= 19 && bx <= 21) {
      // Dock edge: cranes + container yard, building smaller
      this.addBuilding(cx - w * 0.2, cz - d * 0.2, w * 0.45, d * 0.4, rng.range(8, 12), 6, 'harbor', rng, { hasRoofBox: false });
      used.push({ x0: cx - w * 0.45, z0: cz - d * 0.42, x1: cx + w * 0.05, z1: cz });
      this.addProp('crane', cx + w * 0.3, cz + d * 0.3, rng.range(-0.3, 0.3), 1);
      used.push({ x0: cx + w * 0.3 - 4, z0: cz + d * 0.3 - 4, x1: cx + w * 0.3 + 4, z1: cz + d * 0.3 + 4 });
    } else {
      const two = w > 45 && rng.chance(0.4);
      if (two) {
        const bw = w * 0.42;
        const bd = d * rng.range(0.5, 0.7);
        this.addBuilding(lot.x0 + bw / 2 + 1, cz, bw, bd, rng.range(8, 14), 6, harbor ? 'harbor' : 'industrial', rng, { hasRoofBox: false });
        this.addBuilding(lot.x1 - bw / 2 - 1, cz, bw, bd, rng.range(8, 14), 6, harbor ? 'harbor' : 'industrial', rng, { hasRoofBox: false });
        used.push({ x0: lot.x0, z0: cz - bd / 2, x1: lot.x0 + bw + 2, z1: cz + bd / 2 }, { x0: lot.x1 - bw - 2, z0: cz - bd / 2, x1: lot.x1, z1: cz + bd / 2 });
      } else {
        const bw = w * rng.range(0.5, 0.7);
        const bd = d * rng.range(0.45, 0.65);
        const ox = rng.range(-w * 0.12, w * 0.12);
        const oz = rng.range(-d * 0.12, d * 0.12);
        this.addBuilding(cx + ox, cz + oz, bw, bd, rng.range(8, 15), 6, harbor ? 'harbor' : 'industrial', rng, { hasRoofBox: rng.chance(0.4) });
        used.push({ x0: cx + ox - bw / 2, z0: cz + oz - bd / 2, x1: cx + ox + bw / 2, z1: cz + oz + bd / 2 });
        if (rng.chance(0.35)) {
          // chimney stack
          const chx = cx + ox + bw / 2 + 1.6;
          const chz = cz + oz - bd / 2 + 2;
          this.addBuilding(chx, chz, 3, 3, rng.range(22, 34), 6, 'industrial', rng, { hasRoofBox: false, hasAntenna: false });
        }
      }
    }
    // Container rows / crates in free areas
    const tries = harbor ? 10 : 6;
    for (let i = 0; i < tries; i++) {
      const px = rng.range(lot.x0 + 4, lot.x1 - 4);
      const pz = rng.range(lot.z0 + 3, lot.z1 - 3);
      if (used.some((u) => px > u.x0 - 4 && px < u.x1 + 4 && pz > u.z0 - 3 && pz < u.z1 + 3)) continue;
      const yaw = rng.chance(0.5) ? 0 : Math.PI / 2;
      const kind: PropKind = rng.chance(harbor ? 0.75 : 0.5) ? 'container' : 'crate';
      this.addProp(kind, px, pz, yaw, 1);
      used.push({ x0: px - 3.5, z0: pz - 3.5, x1: px + 3.5, z1: pz + 3.5 });
      if (kind === 'container' && rng.chance(0.5)) {
        const dx = yaw === 0 ? 0 : 2.8;
        const dz = yaw === 0 ? 2.8 : 0;
        this.addProp('container', px + dx, pz + dz, yaw, 1);
      }
    }
    // Perimeter fence with a gate gap on one side
    if (rng.chance(0.55)) {
      const gateSide = rng.int(0, 3);
      const seg = 6;
      const addFenceLine = (x0: number, z0: number, x1: number, z1: number, side: number) => {
        const len = Math.hypot(x1 - x0, z1 - z0);
        const nseg = Math.floor(len / seg);
        const yaw = Math.atan2(z1 - z0, x1 - x0) === 0 ? 0 : Math.PI / 2;
        const mid = Math.floor(nseg / 2);
        for (let s = 0; s < nseg; s++) {
          if (side === gateSide && (s === mid || s === mid - 1)) continue;
          const t = (s + 0.5) / nseg;
          this.addProp('fence', x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, yaw, 1);
        }
      };
      addFenceLine(lot.x0, lot.z0, lot.x1, lot.z0, 0);
      addFenceLine(lot.x0, lot.z1, lot.x1, lot.z1, 1);
      addFenceLine(lot.x0, lot.z0, lot.x0, lot.z1, 2);
      addFenceLine(lot.x1, lot.z0, lot.x1, lot.z1, 3);
    }
    if (rng.chance(0.3)) this.addProp('billboard', rng.range(lot.x0 + 5, lot.x1 - 5), lot.z0 + 1.5, 0, 1);
  }

  private fillLotRemainder(lot: Rect, d: District, rng: Rng, used: Rect[]): void {
    for (let i = 0; i < 4; i++) {
      const tx = rng.range(lot.x0 + 1, lot.x1 - 1);
      const tz = rng.range(lot.z0 + 1, lot.z1 - 1);
      if (used.some((u) => tx > u.x0 - 1 && tx < u.x1 + 1 && tz > u.z0 - 1 && tz < u.z1 + 1)) continue;
      this.addProp(d === 'industrial' ? 'crate' : 'tree', tx, tz, rng.range(0, 3), 1);
    }
  }

  private sprinkleTrees(r: Rect, rng: Rng, count: number, kind: 'tree' | 'palm'): void {
    for (let i = 0; i < count; i++) {
      this.addProp(kind, rng.range(r.x0 + 1.5, r.x1 - 1.5), rng.range(r.z0 + 1.5, r.z1 - 1.5), rng.range(0, 6.28), rng.range(0.8, 1.3));
    }
  }

  // ---------------------------------------------------------------- regions
  private buildRegions(): void {
    for (const r of REGIONS) {
      const rect = this.regionRect(r);
      const rng = this.rng.fork(5000 + r.bx0 * 31 + r.bz0);
      if (r.kind === 'park') this.buildPark(rect, rng);
      else if (r.kind === 'airfield') this.buildAirfield(rect, rng);
      else this.buildPlaza(rect, rng);
    }
  }

  private buildPark(rect: Rect, rng: Rng): void {
    this.slabs.push({ minX: rect.x0, minZ: rect.z0, maxX: rect.x1, maxZ: rect.z1, top: 'grass', ring: true, district: 'park' });
    const cx = (rect.x0 + rect.x1) / 2;
    const cz = (rect.z0 + rect.z1) / 2;
    // Paths: cross + ring
    const pw = 2.2;
    this.decals.push({ minX: rect.x0, minZ: cz - pw, maxX: rect.x1, maxZ: cz + pw, kind: 'path' });
    this.decals.push({ minX: cx - pw, minZ: rect.z0, maxX: cx + pw, maxZ: rect.z1, kind: 'path' });
    const ringR = 70;
    this.decals.push({ minX: cx - ringR, minZ: cz - ringR - pw, maxX: cx + ringR, maxZ: cz - ringR + pw, kind: 'path' });
    this.decals.push({ minX: cx - ringR, minZ: cz + ringR - pw, maxX: cx + ringR, maxZ: cz + ringR + pw, kind: 'path' });
    this.decals.push({ minX: cx - ringR - pw, minZ: cz - ringR, maxX: cx - ringR + pw, maxZ: cz + ringR, kind: 'path' });
    this.decals.push({ minX: cx + ringR - pw, minZ: cz - ringR, maxX: cx + ringR + pw, maxZ: cz + ringR, kind: 'path' });
    // Pond (decorative water, walkable-shallow)
    this.water.push({ minX: cx - 26, minZ: cz + 20, maxX: cx + 26, maxZ: cz + 52 });
    // Fountain at the centre
    this.addProp('fountain', cx, cz, 0, 1);
    // Trees
    for (let i = 0; i < 230; i++) {
      const tx = rng.range(rect.x0 + 3, rect.x1 - 3);
      const tz = rng.range(rect.z0 + 3, rect.z1 - 3);
      if (Math.abs(tx - cx) < pw + 1.5 || Math.abs(tz - cz) < pw + 1.5) continue;
      if (Math.abs(Math.abs(tx - cx) - ringR) < pw + 1.5 && Math.abs(tz - cz) < ringR + 2) continue;
      if (Math.abs(Math.abs(tz - cz) - ringR) < pw + 1.5 && Math.abs(tx - cx) < ringR + 2) continue;
      if (tx > cx - 28 && tx < cx + 28 && tz > cz + 18 && tz < cz + 54) continue;
      if (Math.hypot(tx - cx, tz - cz) < 8) continue;
      this.addProp('tree', tx, tz, rng.range(0, 6.28), rng.range(0.9, 1.6));
    }
    // Benches and lamps along the cross paths
    for (let i = -3; i <= 3; i++) {
      if (i === 0) continue;
      const off = i * 22;
      this.addProp('bench', cx + off, cz - pw - 1.2, 0, 1);
      this.addProp('bench', cx - pw - 1.2, cz + off, Math.PI / 2, 1);
      this.addProp('lamp', cx + off + 8, cz + pw + 0.8, Math.PI, 1);
      this.addProp('lamp', cx + pw + 0.8, cz + off + 8, -Math.PI / 2, 1);
    }
    this.poi.push({ name: 'Greenfield Park', x: cx, z: cz - 12, icon: 'park' });
  }

  private buildAirfield(rect: Rect, rng: Rng): void {
    this.slabs.push({ minX: rect.x0, minZ: rect.z0, maxX: rect.x1, maxZ: rect.z1, top: 'concrete', ring: true, district: 'airfield' });
    const cz = (rect.z0 + rect.z1) / 2;
    const rz = cz + 40;
    // Runway along X
    this.decals.push({ minX: rect.x0 + 12, minZ: rz - 16, maxX: rect.x1 - 12, maxZ: rz + 16, kind: 'runway' });
    // Taxiway parallel
    this.decals.push({ minX: rect.x0 + 40, minZ: rz - 50, maxX: rect.x1 - 40, maxZ: rz - 42, kind: 'taxiway' });
    // Hangars along the north edge
    const hz = rect.z0 + 20;
    for (let i = 0; i < 3; i++) {
      this.addProp('hangar', rect.x0 + 60 + i * 70, hz, 0, 1);
    }
    // Control tower
    this.addProp('tower', rect.x1 - 40, rect.z0 + 22, 0, 1);
    // Parked planes
    for (let i = 0; i < 3; i++) {
      this.addProp('plane', rect.x0 + 300 + i * 55, rz - 70, rng.range(-0.2, 0.2), 1);
    }
    // Apron lamps
    for (let x = rect.x0 + 30; x < rect.x1 - 30; x += 45) this.addProp('lamp', x, rect.z0 + 44, 0, 1.4);
    this.poi.push({ name: 'Redwing Airfield', x: rect.x0 + 30, z: rz - 40, icon: 'airport' });
  }

  private buildPlaza(rect: Rect, rng: Rng): void {
    this.slabs.push({ minX: rect.x0, minZ: rect.z0, maxX: rect.x1, maxZ: rect.z1, top: 'concrete', ring: true, district: 'downtown' });
    const cx = (rect.x0 + rect.x1) / 2;
    const cz = (rect.z0 + rect.z1) / 2;
    this.decals.push({ minX: rect.x0 + 4, minZ: rect.z0 + 4, maxX: rect.x1 - 4, maxZ: rect.z1 - 4, kind: 'plaza' });
    this.addProp('fountain', cx, cz, 0, 1.2);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      this.addProp('tree', cx + Math.cos(a) * 16, cz + Math.sin(a) * 16, a, 1.1);
      this.addProp('bench', cx + Math.cos(a + 0.2) * 11, cz + Math.sin(a + 0.2) * 11, -a - 0.2 + Math.PI / 2, 1);
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      this.addProp('lamp', cx + Math.cos(a) * 22, cz + Math.sin(a) * 22, a, 1);
    }
    // Bollards along the plaza edge
    for (let x = rect.x0 + 6; x < rect.x1 - 5; x += 4) {
      this.addProp('bollard', x, rect.z0 + SIDEWALK_WIDTH, 0, 1);
      this.addProp('bollard', x, rect.z1 - SIDEWALK_WIDTH, 0, 1);
    }
    this.poi.push({ name: 'Union Plaza', x: cx, z: cz + 8, icon: 'plaza' });
    void rng;
  }

  private buildBeachAndOcean(): void {
    const edge = WORLD_HALF + WORLD_BOUNDARY_MARGIN;
    const coast = gridToWorld(23) + lineHalfWidth(23);
    this.slabs.push({ minX: coast, minZ: -edge, maxX: SHORE_X, maxZ: edge, top: 'sand', ring: true, district: 'beach' });
    // Boardwalk
    this.decals.push({ minX: coast + SIDEWALK_WIDTH + 2, minZ: -WORLD_HALF, maxX: coast + SIDEWALK_WIDTH + 8, maxZ: WORLD_HALF, kind: 'boardwalk' });
    // Ocean
    this.water.push({ minX: SHORE_X, minZ: -edge - 600, maxX: edge + 700, maxZ: edge + 600 });
    const rng = this.rng.fork(9001);
    for (let z = -WORLD_HALF + 10; z < WORLD_HALF - 10; z += 14) {
      this.addProp('palm', coast + SIDEWALK_WIDTH + 10 + rng.range(-1, 1), z + rng.range(-3, 3), rng.range(0, 6.28), rng.range(0.9, 1.3));
      if (rng.chance(0.4)) this.addProp('palm', coast + rng.range(30, 60), z + rng.range(-5, 5), rng.range(0, 6.28), rng.range(0.8, 1.2));
      if (rng.chance(0.25)) this.addProp('hut', coast + rng.range(20, 55), z, rng.range(0, 0.4), 1);
      if (rng.chance(0.5)) this.addProp('lamp', coast + SIDEWALK_WIDTH + 8.6, z, -Math.PI / 2, 1);
    }
    // Piers (decks are handled by groundHeightAt; rails are walls)
    for (const p of PIERS) {
      this.addProp('pier', (p.x0 + p.x1) / 2, p.z, 0, (p.x1 - p.x0) / 100, PIER_DECK_Y);
      const len = p.x1 - p.x0;
      this.walls.push(makeBox('wall', (p.x0 + p.x1) / 2, p.z - p.halfWidth - 0.1, len / 2, 0.1, 0, 1.2, false));
      this.walls.push(makeBox('wall', (p.x0 + p.x1) / 2, p.z + p.halfWidth + 0.1, len / 2, 0.1, 0, 1.2, false));
      this.walls.push(makeBox('wall', p.x1 + 0.1, p.z, 0.1, p.halfWidth + 0.2, 0, 1.2, false));
      for (let x = p.x0 + 10; x < p.x1 - 4; x += 12) this.addProp('lamp', x, p.z + p.halfWidth - 0.4, Math.PI / 2, 0.8, PIER_DECK_Y);
    }
    this.poi.push({ name: 'Sunset Shores', x: coast + 25, z: 60, icon: 'beach' });
    this.poi.push({ name: 'Old Harbor', x: gridToWorld(20) + 40, z: gridToWorld(23) + 20, icon: 'harbor' });
    // Cargo ship moored off the harbor
    this.addProp('ship', SHORE_X + 45, gridToWorld(23) + 10, 0, 1, WATER_Y);
  }

  // ---------------------------------------------------------------- street furniture
  private buildStreetFurniture(): void {
    const rng = this.rng.fork(42);
    const seen = new Set<number>();
    for (const e of this.roads.edges) {
      if (seen.has(e.twin)) continue;
      seen.add(e.id);
      const a = this.roads.nodes[e.from];
      const b = this.roads.nodes[e.to];
      const [rx, rz] = rightOf(e.dx, e.dz);
      const startCut = lineHalfWidth(e.alongX ? a.gx : a.gz) + 1; // clear the intersection
      const endCut = lineHalfWidth(e.alongX ? b.gx : b.gz) + 1;
      const usable = e.length - startCut - endCut;
      const dA = this.blockDistrictNear(a.x + e.dx * (startCut + 1) + rx * (e.halfWidth + 4), a.z + e.dz * (startCut + 1) + rz * (e.halfWidth + 4));
      const dB = this.blockDistrictNear(a.x + e.dx * (startCut + 1) - rx * (e.halfWidth + 4), a.z + e.dz * (startCut + 1) - rz * (e.halfWidth + 4));
      const spacing = e.isAvenue ? 25 : 28;
      const count = Math.floor(usable / spacing);
      for (let i = 0; i < count; i++) {
        const t0 = startCut + (i + 0.5) * spacing;
        // Lamps: avenues both sides, streets alternate.
        const lampOffset = e.halfWidth + 0.7;
        const sides = e.isAvenue ? [1, -1] : [i % 2 === 0 ? 1 : -1];
        for (const side of sides) {
          const dist = dA === 'airfield' || dB === 'airfield' ? 0 : 0;
          const lx = a.x + e.dx * t0 + rx * lampOffset * side;
          const lz = a.z + e.dz * t0 + rz * lampOffset * side;
          const yaw = Math.atan2(rx * side, rz * side) + Math.PI; // face the road
          this.addProp('lamp', lx, lz, yaw + dist, 1);
        }
        // Trees on the outer sidewalk edge in green districts
        for (const side of [1, -1]) {
          const dd = side === 1 ? dA : dB;
          if (dd === 'residential' || dd === 'midtown' || dd === 'park') {
            if (rng.chance(dd === 'midtown' ? 0.45 : 0.8)) {
              const t1 = t0 + spacing * 0.5;
              if (t1 < e.length - endCut - 2) {
                this.addProp('tree', a.x + e.dx * t1 + rx * (e.halfWidth + 2.3) * side, a.z + e.dz * t1 + rz * (e.halfWidth + 2.3) * side, rng.range(0, 6.28), rng.range(0.8, 1.1));
              }
            }
          }
          // Misc furniture
          if (dd !== 'park' && dd !== 'airfield' && dd !== 'beach') {
            const r = rng.next();
            const t2 = t0 + rng.range(-8, 8);
            const fx = a.x + e.dx * t2 + rx * (e.halfWidth + 1.6) * side;
            const fz = a.z + e.dz * t2 + rz * (e.halfWidth + 1.6) * side;
            const faceYaw = Math.atan2(-rx * side, -rz * side);
            if (r < 0.14) this.addProp('bench', fx, fz, faceYaw, 1);
            else if (r < 0.32) this.addProp('trash', fx, fz, 0, 1);
            else if (r < 0.46) this.addProp('hydrant', fx, fz, 0, 1);
            else if (r < 0.52 && dd !== 'residential') this.addProp('sign', fx, fz, faceYaw, 1);
          }
        }
        // Parking along the curb (streets in residential/midtown, avenue outer margin)
        if (usable > 30) {
          for (const side of [1, -1]) {
            const dd = side === 1 ? dA : dB;
            const p = dd === 'residential' ? 0.35 : dd === 'midtown' ? 0.3 : dd === 'downtown' ? 0.2 : 0.15;
            if (rng.chance(p)) {
              const tp = t0 + rng.range(-6, 6);
              const lateral = e.halfWidth - 1.0;
              // Cars park facing the travel direction of the lane on that side.
              const dirSign = side === 1 ? 1 : -1;
              this.parking.push({
                x: a.x + e.dx * tp + rx * lateral * side,
                z: a.z + e.dz * tp + rz * lateral * side,
                yaw: Math.atan2(e.dx * dirSign, e.dz * dirSign),
                district: dd,
              });
            }
          }
        }
      }
    }
    // Traffic lights at signalised intersections: one pole per approach corner.
    for (const n of this.roads.nodes) {
      if (!n.hasSignal) continue;
      const hwx = lineHalfWidth(n.gx);
      const hwz = lineHalfWidth(n.gz);
      this.addProp('trafficlight', n.x + hwx + 0.8, n.z - hwz - 0.8, 0, 1);
      this.addProp('trafficlight', n.x - hwx - 0.8, n.z + hwz + 0.8, Math.PI, 1);
      this.addProp('trafficlight', n.x + hwx + 0.8, n.z + hwz + 0.8, Math.PI / 2, 1);
      this.addProp('trafficlight', n.x - hwx - 0.8, n.z - hwz - 0.8, -Math.PI / 2, 1);
    }
  }

  private blockDistrictNear(x: number, z: number): District {
    const bx = Math.floor(worldToGrid(x));
    const bz = Math.floor(worldToGrid(z));
    if (bx < 0 || bz < 0 || bx >= BLOCKS || bz >= BLOCKS) return 'residential';
    return this.blockDistrict[bz * BLOCKS + bx];
  }

  // ---------------------------------------------------------------- boundary
  private buildBoundary(): void {
    const edge = WORLD_HALF + WORLD_BOUNDARY_MARGIN;
    const t = 2;
    // West, north, south walls
    this.walls.push(makeBox('wall', -edge - t, 0, t, edge + 800, 0, 30, false));
    this.walls.push(makeBox('wall', 0, -edge - t, edge + 800, t, 0, 30, false));
    this.walls.push(makeBox('wall', 0, edge + t, edge + 800, t, 0, 30, false));
    // Shoreline wall with gaps at piers
    let z = -edge - 100;
    const segments: [number, number][] = [];
    const sortedPiers = [...PIERS].sort((p, q) => p.z - q.z);
    for (const p of sortedPiers) {
      segments.push([z, p.z - p.halfWidth]);
      z = p.z + p.halfWidth;
    }
    segments.push([z, edge + 100]);
    for (const [z0, z1] of segments) {
      const len = z1 - z0;
      if (len <= 0) continue;
      this.walls.push(makeBox('wall', SHORE_X + 0.5, (z0 + z1) / 2, 0.5, len / 2, 0, 2.5, false));
    }
  }

  // ---------------------------------------------------------------- pickups / missions
  private placePickups(): void {
    const rng = this.rng.fork(77);
    let id = 1;
    const weaponPool: WeaponId[] = ['pistol', 'pistol', 'smg', 'shotgun', 'rifle', 'bat', 'sniper', 'rpg'];
    for (const n of this.roads.nodes) {
      if (!rng.chance(0.16)) continue;
      const hwx = lineHalfWidth(n.gx);
      const hwz = lineHalfWidth(n.gz);
      const sx = rng.chance(0.5) ? 1 : -1;
      const sz = rng.chance(0.5) ? 1 : -1;
      const x = n.x + sx * (hwx + 1.5);
      const z = n.z + sz * (hwz + 1.5);
      const r = rng.next();
      if (r < 0.3) this.pickups.push({ id: id++, kind: 'health', x, z, amount: 50 });
      else if (r < 0.5) this.pickups.push({ id: id++, kind: 'armor', x, z, amount: 100 });
      else if (r < 0.82) this.pickups.push({ id: id++, kind: 'money', x, z, amount: rng.int(1, 6) * 50 });
      else this.pickups.push({ id: id++, kind: 'weapon', weaponId: rng.pick(weaponPool), x, z, amount: 1 });
    }
    // Guaranteed starter weapons near spawn (Union Plaza)
    this.pickups.push({ id: id++, kind: 'weapon', weaponId: 'pistol', x: -4, z: 30, amount: 1 });
    this.pickups.push({ id: id++, kind: 'weapon', weaponId: 'bat', x: 6, z: -28, amount: 1 });
    this.pickups.push({ id: id++, kind: 'armor', x: -26, z: -4, amount: 100 });
    this.pickups.push({ id: id++, kind: 'money', x: 24, z: 6, amount: 250 });
    // Heavy weapons at the airfield and harbor
    this.pickups.push({ id: id++, kind: 'weapon', weaponId: 'rpg', x: gridToWorld(9), z: gridToWorld(22) + 40, amount: 1 });
    this.pickups.push({ id: id++, kind: 'weapon', weaponId: 'sniper', x: gridToWorld(21) - 10, z: gridToWorld(23) + 10, amount: 1 });
    this.pickups.push({ id: id++, kind: 'weapon', weaponId: 'rifle', x: gridToWorld(16) - 20, z: gridToWorld(7) - 30, amount: 1 });
  }

  private placeMissionsAndPoi(): void {
    const plaza = this.poi.find((p) => p.icon === 'plaza')!;
    const taxi = this.poi.find((p) => p.icon === 'taxi')!;
    const police = this.poi.find((p) => p.icon === 'police')!;
    const airfield = this.poi.find((p) => p.icon === 'airport')!;
    const harbor = this.poi.find((p) => p.icon === 'harbor')!;
    const park = this.poi.find((p) => p.icon === 'park')!;
    const beach = this.poi.find((p) => p.icon === 'beach')!;
    const gun = this.gunShops[1];
    this.missions.push(
      { id: 'm_courier_plaza', type: 'courier', x: plaza.x + 18, z: plaza.z + 10, title: 'Rush Hour Courier' },
      { id: 'm_taxi_depot', type: 'taxi', x: taxi.x, z: taxi.z - 12, title: 'Cabbie Shift' },
      { id: 'm_vigilante', type: 'vigilante', x: police.x, z: police.z + 14, title: 'Vigilante Patrol' },
      { id: 'm_race_airfield', type: 'race', x: airfield.x + 20, z: airfield.z, title: 'Redwing Sprint' },
      { id: 'm_delivery_harbor', type: 'delivery', x: harbor.x, z: harbor.z - 14, title: 'Dockside Delivery' },
      { id: 'm_hit_park', type: 'hit', x: park.x + 30, z: park.z, title: 'Park Bench Contract' },
      { id: 'm_rampage_industrial', type: 'rampage', x: gun.x + 14, z: gun.z, title: 'Rustbelt Rampage' },
      { id: 'm_race_coast', type: 'race', x: beach.x, z: beach.z + 24, title: 'Coastal Circuit' },
    );
    this.poi.push({ name: 'Union Plaza (start)', x: -18, z: 22, icon: 'spawn' });
  }

  // ---------------------------------------------------------------- chunks
  private buildChunks(): ChunkRecord[] {
    const edge = WORLD_HALF + WORLD_BOUNDARY_MARGIN + 200;
    const n = Math.ceil((edge * 2) / CHUNK_SIZE);
    const chunks: ChunkRecord[] = [];
    const index = new Map<string, ChunkRecord>();
    const keyFor = (x: number, z: number) => `${Math.floor((x + edge) / CHUNK_SIZE)},${Math.floor((z + edge) / CHUNK_SIZE)}`;
    const get = (x: number, z: number): ChunkRecord => {
      const k = keyFor(x, z);
      let c = index.get(k);
      if (!c) {
        const cx = Math.floor((x + edge) / CHUNK_SIZE);
        const cz = Math.floor((z + edge) / CHUNK_SIZE);
        c = { cx, cz, minX: -edge + cx * CHUNK_SIZE, minZ: -edge + cz * CHUNK_SIZE, maxX: -edge + (cx + 1) * CHUNK_SIZE, maxZ: -edge + (cz + 1) * CHUNK_SIZE, buildings: [], props: [], district: districtOfBlock(Math.floor(worldToGrid(x)), Math.floor(worldToGrid(z))) };
        index.set(k, c);
        chunks.push(c);
      }
      return c;
    };
    for (const b of this.buildings) get(b.x, b.z).buildings.push(b);
    for (const p of this.props) get(p.x, p.z).props.push(p);
    void n;
    return chunks;
  }
}

export function generateCity(seed: number): WorldData {
  return new CityGenerator(seed).generate();
}
