/**
 * Static collision world: every building, prop and wall collider in a spatial hash,
 * plus the shared query helpers used by characters, vehicles, bullets and the camera.
 */
import { SpatialHash } from '../core/spatialHash';
import { type BoxCollider, type Contact, type RayHit, circleVsBox, boxVsBox, rayVsBox } from '../core/collision';
import type { WorldData } from '../core/types';

export interface StaticRayResult {
  hit: BoxCollider | null;
  t: number;
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
}

const scratchContact: Contact = { nx: 0, nz: 0, depth: 0 };
const scratchRay: RayHit = { t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0 };

export class StaticWorld {
  readonly hash = new SpatialHash<BoxCollider>(20);
  private queryBuf: BoxCollider[] = [];

  constructor(public readonly world: WorldData) {
    for (const b of world.buildings) this.hash.insert(b.collider);
    for (const p of world.props) if (p.collider) this.hash.insert(p.collider);
    for (const w of world.walls) this.hash.insert(w);
  }

  removeCollider(c: BoxCollider): void {
    this.hash.remove(c);
  }

  addCollider(c: BoxCollider): void {
    this.hash.insert(c);
  }

  /** Colliders overlapping a rect (shared buffer — copy if kept). */
  query(minX: number, minZ: number, maxX: number, maxZ: number): BoxCollider[] {
    return this.hash.query(minX, minZ, maxX, maxZ, this.queryBuf);
  }

  /**
   * Push a circle out of all static geometry. Mutates pos in place. Returns the strongest
   * contact (for impact effects) or null. `minHeight` lets tall entities ignore low props
   * (e.g. a car ignores nothing, a bullet ignores nothing, a jumping ped ignores 0.5 m crates).
   */
  resolveCircle(pos: { x: number; z: number }, r: number, minHeight = 0, iterations = 3, onContact?: (c: BoxCollider, contact: Contact) => void): Contact | null {
    let strongest: Contact | null = null;
    let strongestDepth = 0;
    for (let it = 0; it < iterations; it++) {
      const list = this.hash.query(pos.x - r, pos.z - r, pos.x + r, pos.z + r, this.queryBuf);
      let any = false;
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        if (b.height < minHeight) continue;
        const c = circleVsBox(pos.x, pos.z, r, b, scratchContact);
        if (!c) continue;
        any = true;
        pos.x += c.nx * c.depth;
        pos.z += c.nz * c.depth;
        if (c.depth > strongestDepth) {
          strongestDepth = c.depth;
          strongest = { nx: c.nx, nz: c.nz, depth: c.depth };
        }
        onContact?.(b, c);
      }
      if (!any) break;
    }
    return strongest;
  }

  /**
   * Resolve an OBB (vehicle) against static geometry. Returns contacts via callback so the
   * vehicle can apply impulses; mutates the box centre in place.
   */
  resolveBox(box: BoxCollider, onContact: (other: BoxCollider, contact: Contact) => void, iterations = 2): boolean {
    let hitAny = false;
    for (let it = 0; it < iterations; it++) {
      const list = this.hash.query(box.minX, box.minZ, box.maxX, box.maxZ, this.queryBuf);
      let any = false;
      for (let i = 0; i < list.length; i++) {
        const other = list[i];
        const c = boxVsBox(box, other, scratchContact);
        if (!c) continue;
        any = true;
        hitAny = true;
        box.cx += c.nx * c.depth;
        box.cz += c.nz * c.depth;
        // keep AABB in sync for subsequent queries within this pass
        const ex = box.maxX - box.cx + c.nx * c.depth; // approximate — refreshed by caller after
        void ex;
        box.minX += c.nx * c.depth;
        box.maxX += c.nx * c.depth;
        box.minZ += c.nz * c.depth;
        box.maxZ += c.nz * c.depth;
        onContact(other, c);
      }
      if (!any) break;
    }
    return hitAny;
  }

  /** Nearest static hit along a 3D ray. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, out: StaticRayResult, solidOnly = true): boolean {
    const list = this.hash.queryRay(ox, oz, ox + dx * maxDist, oz + dz * maxDist, this.queryBuf);
    let best = maxDist;
    let bestBox: BoxCollider | null = null;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (solidOnly && !b.solid) continue;
      const t = rayVsBox(ox, oy, oz, dx, dy, dz, b, best, scratchRay);
      if (t >= 0 && t < best) {
        best = t;
        bestBox = b;
        out.x = scratchRay.x;
        out.y = scratchRay.y;
        out.z = scratchRay.z;
        out.nx = scratchRay.nx;
        out.ny = scratchRay.ny;
        out.nz = scratchRay.nz;
      }
    }
    out.hit = bestBox;
    out.t = best;
    return bestBox !== null;
  }

  /** True if the segment between two points is blocked by solid geometry (line of sight). */
  blocked(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return false;
    const list = this.hash.queryRay(x0, z0, x1, z1, this.queryBuf);
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (!b.solid) continue;
      if (b.kind === 'lamp' || b.kind === 'tree') continue; // thin things don't block sight
      const t = rayVsBox(x0, y0, z0, dx / len, dy / len, dz / len, b, len);
      if (t >= 0 && t < len) return true;
    }
    return false;
  }

  /** Is the point free of static geometry within radius r (used for spawning). */
  isFree(x: number, z: number, r: number): boolean {
    const list = this.hash.query(x - r, z - r, x + r, z + r, this.queryBuf);
    for (let i = 0; i < list.length; i++) {
      if (circleVsBox(x, z, r, list[i], scratchContact)) return false;
    }
    return true;
  }
}
