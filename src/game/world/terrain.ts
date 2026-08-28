import * as THREE from 'three';
import { clamp01, lerp, smoothstep, valueNoise2 } from '../engine/math';
import { baseTerrainHeight, MAP_HALF, MAP_SIZE } from './heightfield';
import { makeRoadHit, type Road } from './road';
import type { LakeSite } from './water';

const CHUNKS = 6;
const SEGS_PER_CHUNK = 32;
/** Vertices per side of the whole heightfield. */
const VERTS = CHUNKS * SEGS_PER_CHUNK + 1;
const CELL = MAP_SIZE / (VERTS - 1);

/** Distance from the centreline where the ground is fully levelled to the road. */
const FLAT_RADIUS = 8.2;
/** Distance where the terrain has fully returned to its natural shape. */
const BLEND_RADIUS = 36;

const SAND = new THREE.Color(0xc9b382);
const GRASS = new THREE.Color(0x5f7f42);
const GRASS_DRY = new THREE.Color(0x8a9a4e);
const DIRT = new THREE.Color(0x7a6647);
const ROCK = new THREE.Color(0x77746e);
const SNOW = new THREE.Color(0xd8dbe0);

/**
 * The drivable ground: a single heightfield, split into chunks so the GPU only
 * draws the ones in view. Colour is baked into vertices, which lets the whole
 * thing run on a cheap Lambert material with no textures at all.
 */
export class Terrain {
  readonly heights: Float32Array;
  readonly group = new THREE.Group();
  private material: THREE.MeshLambertMaterial;

  constructor(road: Road, private lake: LakeSite | null = null) {
    this.heights = new Float32Array(VERTS * VERTS);
    this.group.name = 'terrain';

    const hit = makeRoadHit();
    for (let iz = 0; iz < VERTS; iz++) {
      const z = -MAP_HALF + iz * CELL;
      for (let ix = 0; ix < VERTS; ix++) {
        const x = -MAP_HALF + ix * CELL;
        const base = baseTerrainHeight(x, z);
        road.query(x, z, hit);

        let h = base;
        if (hit.dist < BLEND_RADIUS) {
          // 0 at the centreline, 1 out at the blend radius.
          const t = smoothstep(FLAT_RADIUS, BLEND_RADIUS, hit.dist);
          h = lerp(hit.height, base, t);
        }

        // Carve the lake basin: a smooth bowl dipping below the water level,
        // done here in the height grid so physics, scenery and skids all see
        // the same ground the GPU draws.
        if (lake) {
          const lr = Math.hypot(x - lake.x, z - lake.z) / lake.radius;
          if (lr < 1.25) {
            const bowl = smoothstep(1.25, 0.45, lr);
            h = Math.min(h, lerp(h, lake.level - 3.2, bowl));
          }
        }
        this.heights[iz * VERTS + ix] = h;
      }
    }

    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });
    for (let cz = 0; cz < CHUNKS; cz++) {
      for (let cx = 0; cx < CHUNKS; cx++) {
        this.group.add(this.buildChunk(cx, cz, road));
      }
    }
  }

  private buildChunk(cx: number, cz: number, road: Road): THREE.Mesh {
    const n = SEGS_PER_CHUNK + 1;
    const positions = new Float32Array(n * n * 3);
    const normals = new Float32Array(n * n * 3);
    const colors = new Float32Array(n * n * 3);
    const indices = new Uint16Array(SEGS_PER_CHUNK * SEGS_PER_CHUNK * 6);

    const baseIx = cx * SEGS_PER_CHUNK;
    const baseIz = cz * SEGS_PER_CHUNK;
    const normal = new THREE.Vector3();
    const color = new THREE.Color();
    const hit = makeRoadHit();

    for (let j = 0; j < n; j++) {
      const iz = baseIz + j;
      const z = -MAP_HALF + iz * CELL;
      for (let i = 0; i < n; i++) {
        const ix = baseIx + i;
        const x = -MAP_HALF + ix * CELL;
        const h = this.heights[iz * VERTS + ix];
        const o = (j * n + i) * 3;

        positions[o] = x;
        positions[o + 1] = h;
        positions[o + 2] = z;

        this.normalAtIndex(ix, iz, normal);
        normals[o] = normal.x;
        normals[o + 1] = normal.y;
        normals[o + 2] = normal.z;

        road.query(x, z, hit);
        this.groundColor(x, z, h, normal.y, hit.dist, color);
        colors[o] = color.r;
        colors[o + 1] = color.g;
        colors[o + 2] = color.b;
      }
    }

    let ii = 0;
    for (let j = 0; j < SEGS_PER_CHUNK; j++) {
      for (let i = 0; i < SEGS_PER_CHUNK; i++) {
        const a = j * n + i;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        indices[ii++] = a;
        indices[ii++] = c;
        indices[ii++] = b;
        indices[ii++] = b;
        indices[ii++] = c;
        indices[ii++] = d;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.name = `terrain-${cx}-${cz}`;
    return mesh;
  }

  private groundColor(
    x: number,
    z: number,
    h: number,
    slopeUp: number,
    roadDist: number,
    out: THREE.Color,
  ): void {
    // Patchy grass tone so large flat areas do not read as a solid sheet.
    const patch = valueNoise2(x * 0.011, z * 0.011, 5) * 0.5 + 0.5;
    out.copy(GRASS).lerp(GRASS_DRY, patch);

    // Steep faces turn to rock.
    const rockAmount = smoothstep(0.86, 0.66, slopeUp);
    out.lerp(ROCK, rockAmount);

    // Snow caps on the rim mountains.
    out.lerp(SNOW, smoothstep(96, 130, h));

    // Worn ground beside the tarmac.
    out.lerp(DIRT, smoothstep(26, 9, roadDist) * 0.75);

    // A sandy shore ring just above the waterline.
    if (this.lake) {
      const lr = Math.hypot(x - this.lake.x, z - this.lake.z);
      if (lr < this.lake.radius * 1.3) {
        out.lerp(SAND, smoothstep(2.6, 0.4, Math.abs(h - this.lake.level - 0.5)));
      }
    }
  }

  private normalAtIndex(ix: number, iz: number, out: THREE.Vector3): THREE.Vector3 {
    const x0 = Math.max(0, ix - 1);
    const x1 = Math.min(VERTS - 1, ix + 1);
    const z0 = Math.max(0, iz - 1);
    const z1 = Math.min(VERTS - 1, iz + 1);
    const dhx = (this.heights[iz * VERTS + x1] - this.heights[iz * VERTS + x0]) /
      ((x1 - x0) * CELL);
    const dhz = (this.heights[z1 * VERTS + ix] - this.heights[z0 * VERTS + ix]) /
      ((z1 - z0) * CELL);
    return out.set(-dhx, 1, -dhz).normalize();
  }

  /** Bilinear height sample. Hot path: called several times per physics step. */
  heightAt(x: number, z: number): number {
    const fx = (x + MAP_HALF) / CELL;
    const fz = (z + MAP_HALF) / CELL;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    if (ix < 0 || iz < 0 || ix >= VERTS - 1 || iz >= VERTS - 1) {
      return baseTerrainHeight(x, z);
    }
    const tx = fx - ix;
    const tz = fz - iz;
    const i0 = iz * VERTS + ix;
    const i1 = i0 + VERTS;
    const h00 = this.heights[i0];
    const h10 = this.heights[i0 + 1];
    const h01 = this.heights[i1];
    const h11 = this.heights[i1 + 1];
    return lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), tz);
  }

  /** Surface normal at a world position, from finite differences. */
  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const d = CELL;
    const hL = this.heightAt(x - d, z);
    const hR = this.heightAt(x + d, z);
    const hD = this.heightAt(x, z - d);
    const hU = this.heightAt(x, z + d);
    return out.set((hL - hR) / (2 * d), 1, (hD - hU) / (2 * d)).normalize();
  }

  /** 0 on flat ground, 1 on a wall. Used to keep scenery off cliffs. */
  slopeAt(x: number, z: number, scratch: THREE.Vector3): number {
    this.normalAt(x, z, scratch);
    return clamp01(1 - scratch.y);
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    this.material.dispose();
  }
}
