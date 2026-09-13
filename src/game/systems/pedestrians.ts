/**
 * Pedestrian manager + civilian AI: sidewalk wandering along the road graph, panic/flee from
 * gunfire and crashes, crowd separation, vehicle impacts, driver bail-outs, corpse cleanup.
 * Cops and mission peds are steered by their own systems but are stepped here.
 */
import { DESPAWN_RADIUS, MAX_PEDESTRIANS, SPAWN_RADIUS_MAX, SPAWN_RADIUS_MIN } from '../core/constants';
import { clamp, wrapAngle } from '../core/mathUtils';
import { Rng } from '../core/rng';
import { PANTS_COLORS, SHIRT_COLORS, SKIN_TONES } from '../core/textures';
import type { GameEvent, RoadEdge, WorldData } from '../core/types';
import { Pedestrian, type PedAppearance, type PedKind } from '../entities/pedestrian';
import type { Vehicle } from '../entities/vehicle';
import type { DynamicWorld } from '../physics/dynamicWorld';
import type { StaticWorld } from '../physics/staticWorld';
import { GridRoadNetwork, rightOf } from '../world/roadNetwork';

export interface PedCallbacks {
  onSpawn(p: Pedestrian): void;
  onDespawn(p: Pedestrian): void;
  playerPos(): { x: number; z: number };
}

export interface Alert {
  x: number;
  z: number;
  radius: number;
  /** Game time when raised. */
  time: number;
  /** Strength 0..1 — how likely peds are to flee vs just look. */
  strength: number;
}

const HAIR = ['#2b1b0e', '#0f0f0f', '#5a3a1a', '#b58a4a', '#d9c9a5', '#6b6b6b'];
const pt = { x: 0, z: 0 };

export class PedestrianSystem {
  readonly peds: Pedestrian[] = [];
  readonly alerts: Alert[] = [];
  private roads: GridRoadNetwork;
  private rng: Rng;
  private spawnTimer = 0;

  constructor(
    private world: WorldData,
    private statics: StaticWorld,
    private dynamics: DynamicWorld,
    private cb: PedCallbacks,
    seed = 777,
  ) {
    this.roads = world.roads as GridRoadNetwork;
    this.rng = new Rng(seed);
  }

  get civilianCount(): number {
    let n = 0;
    for (const p of this.peds) if (p.kind === 'civilian' && !p.dead) n++;
    return n;
  }

  randomAppearance(): PedAppearance {
    return { skin: this.rng.pick(SKIN_TONES), shirt: this.rng.pick(SHIRT_COLORS), pants: this.rng.pick(PANTS_COLORS), hair: this.rng.pick(HAIR) };
  }

  spawnPed(kind: PedKind, x: number, z: number, yaw = 0, appearance?: PedAppearance): Pedestrian {
    const p = new Pedestrian(kind, appearance ?? this.randomAppearance());
    p.setPosition(x, z, yaw, this.world.groundHeightAt(x, z));
    this.peds.push(p);
    this.dynamics.peds.insert(p.bounds);
    this.cb.onSpawn(p);
    return p;
  }

  despawn(p: Pedestrian): void {
    const i = this.peds.indexOf(p);
    if (i < 0) return;
    this.peds.splice(i, 1);
    this.dynamics.peds.remove(p.bounds);
    this.cb.onDespawn(p);
  }

  raiseAlert(x: number, z: number, radius: number, time: number, strength = 1): void {
    this.alerts.push({ x, z, radius, time, strength });
    if (this.alerts.length > 24) this.alerts.shift();
  }

  /** Sidewalk point on the right-hand side of a directed edge at parameter t. */
  sidewalkPoint(e: RoadEdge, t: number, extra: number, out: { x: number; z: number }): void {
    const a = this.roads.nodes[e.from];
    const [rx, rz] = rightOf(e.dx, e.dz);
    const off = e.halfWidth + 1.4 + extra;
    out.x = a.x + e.dx * e.length * t + rx * off;
    out.z = a.z + e.dz * e.length * t + rz * off;
  }

  /** Spawn a wandering civilian on a sidewalk at spawn distance from the player. */
  spawnCivilianNear(px: number, pz: number): Pedestrian | null {
    for (let attempt = 0; attempt < 6; attempt++) {
      const ang = this.rng.range(0, Math.PI * 2);
      const dist = this.rng.range(SPAWN_RADIUS_MIN * 0.6, SPAWN_RADIUS_MAX * 0.8);
      const x = px + Math.cos(ang) * dist;
      const z = pz + Math.sin(ang) * dist;
      const d = this.world.districtAt(x, z);
      if (d === 'airfield' || d === 'harbor') continue;
      const ne = this.roads.nearestEdge(x, z);
      if (!ne) continue;
      const e = ne.edge;
      const t = this.rng.range(0.1, 0.9);
      const extra = this.rng.range(0, 1.2);
      this.sidewalkPoint(e, t, extra, pt);
      if (!this.statics.isFree(pt.x, pt.z, 0.5)) continue;
      if (this.world.isWaterAt(pt.x, pt.z)) continue;
      const p = this.spawnPed('civilian', pt.x, pt.z, Math.atan2(e.dx, e.dz));
      p.nav.edgeId = e.id;
      p.nav.t = t;
      p.seed = extra / 1.2;
      p.setState('walk');
      return p;
    }
    return null;
  }

  /** A driver bails out of a vehicle and flees. */
  bailOut(v: Vehicle, time: number): Pedestrian | null {
    const spots = v.exitPositions();
    let spot = spots[0];
    for (const s of spots) {
      if (this.statics.isFree(s.x, s.z, 0.45)) {
        spot = s;
        break;
      }
    }
    const p = this.spawnPed('civilian', spot.x, spot.z, v.yaw);
    p.setState('flee');
    p.panicX = v.x;
    p.panicZ = v.z;
    p.stateTimer = 0;
    p.invulnTimer = 0.3;
    v.driver = null;
    void time;
    return p;
  }

  // ------------------------------------------------------------------ update
  update(dt: number, time: number, events: GameEvent[], vehicles: Vehicle[]): void {
    const p = this.cb.playerPos();
    // prune stale alerts
    for (let i = this.alerts.length - 1; i >= 0; i--) if (time - this.alerts[i].time > 6) this.alerts.splice(i, 1);

    // Spawn
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = 0.12;
      if (this.civilianCount < MAX_PEDESTRIANS) this.spawnCivilianNear(p.x, p.z);
    }
    // Despawn
    for (let i = this.peds.length - 1; i >= 0; i--) {
      const ped = this.peds[i];
      const d = Math.hypot(ped.x - p.x, ped.z - p.z);
      if (ped.dead && (ped.corpseTimer > 25 || (ped.corpseTimer > 8 && d > 80))) {
        this.despawn(ped);
        continue;
      }
      if (!ped.tag && ped.kind === 'civilian' && d > DESPAWN_RADIUS) this.despawn(ped);
    }
    // AI + step
    for (let i = 0; i < this.peds.length; i++) {
      const ped = this.peds[i];
      if (!ped.dead && ped.kind === 'civilian' && ped.state !== 'inVehicle' && ped.state !== 'follow' && ped.state !== 'enterVehicle') this.civilianAI(ped, dt, time);
      ped.step(dt, this.world, this.statics, this.dynamics);
    }
    this.separate();
    this.collideVehicles(time, events);
  }

  private civilianAI(ped: Pedestrian, dt: number, time: number): void {
    // React to alerts
    if (ped.state !== 'flee' && ped.state !== 'cower') {
      for (const a of this.alerts) {
        const d2 = ped.distSq(a.x, a.z);
        if (d2 < a.radius * a.radius && time - a.time < 1.5) {
          if (this.rng.chance(a.strength * 0.85 + 0.1)) {
            ped.panicX = a.x;
            ped.panicZ = a.z;
            ped.setState(this.rng.chance(0.15) ? 'cower' : 'flee');
            ped.stateTimer = 0;
            break;
          }
        }
      }
    }
    switch (ped.state) {
      case 'idle': {
        ped.stop();
        if (ped.stateTimer > 2 + ped.seed * 5) ped.setState('walk');
        break;
      }
      case 'walk': {
        this.walkSidewalk(ped, dt);
        break;
      }
      case 'flee': {
        const dx = ped.x - ped.panicX;
        const dz = ped.z - ped.panicZ;
        const d = Math.hypot(dx, dz) || 1;
        // run away, with a little wobble
        const wob = Math.sin(time * 3 + ped.seed * 10) * 0.5;
        const ax = dx / d + Math.cos(wob) * 0.2;
        const az = dz / d + Math.sin(wob) * 0.2;
        ped.moveToward(ped.x + ax * 6, ped.z + az * 6, ped.runSpeed, dt, 8);
        // stuck against a wall → pick a new direction
        if (ped.stateTimer > 0.6 && Math.hypot(ped.vx, ped.vz) < 0.3) {
          ped.panicX = ped.x + Math.cos(this.rng.range(0, 6.28)) * 5;
          ped.panicZ = ped.z + Math.sin(this.rng.range(0, 6.28)) * 5;
        }
        if (ped.stateTimer > 7 + ped.seed * 5 || d > 90) {
          ped.setState('walk');
          ped.nav.edgeId = -1;
        }
        break;
      }
      case 'cower': {
        ped.stop();
        ped.yaw = wrapAngle(Math.atan2(ped.panicX - ped.x, ped.panicZ - ped.z));
        if (ped.stateTimer > 4 + ped.seed * 4) {
          ped.setState('flee');
        }
        break;
      }
      case 'chase':
      case 'attack':
      case 'dead':
      case 'inVehicle':
      case 'follow':
      case 'enterVehicle':
        break;
    }
  }

  private walkSidewalk(ped: Pedestrian, dt: number): void {
    const nav = ped.nav;
    let e = nav.edgeId >= 0 ? this.roads.edges[nav.edgeId] : null;
    if (!e) {
      const ne = this.roads.nearestEdge(ped.x, ped.z);
      if (!ne) return;
      e = ne.edge;
      nav.edgeId = e.id;
      nav.t = ne.t;
    }
    const a = this.roads.nodes[e.from];
    const along = (ped.x - a.x) * e.dx + (ped.z - a.z) * e.dz;
    nav.t = along / e.length;
    const extra = ped.seed * 1.2;
    if (nav.t >= 0.98) {
      // reached the node: choose the next edge (prefer straight, no U-turns)
      const node = this.roads.nodes[e.to];
      const next = this.roads.pickNextEdge(node, e, this.rng, 0.45);
      nav.edgeId = next.id;
      nav.t = 0;
      if (this.rng.chance(0.06)) {
        ped.setState('idle');
        return;
      }
      return;
    }
    // Pursue a point a few metres ahead on the sidewalk
    const lookT = clamp(nav.t + 4 / e.length, 0, 1);
    this.sidewalkPoint(e, lookT, extra, pt);
    // if we're far from the sidewalk line (e.g. after fleeing), walk to it first
    ped.moveToward(pt.x, pt.z, ped.walkSpeed, dt, 6);
  }

  /** Cheap crowd separation. */
  private separate(): void {
    for (let i = 0; i < this.peds.length; i++) {
      const a = this.peds[i];
      if (a.dead || a.state === 'inVehicle') continue;
      const near = this.dynamics.pedsNear(a.x, a.z, 1.0);
      for (let j = 0; j < near.length; j++) {
        const b = near[j].ped;
        if (b === a || b.dead || b.state === 'inVehicle') continue;
        const dx = a.x - b.x;
        const dz = a.z - b.z;
        const d2 = dx * dx + dz * dz;
        const min = a.radius + b.radius;
        if (d2 >= min * min || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const push = (min - d) * 0.5;
        a.x += (dx / d) * push;
        a.z += (dz / d) * push;
        b.x -= (dx / d) * push;
        b.z -= (dz / d) * push;
      }
    }
  }

  private collideVehicles(time: number, events: GameEvent[]): void {
    for (let i = 0; i < this.peds.length; i++) {
      const ped = this.peds[i];
      if (ped.state === 'inVehicle') continue;
      if (ped.dead && !ped.ragdoll) continue; // corpses don't collide (they can be driven over)
      const near = this.dynamics.vehiclesNear(ped.x, ped.z, 6);
      for (let j = 0; j < near.length; j++) {
        const v = near[j].vehicle;
        const c = ped.collideVehicle(v);
        if (!c) continue;
        const closing = -(v.vx * c.nx + v.vz * c.nz);
        const vs = Math.hypot(v.vx, v.vz);
        if (!ped.dead && vs > 2.5 && closing > 1.5) {
          const dmg = closing * 9;
          const kb = 2 + closing * 0.9;
          const killed = ped.applyDamage(dmg, v.vx, v.vz, v.playerDriving, kb, time, events);
          if (!killed) {
            ped.vy = Math.max(ped.vy, 2.5 + closing * 0.2);
            ped.setState('flee');
            ped.panicX = v.x;
            ped.panicZ = v.z;
          }
          // slight slowdown for the car
          v.vx *= 0.97;
          v.vz *= 0.97;
          events.push({ type: 'impact', x: ped.x, y: ped.y + 1, z: ped.z, value: closing * 0.6, ref: v.id, byPlayer: v.playerDriving });
          this.raiseAlert(ped.x, ped.z, 30, time, 0.9);
        } else if (!ped.dead && vs > 0.5 && ped.kind === 'civilian' && ped.state === 'walk') {
          // nudged by a slow car: step away
          ped.setState('flee');
          ped.panicX = v.x;
          ped.panicZ = v.z;
          ped.stateTimer = 5;
        }
      }
    }
  }

  nearestPed(x: number, z: number, range: number, filter?: (p: Pedestrian) => boolean): Pedestrian | null {
    let best: Pedestrian | null = null;
    let bestD = range * range;
    const near = this.dynamics.pedsNear(x, z, range);
    for (let i = 0; i < near.length; i++) {
      const p = near[i].ped;
      if (filter && !filter(p)) continue;
      const d = p.distSq(x, z);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }
}
