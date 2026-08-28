import * as THREE from 'three';
import { clamp01, makeRng, smoothstep, TAU } from '../engine/math';
import type { QualitySettings } from '../types';
import { mergeParts } from './geometryUtils';
import { MAP_HALF } from './heightfield';
import { makeRoadHit, type Road } from './road';
import type { Terrain } from './terrain';

/** The map is diced into REGIONS x REGIONS buckets so each instanced batch can be culled. */
const REGIONS = 3;

interface Placement {
  x: number;
  z: number;
  y: number;
  rotation: number;
  scale: number;
  tint: number;
}

const buildPine = (): THREE.BufferGeometry =>
  mergeParts([
    {
      geometry: new THREE.CylinderGeometry(0.15, 0.28, 2.4, 4),
      color: 0x4a3a2a,
      position: [0, 1.2, 0],
    },
    {
      geometry: new THREE.ConeGeometry(1.5, 3.4, 6, 1, true),
      color: 0x33612f,
      position: [0, 3.3, 0],
    },
    {
      geometry: new THREE.ConeGeometry(1.05, 2.6, 6, 1, true),
      color: 0x3d7038,
      position: [0, 5.0, 0],
    },
  ]);

const buildBroadleaf = (): THREE.BufferGeometry =>
  mergeParts([
    {
      geometry: new THREE.CylinderGeometry(0.18, 0.3, 2.6, 4),
      color: 0x54402c,
      position: [0, 1.3, 0],
    },
    {
      geometry: new THREE.IcosahedronGeometry(1.9, 0),
      color: 0x4a7a34,
      position: [0, 3.9, 0],
      scale: [1.1, 0.92, 1.1],
    },
  ]);

const buildRock = (): THREE.BufferGeometry =>
  mergeParts([
    {
      geometry: new THREE.IcosahedronGeometry(1, 0),
      color: 0x7d7a72,
      position: [0, 0.42, 0],
      scale: [1.2, 0.7, 1.0],
      rotation: [0.2, 0.6, 0.1],
    },
  ]);

const buildBush = (): THREE.BufferGeometry =>
  mergeParts([
    {
      geometry: new THREE.IcosahedronGeometry(0.85, 0),
      color: 0x5c7a3a,
      position: [0, 0.5, 0],
      scale: [1.3, 0.85, 1.2],
    },
  ]);

const buildPost = (): THREE.BufferGeometry =>
  mergeParts([
    {
      geometry: new THREE.BoxGeometry(0.12, 1.05, 0.12),
      color: 0xe8e4d8,
      position: [0, 0.52, 0],
    },
    {
      geometry: new THREE.BoxGeometry(0.16, 0.16, 0.06),
      color: 0xff4d3d,
      position: [0, 0.92, 0.06],
    },
  ]);

const COLLIDER_CELL = 16;

/**
 * Static circle colliders for everything solid in the world, packed as flat
 * CSR typed arrays over a uniform grid (the same trick `Road.query` uses), so
 * the per-step query walks a few dozen floats and allocates nothing.
 */
export class ColliderGrid {
  readonly x: Float32Array;
  readonly z: Float32Array;
  readonly radius: Float32Array;
  /** 1 = hard stop, 0 = soft drag (bushes). */
  readonly hard: Uint8Array;
  readonly cellStart: Int32Array;
  readonly cellItems: Int32Array;
  readonly dim: number;
  readonly origin = -MAP_HALF;

  constructor(items: Array<{ x: number; z: number; r: number; hard: boolean }>) {
    const n = items.length;
    this.x = new Float32Array(n);
    this.z = new Float32Array(n);
    this.radius = new Float32Array(n);
    this.hard = new Uint8Array(n);
    this.dim = Math.ceil((MAP_HALF * 2) / COLLIDER_CELL) + 1;

    const cells = this.dim * this.dim;
    const counts = new Int32Array(cells + 1);
    const cellOf = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const it = items[i];
      this.x[i] = it.x;
      this.z[i] = it.z;
      this.radius[i] = it.r;
      this.hard[i] = it.hard ? 1 : 0;
      const c = this.cellIndex(it.z) * this.dim + this.cellIndex(it.x);
      cellOf[i] = c;
      counts[c + 1]++;
    }
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    this.cellStart = counts;
    this.cellItems = new Int32Array(n);
    const cursor = Int32Array.from(counts.subarray(0, cells));
    for (let i = 0; i < n; i++) this.cellItems[cursor[cellOf[i]]++] = i;
  }

  cellIndex(v: number): number {
    const i = Math.floor((v - this.origin) / COLLIDER_CELL);
    return i < 0 ? 0 : i >= this.dim ? this.dim - 1 : i;
  }
}

/**
 * Everything scattered across the landscape. Each prop type is instanced and
 * split by map region, which keeps the draw-call count low while still letting
 * the frustum throw away most of the world.
 */
export class Scenery {
  readonly group = new THREE.Group();
  colliders: ColliderGrid;
  private colliderItems: Array<{ x: number; z: number; r: number; hard: boolean }> = [];
  private geometries: THREE.BufferGeometry[] = [];
  private material: THREE.MeshLambertMaterial;

  constructor(
    road: Road,
    terrain: Terrain,
    quality: QualitySettings,
    waterLevel: number | null = null,
  ) {
    this.group.name = 'scenery';
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });

    const density = quality.sceneryDensity;
    const rng = makeRng(90210);
    const hit = makeRoadHit();
    const scratch = new THREE.Vector3();

    const pines: Placement[] = [];
    const broadleaves: Placement[] = [];
    const rocks: Placement[] = [];
    const bushes: Placement[] = [];

    // Jittered grid scatter. Cheaper than Poisson sampling and, once the props
    // are rotated and scaled at random, indistinguishable in motion.
    const spacing = 19;
    const cells = Math.floor((MAP_HALF * 2) / spacing);
    for (let cz = 0; cz < cells; cz++) {
      for (let cx = 0; cx < cells; cx++) {
        const x = -MAP_HALF + (cx + rng()) * spacing;
        const z = -MAP_HALF + (cz + rng()) * spacing;

        road.query(x, z, hit);
        // Keep the shoulders clear so the road is never blocked.
        if (hit.dist < 9.5) continue;

        const slope = terrain.slopeAt(x, z, scratch);
        if (slope > 0.42) continue;

        const y = terrain.heightAt(x, z);
        if (y > 112) continue;
        if (waterLevel !== null && y < waterLevel + 0.4) continue;

        // Denser near the road: that is where the player's eye actually is, and
        // close-passing trees are what sell the speed.
        const nearRoad = smoothstep(320, 40, hit.dist);
        const chance = (0.22 + nearRoad * 0.55) * density;
        const roll = rng();
        if (roll > chance) {
          // Even where trees do not land, drop the odd rock or bush.
          if (roll > 0.955) {
            const scale = 0.6 + rng() * 1.8;
            rocks.push({ x, z, y, rotation: rng() * TAU, scale, tint: 0.85 + rng() * 0.3 });
            this.colliderItems.push({ x, z, r: scale * 0.95, hard: true });
          } else if (roll > 0.9) {
            const scale = 0.7 + rng() * 0.9;
            bushes.push({ x, z, y, rotation: rng() * TAU, scale, tint: 0.8 + rng() * 0.45 });
            this.colliderItems.push({ x, z, r: scale * 1.0, hard: false });
          }
          continue;
        }

        const p: Placement = {
          x,
          z,
          y,
          rotation: rng() * TAU,
          scale: 0.75 + rng() * 0.75,
          tint: 0.82 + rng() * 0.4,
        };
        // Conifers take over as the ground climbs. The collider is the trunk,
        // not the canopy, so brushing foliage does not read as hitting a wall.
        this.colliderItems.push({ x, z, r: 0.34 + p.scale * 0.22, hard: true });
        if (rng() < clamp01(0.25 + y / 90)) pines.push(p);
        else broadleaves.push(p);
      }
    }

    this.addRegionedType(buildPine(), pines);
    this.addRegionedType(buildBroadleaf(), broadleaves);
    this.addRegionedType(buildRock(), rocks);
    this.addRegionedType(buildBush(), bushes);
    this.addRoadPosts(road, terrain);

    this.colliders = new ColliderGrid(this.colliderItems);
    this.colliderItems.length = 0;
  }

  /** Lets later-built props (barriers, arch pillars) join the same grid. */
  registerColliders(items: Array<{ x: number; z: number; r: number; hard: boolean }>): void {
    const merged: Array<{ x: number; z: number; r: number; hard: boolean }> = [];
    for (let i = 0; i < this.colliders.x.length; i++) {
      merged.push({
        x: this.colliders.x[i],
        z: this.colliders.z[i],
        r: this.colliders.radius[i],
        hard: this.colliders.hard[i] === 1,
      });
    }
    merged.push(...items);
    this.colliders = new ColliderGrid(merged);
  }

  /** Marker posts every few metres; cheap, and they make speed legible. */
  private addRoadPosts(road: Road, terrain: Terrain): void {
    const spacing = 26;
    const count = Math.floor(road.totalLength / spacing);
    const placements: Placement[] = [];
    const offset = road.halfWidth + road.shoulder + 0.5;
    for (let i = 0; i < count; i++) {
      const idx = road.indexAtDistance(i * spacing);
      const side = i % 2 === 0 ? 1 : -1;
      const x = road.px[idx] + road.nx[idx] * offset * side;
      const z = road.pz[idx] + road.nz[idx] * offset * side;
      placements.push({
        x,
        z,
        y: Math.min(road.py[idx], terrain.heightAt(x, z)) - 0.1,
        rotation: Math.atan2(road.nx[idx] * side, road.nz[idx] * side),
        scale: 1,
        tint: 1,
      });
    }
    this.addRegionedType(buildPost(), placements, false);
  }

  private addRegionedType(
    geometry: THREE.BufferGeometry,
    placements: Placement[],
    castShadow = true,
  ): void {
    if (placements.length === 0) {
      geometry.dispose();
      return;
    }
    this.geometries.push(geometry);

    const buckets: Placement[][] = [];
    for (let i = 0; i < REGIONS * REGIONS; i++) buckets.push([]);
    const span = (MAP_HALF * 2) / REGIONS;
    for (const p of placements) {
      const rx = Math.min(REGIONS - 1, Math.max(0, Math.floor((p.x + MAP_HALF) / span)));
      const rz = Math.min(REGIONS - 1, Math.max(0, Math.floor((p.z + MAP_HALF) / span)));
      buckets[rz * REGIONS + rx].push(p);
    }

    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const axis = new THREE.Vector3(0, 1, 0);
    const color = new THREE.Color();

    for (const bucket of buckets) {
      if (bucket.length === 0) continue;
      const mesh = new THREE.InstancedMesh(geometry, this.material, bucket.length);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = false;
      for (let i = 0; i < bucket.length; i++) {
        const p = bucket[i];
        pos.set(p.x, p.y, p.z);
        quat.setFromAxisAngle(axis, p.rotation);
        scl.setScalar(p.scale);
        matrix.compose(pos, quat, scl);
        mesh.setMatrixAt(i, matrix);
        color.setScalar(p.tint);
        mesh.setColorAt(i, color);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
    }
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.material.dispose();
  }
}
