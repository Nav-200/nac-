/**
 * Uniform-grid spatial hash over the XZ plane. Used for static colliders (buildings,
 * props) and for dynamic entities (vehicles, pedestrians) so every query is O(nearby).
 */
export interface HasBounds {
  /** Axis-aligned bounds in world XZ. */
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export class SpatialHash<T extends HasBounds> {
  private cells = new Map<number, T[]>();
  private readonly inv: number;
  private itemCells = new Map<T, number[]>();
  private queryStamp = new Map<T, number>();
  private stamp = 0;
  private scratch: T[] = [];

  constructor(public readonly cellSize: number) {
    this.inv = 1 / cellSize;
  }

  private key(cx: number, cz: number): number {
    // Offset so negatives pack cleanly into a single int key.
    return (cx + 32768) * 65536 + (cz + 32768);
  }

  insert(item: T): void {
    const keys: number[] = [];
    const cx0 = Math.floor(item.minX * this.inv);
    const cz0 = Math.floor(item.minZ * this.inv);
    const cx1 = Math.floor(item.maxX * this.inv);
    const cz1 = Math.floor(item.maxZ * this.inv);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const k = this.key(cx, cz);
        let arr = this.cells.get(k);
        if (!arr) {
          arr = [];
          this.cells.set(k, arr);
        }
        arr.push(item);
        keys.push(k);
      }
    }
    this.itemCells.set(item, keys);
  }

  remove(item: T): void {
    const keys = this.itemCells.get(item);
    if (!keys) return;
    for (const k of keys) {
      const arr = this.cells.get(k);
      if (!arr) continue;
      const i = arr.indexOf(item);
      if (i >= 0) {
        arr[i] = arr[arr.length - 1];
        arr.pop();
      }
      if (arr.length === 0) this.cells.delete(k);
    }
    this.itemCells.delete(item);
  }

  /** Re-insert after the item's bounds changed (cheap no-op if the cell set is unchanged). */
  update(item: T): void {
    const keys = this.itemCells.get(item);
    if (keys) {
      const cx0 = Math.floor(item.minX * this.inv);
      const cz0 = Math.floor(item.minZ * this.inv);
      const cx1 = Math.floor(item.maxX * this.inv);
      const cz1 = Math.floor(item.maxZ * this.inv);
      const count = (cx1 - cx0 + 1) * (cz1 - cz0 + 1);
      if (count === keys.length) {
        let same = true;
        let i = 0;
        for (let cx = cx0; cx <= cx1 && same; cx++) {
          for (let cz = cz0; cz <= cz1; cz++) {
            if (keys[i++] !== this.key(cx, cz)) {
              same = false;
              break;
            }
          }
        }
        if (same) return;
      }
      this.remove(item);
    }
    this.insert(item);
  }

  has(item: T): boolean {
    return this.itemCells.has(item);
  }

  get size(): number {
    return this.itemCells.size;
  }

  /**
   * Collect unique items whose cells overlap the query rectangle.
   * The returned array is reused between calls — copy it if you need to keep it.
   */
  query(minX: number, minZ: number, maxX: number, maxZ: number, out: T[] = this.scratch): T[] {
    out.length = 0;
    const s = ++this.stamp;
    const cx0 = Math.floor(minX * this.inv);
    const cz0 = Math.floor(minZ * this.inv);
    const cx1 = Math.floor(maxX * this.inv);
    const cz1 = Math.floor(maxZ * this.inv);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const arr = this.cells.get(this.key(cx, cz));
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
          const it = arr[i];
          if (this.queryStamp.get(it) === s) continue;
          this.queryStamp.set(it, s);
          if (it.maxX < minX || it.minX > maxX || it.maxZ < minZ || it.minZ > maxZ) continue;
          out.push(it);
        }
      }
    }
    return out;
  }

  /** Query a circle (rect broadphase, no exact circle test). */
  queryCircle(x: number, z: number, r: number, out?: T[]): T[] {
    return this.query(x - r, z - r, x + r, z + r, out);
  }

  /** Iterate every item touched by the segment (conservative: walks the segment's cells). */
  queryRay(x0: number, z0: number, x1: number, z1: number, out: T[] = this.scratch): T[] {
    out.length = 0;
    const s = ++this.stamp;
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(len * this.inv * 1.5));
    let lastKey = -1;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const cx = Math.floor((x0 + dx * t) * this.inv);
      const cz = Math.floor((z0 + dz * t) * this.inv);
      // also visit the 4-neighbourhood to be safe at cell borders
      for (let ox = -1; ox <= 1; ox++) {
        for (let oz = -1; oz <= 1; oz++) {
          const k = this.key(cx + ox, cz + oz);
          if (k === lastKey) continue;
          const arr = this.cells.get(k);
          if (!arr) continue;
          for (let j = 0; j < arr.length; j++) {
            const it = arr[j];
            if (this.queryStamp.get(it) === s) continue;
            this.queryStamp.set(it, s);
            out.push(it);
          }
        }
      }
      lastKey = this.key(cx, cz);
    }
    return out;
  }

  clear(): void {
    this.cells.clear();
    this.itemCells.clear();
    this.queryStamp.clear();
  }
}
