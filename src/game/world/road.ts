import * as THREE from 'three';
import { makeRng, TAU } from '../engine/math';
import { baseTerrainHeight, MAP_HALF } from './heightfield';

export interface RoadHit {
  /** Horizontal distance from the road centreline, in metres. */
  dist: number;
  /** Height of the road surface at the nearest sample. */
  height: number;
  /** Index of the nearest centreline sample. */
  index: number;
}

export const makeRoadHit = (): RoadHit => ({ dist: Infinity, height: 0, index: 0 });

const SAMPLE_SPACING = 4;
const GRID_CELL = 32;

/**
 * The road is a single closed loop. It is generated first, then the terrain is
 * flattened onto it, so the surface is guaranteed to sit on the ground without
 * any draping pass.
 */
export class Road {
  readonly count: number;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  /** Unit tangent in XZ (direction of travel). */
  readonly tx: Float32Array;
  readonly tz: Float32Array;
  /** Unit left-hand normal in XZ. */
  readonly nx: Float32Array;
  readonly nz: Float32Array;
  /** Cumulative arc length at each sample. */
  readonly cum: Float32Array;
  readonly totalLength: number;

  readonly halfWidth = 5.5;
  readonly shoulder = 1.6;

  private gridDim: number;
  private gridOrigin: number;
  private cellStart: Int32Array;
  private cellItems: Int32Array;

  constructor(seed = 20260828) {
    const rng = makeRng(seed);

    // Control points on a wobbling ring. The radius and a per-point angular
    // jitter give long straights, tight hairpins and everything between.
    const controls: THREE.Vector3[] = [];
    const CP = 16;
    for (let i = 0; i < CP; i++) {
      const a = (i / CP) * TAU + (rng() - 0.5) * 0.16;
      const radius = 330 + rng() * 245;
      controls.push(
        new THREE.Vector3(
          Math.cos(a) * radius * 1.06,
          0,
          Math.sin(a) * radius * 0.92,
        ),
      );
    }

    const curve = new THREE.CatmullRomCurve3(controls, true, 'centripetal', 0.5);
    const approxLength = curve.getLength();
    const count = Math.max(256, Math.round(approxLength / SAMPLE_SPACING));
    // getSpacedPoints returns count+1 points with the loop closed; drop the dup.
    const pts = curve.getSpacedPoints(count);

    this.count = count;
    this.px = new Float32Array(count);
    this.py = new Float32Array(count);
    this.pz = new Float32Array(count);
    this.tx = new Float32Array(count);
    this.tz = new Float32Array(count);
    this.nx = new Float32Array(count);
    this.nz = new Float32Array(count);
    this.cum = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const p = pts[i];
      this.px[i] = p.x;
      this.pz[i] = p.z;
      this.py[i] = baseTerrainHeight(p.x, p.z);
    }

    this.smoothProfile();
    this.computeFrames();

    let total = 0;
    for (let i = 0; i < count; i++) {
      this.cum[i] = total;
      const j = (i + 1) % count;
      total += Math.hypot(this.px[j] - this.px[i], this.pz[j] - this.pz[i]);
    }
    this.totalLength = total;

    // Uniform grid over the map for O(1)-ish nearest-sample lookups.
    this.gridOrigin = -MAP_HALF;
    this.gridDim = Math.ceil((MAP_HALF * 2) / GRID_CELL) + 1;
    const cells = this.gridDim * this.gridDim;
    const counts = new Int32Array(cells + 1);
    const cellOf = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      const cx = this.cellIndex(this.px[i]);
      const cz = this.cellIndex(this.pz[i]);
      const c = cz * this.gridDim + cx;
      cellOf[i] = c;
      counts[c + 1]++;
    }
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    this.cellStart = counts;
    this.cellItems = new Int32Array(count);
    const cursor = Int32Array.from(counts.subarray(0, cells));
    for (let i = 0; i < count; i++) {
      this.cellItems[cursor[cellOf[i]]++] = i;
    }
  }

  private cellIndex(v: number): number {
    const i = Math.floor((v - this.gridOrigin) / GRID_CELL);
    return i < 0 ? 0 : i >= this.gridDim ? this.gridDim - 1 : i;
  }

  /**
   * Averages the height profile along the loop and then limits the gradient, so
   * the road climbs and dives over the hills without ever becoming a ramp.
   */
  private smoothProfile(): void {
    const n = this.count;
    const src = this.py;
    const tmp = new Float32Array(n);
    const window = 14;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let k = -window; k <= window; k++) {
          sum += src[(i + k + n * 2) % n];
        }
        tmp[i] = sum / (window * 2 + 1);
      }
      src.set(tmp);
    }

    const maxSlope = 0.075 * SAMPLE_SPACING;
    for (let pass = 0; pass < 24; pass++) {
      let changed = false;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const d = src[j] - src[i];
        if (d > maxSlope) {
          const fix = (d - maxSlope) * 0.5;
          src[i] += fix;
          src[j] -= fix;
          changed = true;
        } else if (d < -maxSlope) {
          const fix = (-d - maxSlope) * 0.5;
          src[i] -= fix;
          src[j] += fix;
          changed = true;
        }
      }
      if (!changed) break;
    }
  }

  private computeFrames(): void {
    const n = this.count;
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n;
      const b = (i + 1) % n;
      let dx = this.px[b] - this.px[a];
      let dz = this.pz[b] - this.pz[a];
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      this.tx[i] = dx;
      this.tz[i] = dz;
      // Left-hand normal in XZ.
      this.nx[i] = -dz;
      this.nz[i] = dx;
    }
  }

  /** Nearest centreline sample to a world XZ position. Allocation-free. */
  query(x: number, z: number, out: RoadHit): RoadHit {
    const cx = this.cellIndex(x);
    const cz = this.cellIndex(z);
    let best = Infinity;
    let bestIdx = -1;

    for (let ring = 1; ring <= 3; ring++) {
      const x0 = Math.max(0, cx - ring);
      const x1 = Math.min(this.gridDim - 1, cx + ring);
      const z0 = Math.max(0, cz - ring);
      const z1 = Math.min(this.gridDim - 1, cz + ring);
      for (let gz = z0; gz <= z1; gz++) {
        for (let gx = x0; gx <= x1; gx++) {
          const c = gz * this.gridDim + gx;
          const s = this.cellStart[c];
          const e = this.cellStart[c + 1];
          for (let k = s; k < e; k++) {
            const i = this.cellItems[k];
            const dx = this.px[i] - x;
            const dz = this.pz[i] - z;
            const d2 = dx * dx + dz * dz;
            if (d2 < best) {
              best = d2;
              bestIdx = i;
            }
          }
        }
      }
      // One extra ring past the first hit guards against a sample just over the
      // cell border being closer than the one we found.
      if (bestIdx >= 0 && ring >= 2) break;
    }

    if (bestIdx < 0) {
      out.dist = Infinity;
      out.height = baseTerrainHeight(x, z);
      out.index = 0;
      return out;
    }

    out.index = bestIdx;
    out.height = this.py[bestIdx];
    // Refine the distance against the two adjacent segments so the value is
    // continuous rather than stepping between samples.
    out.dist = Math.min(
      this.segmentDistance(bestIdx, (bestIdx + 1) % this.count, x, z),
      this.segmentDistance((bestIdx - 1 + this.count) % this.count, bestIdx, x, z),
    );
    return out;
  }

  private segmentDistance(i: number, j: number, x: number, z: number): number {
    const ax = this.px[i];
    const az = this.pz[i];
    const bx = this.px[j];
    const bz = this.pz[j];
    const vx = bx - ax;
    const vz = bz - az;
    const len2 = vx * vx + vz * vz;
    let t = len2 > 0 ? ((x - ax) * vx + (z - az) * vz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - (ax + vx * t);
    const dz = z - (az + vz * t);
    return Math.hypot(dx, dz);
  }

  /** Index of the sample roughly `distance` metres along the loop from sample 0. */
  indexAtDistance(distance: number): number {
    const d = ((distance % this.totalLength) + this.totalLength) % this.totalLength;
    // The samples are near-uniformly spaced, so a direct estimate is accurate
    // enough and avoids a binary search in the hot path.
    return Math.min(this.count - 1, Math.floor((d / this.totalLength) * this.count));
  }

  positionAt(index: number, out: THREE.Vector3, lateral = 0): THREE.Vector3 {
    const i = ((index % this.count) + this.count) % this.count;
    out.set(
      this.px[i] + this.nx[i] * lateral,
      this.py[i],
      this.pz[i] + this.nz[i] * lateral,
    );
    return out;
  }

  headingAt(index: number): number {
    const i = ((index % this.count) + this.count) % this.count;
    return Math.atan2(this.tx[i], this.tz[i]);
  }

  /**
   * Curvature magnitude at a sample; used by the AI to pick a corner speed.
   * `lookahead` may be negative for travel against the sample order.
   */
  curvatureAt(index: number, lookahead = 6): number {
    const n = this.count;
    const i = ((index % n) + n) % n;
    const j = (((i + lookahead) % n) + n) % n;
    const dot = this.tx[i] * this.tx[j] + this.tz[i] * this.tz[j];
    const clamped = dot < -1 ? -1 : dot > 1 ? 1 : dot;
    return Math.acos(clamped) / (Math.abs(lookahead) * SAMPLE_SPACING);
  }

  /** Asphalt ribbon, painted edge lines, gravel shoulders and centre dashes. */
  buildMesh(): THREE.Group {
    const group = new THREE.Group();
    group.name = 'road';

    const asphalt = new THREE.Color(0x3a3d42);
    const asphaltDark = new THREE.Color(0x33363a);
    const line = new THREE.Color(0xf0efe6);
    const gravel = new THREE.Color(0x6d6150);

    // Cross-section: offset from centre, colour, vertical drop.
    const profile: Array<[number, THREE.Color, number]> = [
      [-(this.halfWidth + this.shoulder), gravel, -0.32],
      [-(this.halfWidth + 0.05), gravel, -0.04],
      [-this.halfWidth, line, 0],
      [-this.halfWidth + 0.35, line, 0],
      [-this.halfWidth + 0.42, asphalt, 0],
      [0, asphaltDark, 0.05],
      [this.halfWidth - 0.42, asphalt, 0],
      [this.halfWidth - 0.35, line, 0],
      [this.halfWidth, line, 0],
      [this.halfWidth + 0.05, gravel, -0.04],
      [this.halfWidth + this.shoulder, gravel, -0.32],
    ];

    const n = this.count;
    const w = profile.length;
    const positions = new Float32Array(n * w * 3);
    const colors = new Float32Array(n * w * 3);
    const indices = new Uint32Array(n * (w - 1) * 6);

    for (let i = 0; i < n; i++) {
      for (let k = 0; k < w; k++) {
        const [off, col, drop] = profile[k];
        const vi = (i * w + k) * 3;
        positions[vi] = this.px[i] + this.nx[i] * off;
        positions[vi + 1] = this.py[i] + drop + 0.04;
        positions[vi + 2] = this.pz[i] + this.nz[i] * off;
        colors[vi] = col.r;
        colors[vi + 1] = col.g;
        colors[vi + 2] = col.b;
      }
    }

    let ii = 0;
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      for (let k = 0; k < w - 1; k++) {
        const a = i * w + k;
        const b = i * w + k + 1;
        const c = next * w + k;
        const d = next * w + k + 1;
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
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);

    group.add(this.buildCentreDashes());
    return group;
  }

  private buildCentreDashes(): THREE.Mesh {
    const dashLen = 3;
    const gapLen = 5;
    const period = dashLen + gapLen;
    const dashCount = Math.floor(this.totalLength / period);
    const positions = new Float32Array(dashCount * 4 * 3);
    const indices = new Uint32Array(dashCount * 6);

    const halfW = 0.14;
    let vi = 0;
    let ii = 0;
    for (let d = 0; d < dashCount; d++) {
      const startIdx = this.indexAtDistance(d * period);
      const endIdx = this.indexAtDistance(d * period + dashLen);
      const base = d * 4;
      const write = (idx: number, side: number, slot: number) => {
        const o = (base + slot) * 3;
        positions[o] = this.px[idx] + this.nx[idx] * halfW * side;
        positions[o + 1] = this.py[idx] + 0.09;
        positions[o + 2] = this.pz[idx] + this.nz[idx] * halfW * side;
      };
      write(startIdx, -1, 0);
      write(startIdx, 1, 1);
      write(endIdx, -1, 2);
      write(endIdx, 1, 3);
      vi += 4;
      indices[ii++] = base;
      indices[ii++] = base + 2;
      indices[ii++] = base + 1;
      indices[ii++] = base + 1;
      indices[ii++] = base + 2;
      indices[ii++] = base + 3;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, vi * 3), 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: 0xe9e5d2 }),
    );
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 1;
    return mesh;
  }
}
