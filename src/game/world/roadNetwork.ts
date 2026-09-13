/**
 * Grid-based road network with avenues, removable intersections (parks, airfield),
 * per-edge lanes, traffic signals, nearest-edge queries and Dijkstra routing (GPS).
 *
 * Conventions: yaw 0 faces +Z, increasing toward +X. For a travel direction (dx,dz)
 * the driver's right-hand side is (-dz, dx).
 */
import { AVENUE_EVERY, AVENUE_HALF_WIDTH, BLOCK_PITCH, GRID_N, LANE_WIDTH, STREET_HALF_WIDTH, WORLD_HALF } from '../core/constants';
import type { Lane, RoadEdge, RoadNetwork, RoadNode } from '../core/types';
import { Rng } from '../core/rng';

export const SIGNAL_PERIOD = 15; // seconds for a full NS/EW cycle
export const SIGNAL_GREEN = 6.25;
export const SIGNAL_ALL_RED = 1.25;

export function gridToWorld(g: number): number {
  return -WORLD_HALF + g * BLOCK_PITCH;
}

export function worldToGrid(v: number): number {
  return (v + WORLD_HALF) / BLOCK_PITCH;
}

export function isAvenueLine(g: number): boolean {
  return g % AVENUE_EVERY === 2;
}

export function lineHalfWidth(g: number): number {
  return isAvenueLine(g) ? AVENUE_HALF_WIDTH : STREET_HALF_WIDTH;
}

export function rightOf(dx: number, dz: number): [number, number] {
  return [-dz, dx];
}

export interface RoadNetworkOptions {
  /** Grid nodes to remove (no roads pass through them). */
  removedNodes: Set<number>; // key = gz * GRID_N + gx
  /** Undirected street segments to remove, keyed by canonical "a-b" of node keys. */
  removedEdges: Set<string>;
}

export function nodeKey(gx: number, gz: number): number {
  return gz * GRID_N + gx;
}

export function edgeKey(aKey: number, bKey: number): string {
  return aKey < bKey ? `${aKey}-${bKey}` : `${bKey}-${aKey}`;
}

export class GridRoadNetwork implements RoadNetwork {
  nodes: RoadNode[] = [];
  edges: RoadEdge[] = [];
  private nodeIndex: Int32Array = new Int32Array(GRID_N * GRID_N).fill(-1);
  /** Directed edge lookup: edgeFromTo[fromNode*GRID_N*GRID_N + toNode] would be huge; use a Map. */
  private edgeLookup = new Map<number, number>();

  constructor(private opts: RoadNetworkOptions) {
    this.build();
  }

  private build(): void {
    // Nodes
    for (let gz = 0; gz < GRID_N; gz++) {
      for (let gx = 0; gx < GRID_N; gx++) {
        const key = nodeKey(gx, gz);
        if (this.opts.removedNodes.has(key)) continue;
        const id = this.nodes.length;
        this.nodeIndex[key] = id;
        this.nodes.push({ id, gx, gz, x: gridToWorld(gx), z: gridToWorld(gz), out: [], in: [], hasSignal: false, signalOffset: 0 });
      }
    }
    // Edges (both directions) between orthogonal neighbours
    const addPair = (a: RoadNode, b: RoadNode, alongX: boolean) => {
      const line = alongX ? a.gz : a.gx; // the grid line the road lies on
      const halfWidth = lineHalfWidth(line);
      const isAvenue = isAvenueLine(line);
      const lanes: Lane[] = isAvenue ? [{ offset: LANE_WIDTH * 0.55 }, { offset: LANE_WIDTH * 1.55 }] : [{ offset: LANE_WIDTH * 0.5 }];
      const mk = (from: RoadNode, to: RoadNode): RoadEdge => {
        const dx0 = to.x - from.x;
        const dz0 = to.z - from.z;
        const length = Math.hypot(dx0, dz0);
        const e: RoadEdge = { id: this.edges.length, from: from.id, to: to.id, dx: dx0 / length, dz: dz0 / length, length, halfWidth, isAvenue, lanes, twin: -1, alongX };
        this.edges.push(e);
        from.out.push(e.id);
        to.in.push(e.id);
        this.edgeLookup.set(from.id * 65536 + to.id, e.id);
        return e;
      };
      const e1 = mk(a, b);
      const e2 = mk(b, a);
      e1.twin = e2.id;
      e2.twin = e1.id;
    };
    for (const n of this.nodes) {
      if (n.gx + 1 < GRID_N) {
        const k2 = nodeKey(n.gx + 1, n.gz);
        const j = this.nodeIndex[k2];
        if (j >= 0 && !this.opts.removedEdges.has(edgeKey(nodeKey(n.gx, n.gz), k2))) addPair(n, this.nodes[j], true);
      }
      if (n.gz + 1 < GRID_N) {
        const k2 = nodeKey(n.gx, n.gz + 1);
        const j = this.nodeIndex[k2];
        if (j >= 0 && !this.opts.removedEdges.has(edgeKey(nodeKey(n.gx, n.gz), k2))) addPair(n, this.nodes[j], false);
      }
    }
    // Signals at 4-way intersections that involve an avenue; offsets staggered for a "green wave".
    const rng = new Rng(777);
    for (const n of this.nodes) {
      const degree = n.out.length;
      const onAvenue = isAvenueLine(n.gx) || isAvenueLine(n.gz);
      n.hasSignal = degree >= 3 && onAvenue;
      n.signalOffset = ((n.gx + n.gz) * 2.3 + rng.range(0, 1.5)) % SIGNAL_PERIOD;
    }
  }

  nodeAt(gx: number, gz: number): number {
    if (gx < 0 || gz < 0 || gx >= GRID_N || gz >= GRID_N) return -1;
    return this.nodeIndex[nodeKey(gx, gz)];
  }

  edgeBetween(fromNode: number, toNode: number): number {
    return this.edgeLookup.get(fromNode * 65536 + toNode) ?? -1;
  }

  hasEdgeOnLine(alongX: boolean, line: number, seg: number): boolean {
    // alongX: horizontal road on grid line gz=line between gx=seg and seg+1
    const a = alongX ? this.nodeAt(seg, line) : this.nodeAt(line, seg);
    const b = alongX ? this.nodeAt(seg + 1, line) : this.nodeAt(line, seg + 1);
    if (a < 0 || b < 0) return false;
    return this.edgeBetween(a, b) >= 0;
  }

  nearestNode(x: number, z: number): RoadNode {
    const gx0 = Math.round(worldToGrid(x));
    const gz0 = Math.round(worldToGrid(z));
    let best: RoadNode | null = null;
    let bestD = Infinity;
    for (let r = 0; r < GRID_N && !best; r++) {
      for (let gx = gx0 - r; gx <= gx0 + r; gx++) {
        for (let gz = gz0 - r; gz <= gz0 + r; gz++) {
          if (Math.abs(gx - gx0) !== r && Math.abs(gz - gz0) !== r) continue;
          const id = this.nodeAt(gx, gz);
          if (id < 0) continue;
          const n = this.nodes[id];
          const d = (n.x - x) ** 2 + (n.z - z) ** 2;
          if (d < bestD) {
            bestD = d;
            best = n;
          }
        }
      }
      if (best && r >= 1) break;
    }
    return best ?? this.nodes[0];
  }

  /**
   * Nearest directed edge to a point. Returns the edge whose travel direction has the point
   * on its right-hand half (so vehicles snap to the correct side of the road).
   */
  nearestEdge(x: number, z: number): { edge: RoadEdge; t: number; lateral: number } | null {
    const gxf = worldToGrid(x);
    const gzf = worldToGrid(z);
    let best: { edge: RoadEdge; t: number; lateral: number } | null = null;
    let bestScore = Infinity;
    const consider = (e: RoadEdge) => {
      const a = this.nodes[e.from];
      const px = x - a.x;
      const pz = z - a.z;
      let t = (px * e.dx + pz * e.dz) / e.length;
      const clampedT = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = a.x + e.dx * e.length * clampedT;
      const cz = a.z + e.dz * e.length * clampedT;
      const [rx, rz] = rightOf(e.dx, e.dz);
      const lateral = (x - cx) * rx + (z - cz) * rz; // positive = right side of travel
      const dist = Math.hypot(x - cx, z - cz);
      const score = dist + (lateral < 0 ? 0.5 * e.halfWidth : 0); // prefer edges with the point on the right
      if (score < bestScore) {
        bestScore = score;
        best = { edge: e, t: clampedT, lateral };
      }
    };
    // Candidate lines: the two nearest vertical and horizontal grid lines.
    const gxA = Math.floor(gxf);
    const gzA = Math.floor(gzf);
    for (let gx = gxA - 1; gx <= gxA + 2; gx++) {
      for (let gz = gzA - 1; gz <= gzA + 2; gz++) {
        const n = this.nodeAt(gx, gz);
        if (n < 0) continue;
        for (const eid of this.nodes[n].out) consider(this.edges[eid]);
      }
    }
    return best;
  }

  /** 'ns' = traffic along Z may go, 'ew' = traffic along X may go, 'red' = all stop. */
  signalState(node: RoadNode, time: number): 'ns' | 'ew' | 'red' | 'none' {
    if (!node.hasSignal) return 'none';
    const t = (time + node.signalOffset) % SIGNAL_PERIOD;
    if (t < SIGNAL_GREEN) return 'ns';
    if (t < SIGNAL_GREEN + SIGNAL_ALL_RED) return 'red';
    if (t < SIGNAL_GREEN * 2 + SIGNAL_ALL_RED) return 'ew';
    return 'red';
  }

  /** Dijkstra over nodes; returns node ids from `fromNode` to `toNode` (inclusive), or [] if unreachable. */
  route(fromNode: number, toNode: number): number[] {
    if (fromNode === toNode) return [fromNode];
    const n = this.nodes.length;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const visited = new Uint8Array(n);
    dist[fromNode] = 0;
    // Simple binary heap
    const heap: number[] = [fromNode];
    const push = (v: number) => {
      heap.push(v);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (dist[heap[p]] <= dist[heap[i]]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = (): number => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let m = i;
          if (l < heap.length && dist[heap[l]] < dist[heap[m]]) m = l;
          if (r < heap.length && dist[heap[r]] < dist[heap[m]]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    while (heap.length) {
      const u = pop();
      if (visited[u]) continue;
      visited[u] = 1;
      if (u === toNode) break;
      for (const eid of this.nodes[u].out) {
        const e = this.edges[eid];
        const w = e.length * (e.isAvenue ? 0.8 : 1); // prefer avenues
        const nd = dist[u] + w;
        if (nd < dist[e.to]) {
          dist[e.to] = nd;
          prev[e.to] = u;
          push(e.to);
        }
      }
    }
    if (!isFinite(dist[toNode])) return [];
    const path: number[] = [];
    for (let v = toNode; v !== -1; v = prev[v]) path.push(v);
    path.reverse();
    return path;
  }

  /** Position of a point on a lane of an edge at parameter t (0..1). */
  lanePoint(e: RoadEdge, laneIndex: number, t: number, out: { x: number; z: number }): void {
    const a = this.nodes[e.from];
    const off = e.lanes[Math.min(laneIndex, e.lanes.length - 1)].offset;
    const [rx, rz] = rightOf(e.dx, e.dz);
    out.x = a.x + e.dx * e.length * t + rx * off;
    out.z = a.z + e.dz * e.length * t + rz * off;
  }

  /** Random outgoing edge from `node`, avoiding the U-turn back along `arrivingEdge` when possible. */
  pickNextEdge(node: RoadNode, arrivingEdge: RoadEdge | null, rng: Rng, preferStraight = 0.5): RoadEdge {
    const candidates = node.out.map((id) => this.edges[id]).filter((e) => !arrivingEdge || e.id !== arrivingEdge.twin);
    const pool = candidates.length ? candidates : node.out.map((id) => this.edges[id]);
    if (arrivingEdge && rng.chance(preferStraight)) {
      const straight = pool.find((e) => Math.abs(e.dx - arrivingEdge.dx) < 0.01 && Math.abs(e.dz - arrivingEdge.dz) < 0.01);
      if (straight) return straight;
    }
    return rng.pick(pool);
  }
}
