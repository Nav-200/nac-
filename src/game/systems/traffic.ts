/**
 * Vehicle manager + traffic AI: spawns/despawns traffic and parked cars around the player,
 * drives NPC vehicles along lanes (pure-pursuit steering, signals, following distance,
 * pedestrian yielding, stuck recovery) and exposes driving primitives for the police AI.
 */
import { DESPAWN_RADIUS, MAX_TRAFFIC, SPAWN_RADIUS_MAX, SPAWN_RADIUS_MIN } from '../core/constants';
import { clamp, wrapAngle } from '../core/mathUtils';
import { Rng } from '../core/rng';
import { CAR_COLORS } from '../core/textures';
import { TRAFFIC_VEHICLE_TYPES, VEHICLE_SPECS, type District, type GameEvent, type RoadEdge, type VehicleType, type WorldData } from '../core/types';
import { Vehicle, type VehicleNav, type VehicleRole } from '../entities/vehicle';
import type { Pedestrian } from '../entities/pedestrian';
import type { DynamicWorld } from '../physics/dynamicWorld';
import type { StaticWorld } from '../physics/staticWorld';
import { GridRoadNetwork, lineHalfWidth } from '../world/roadNetwork';

export interface TrafficCallbacks {
  onSpawn(v: Vehicle): void;
  onDespawn(v: Vehicle): void;
  /** Driver bails out of a damaged / attacked vehicle. */
  onDriverFlee(v: Vehicle): void;
  playerPos(): { x: number; z: number; onFoot: boolean };
}

const MAX_PARKED_ALIVE = 44;
const PARK_SPAWN_RADIUS = 170;
const lanePt = { x: 0, z: 0 };

export class TrafficSystem {
  readonly vehicles: Vehicle[] = [];
  private roads: GridRoadNetwork;
  private rng: Rng;
  private spawnTimer = 0;
  private parkedBySpot = new Map<number, Vehicle>();
  private spotByVehicle = new Map<Vehicle, number>();
  private night = 0;
  private parkScanTimer = 0;

  constructor(
    private world: WorldData,
    private statics: StaticWorld,
    private dynamics: DynamicWorld,
    private cb: TrafficCallbacks,
    seed = 4242,
  ) {
    this.roads = world.roads as GridRoadNetwork;
    this.rng = new Rng(seed);
  }

  setNight(n: number): void {
    this.night = n;
  }

  get trafficCount(): number {
    let n = 0;
    for (const v of this.vehicles) if (v.role === 'traffic') n++;
    return n;
  }

  // ------------------------------------------------------------------ spawning
  spawnVehicle(type: VehicleType, x: number, z: number, yaw: number, role: VehicleRole, colorHex?: number): Vehicle {
    const spec = VEHICLE_SPECS[type];
    const color = colorHex ?? (spec.colors ? parseInt(spec.colors[0].slice(1), 16) : parseInt(this.rng.pick(CAR_COLORS).slice(1), 16));
    const v = new Vehicle(type, color);
    v.role = role;
    v.setPose(x, z, yaw, this.world.groundHeightAt(x, z));
    v.headlights = this.night > 0.5;
    this.vehicles.push(v);
    this.dynamics.vehicles.insert(v.collider);
    this.cb.onSpawn(v);
    return v;
  }

  despawn(v: Vehicle): void {
    const i = this.vehicles.indexOf(v);
    if (i < 0) return;
    this.vehicles.splice(i, 1);
    this.dynamics.vehicles.remove(v.collider);
    const spot = this.spotByVehicle.get(v);
    if (spot !== undefined) {
      this.spotByVehicle.delete(v);
      this.parkedBySpot.delete(spot);
    }
    this.cb.onDespawn(v);
  }

  /** Is the footprint at (x,z,yaw) free of statics and other vehicles? */
  isSpawnFree(type: VehicleType, x: number, z: number, yaw: number): boolean {
    const spec = VEHICLE_SPECS[type];
    const r = Math.max(spec.length, spec.width) / 2 + 0.6;
    if (!this.statics.isFree(x, z, spec.width / 2 + 0.3)) return false;
    const near = this.dynamics.vehiclesNear(x, z, r + 6);
    for (const nb of near) {
      const o = nb.vehicle;
      const d = Math.hypot(o.x - x, o.z - z);
      if (d < r + Math.max(o.spec.length, o.spec.width) / 2) return false;
    }
    void yaw;
    return true;
  }

  pickTrafficType(district: District): VehicleType {
    const weights = TRAFFIC_VEHICLE_TYPES.map((t) => {
      let w = VEHICLE_SPECS[t].trafficWeight;
      if (district === 'industrial' || district === 'harbor') {
        if (t === 'truck' || t === 'van' || t === 'pickup') w *= 3;
        if (t === 'sports' || t === 'taxi') w *= 0.3;
      } else if (district === 'downtown' || district === 'midtown') {
        if (t === 'taxi' || t === 'sedan') w *= 2;
        if (t === 'truck') w *= 0.3;
      } else if (district === 'residential') {
        if (t === 'compact' || t === 'suv') w *= 1.8;
        if (t === 'truck' || t === 'bus') w *= 0.4;
      }
      return w;
    });
    return this.rng.weighted(TRAFFIC_VEHICLE_TYPES, weights);
  }

  /** Spawn a traffic car on a random lane point at spawn distance from the player. Returns null if no spot found. */
  spawnTrafficNear(px: number, pz: number, avoidNear: { x: number; z: number } | null = null): Vehicle | null {
    for (let attempt = 0; attempt < 8; attempt++) {
      const ang = this.rng.range(0, Math.PI * 2);
      const dist = this.rng.range(SPAWN_RADIUS_MIN, SPAWN_RADIUS_MAX);
      const x = px + Math.cos(ang) * dist;
      const z = pz + Math.sin(ang) * dist;
      const ne = this.roads.nearestEdge(x, z);
      if (!ne) continue;
      const e = ne.edge;
      const lane = this.rng.int(0, e.lanes.length - 1);
      const t = clamp(ne.t, 0.1, 0.9);
      this.roads.lanePoint(e, lane, t, lanePt);
      if (avoidNear && Math.hypot(lanePt.x - avoidNear.x, lanePt.z - avoidNear.z) < 40) continue;
      const yaw = Math.atan2(e.dx, e.dz);
      const type = this.pickTrafficType(this.world.districtAt(lanePt.x, lanePt.z));
      if (!this.isSpawnFree(type, lanePt.x, lanePt.z, yaw)) continue;
      const v = this.spawnVehicle(type, lanePt.x, lanePt.z, yaw, 'traffic');
      v.nav.edgeId = e.id;
      v.nav.lane = lane;
      v.nav.t = t;
      v.nav.nextEdgeId = -1;
      v.nav.targetSpeed = this.cruiseSpeed(e);
      // start moving
      const sp = v.nav.targetSpeed * 0.7;
      v.vx = e.dx * sp;
      v.vz = e.dz * sp;
      v.speed = sp;
      v.sleeping = false;
      return v;
    }
    return null;
  }

  private cruiseSpeed(e: RoadEdge): number {
    return e.isAvenue ? 16.5 : 11.5;
  }

  // ------------------------------------------------------------------ update
  update(dt: number, time: number, events: GameEvent[]): void {
    const p = this.cb.playerPos();
    // Spawn traffic
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = 0.4;
      if (this.trafficCount < MAX_TRAFFIC) this.spawnTrafficNear(p.x, p.z, p);
    }
    // Parked cars streaming (scan every 0.5 s)
    this.parkScanTimer -= dt;
    if (this.parkScanTimer <= 0) {
      this.parkScanTimer = 0.5;
      this.streamParked(p.x, p.z);
    }
    // Despawn far vehicles
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const v = this.vehicles[i];
      if (v.playerDriving) continue;
      const d = Math.hypot(v.x - p.x, v.z - p.z);
      if (v.persistent && d < DESPAWN_RADIUS * 2.5) continue;
      if (d > DESPAWN_RADIUS || (v.destroyed && d > 70 && time - v.lastHitTime > 20) || (v.destroyed && time - v.lastHitTime > 120)) {
        this.despawn(v);
      }
    }
    // AI + physics
    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i];
      if (v.role === 'traffic' && !v.destroyed) this.driveTraffic(v, dt, time, p);
      else if (v.role === 'parked' && !v.playerDriving) {
        v.controls.throttle = 0;
        v.controls.steer = 0;
        v.controls.brake = 0;
        v.controls.handbrake = Math.abs(v.speed) < 2;
      }
      v.headlights = this.night > 0.45 || v.playerDriving ? v.headlights || this.night > 0.45 : false;
      if (this.night <= 0.45 && !v.playerDriving) v.headlights = false;
      v.step(dt, this.world, this.statics, this.dynamics, time, events, this.onPropHit);
      // Attacked / burning traffic → driver flees
      if (v.role === 'traffic' && !v.destroyed && (v.burnTimer >= 0 || (v.lastHitByPlayer && time - v.lastHitTime < 2 && v.damage01 > 0.25))) {
        v.role = 'parked';
        v.controls.throttle = 0;
        v.controls.brake = 1;
        v.controls.steer = 0;
        this.cb.onDriverFlee(v);
      }
    }
  }

  /** Breakable props give way to vehicles; the game supplies the real implementation. */
  onPropHit: (c: import('../core/collision').BoxCollider, impact: number) => boolean = () => false;

  private streamParked(px: number, pz: number): void {
    const spots = this.world.parkingSpots;
    // despawn far parked cars that were never used
    for (const [spot, v] of this.parkedBySpot) {
      if (v.playerDriving || v.persistent) continue;
      const d = Math.hypot(v.x - px, v.z - pz);
      if (d > DESPAWN_RADIUS) {
        this.despawn(v);
      } else if (v.role !== 'parked' || Math.hypot(v.x - spots[spot].x, v.z - spots[spot].z) > 3) {
        // moved away from its spot: no longer counts as parked here
        this.parkedBySpot.delete(spot);
        this.spotByVehicle.delete(v);
      }
    }
    if (this.parkedBySpot.size >= MAX_PARKED_ALIVE) return;
    // Deterministic subset of spots host a car (seeded by index) so the city feels consistent.
    for (let i = 0; i < spots.length; i++) {
      if (this.parkedBySpot.size >= MAX_PARKED_ALIVE) break;
      const s = spots[i];
      const dx = s.x - px;
      const dz = s.z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 > PARK_SPAWN_RADIUS * PARK_SPAWN_RADIUS || d2 < 35 * 35) continue;
      if (this.parkedBySpot.has(i)) continue;
      const h = ((i * 2654435761) >>> 0) / 4294967296;
      if (h > 0.55) continue; // ~55% of spots occupied
      const type = this.pickTrafficType(s.district);
      if (type === 'bus' || type === 'truck') continue;
      if (!this.isSpawnFree(type, s.x, s.z, s.yaw)) continue;
      const colorIdx = Math.floor(h * 1000) % CAR_COLORS.length;
      const v = this.spawnVehicle(type, s.x, s.z, s.yaw, 'parked', VEHICLE_SPECS[type].colors ? undefined : parseInt(CAR_COLORS[colorIdx].slice(1), 16));
      v.controls.handbrake = true;
      this.parkedBySpot.set(i, v);
      this.spotByVehicle.set(v, i);
    }
  }

  // ------------------------------------------------------------------ traffic AI
  private driveTraffic(v: Vehicle, dt: number, time: number, p: { x: number; z: number; onFoot: boolean }): void {
    const nav = v.nav;
    let e = nav.edgeId >= 0 ? this.roads.edges[nav.edgeId] : null;
    // (Re)acquire a lane when knocked off course or uninitialised
    if (!e || this.lateralError(v, e, nav.lane) > 5.5) {
      const ne = this.roads.nearestEdge(v.x, v.z);
      if (!ne) return;
      e = ne.edge;
      nav.edgeId = e.id;
      nav.lane = clamp(Math.round((Math.abs(ne.lateral) - e.lanes[0].offset) / 3.5), 0, e.lanes.length - 1);
      nav.t = ne.t;
      nav.nextEdgeId = -1;
    }
    // Progress along the edge
    const a = this.roads.nodes[e.from];
    const along = (v.x - a.x) * e.dx + (v.z - a.z) * e.dz;
    nav.t = clamp(along / e.length, 0, 1.05);
    const toNode = this.roads.nodes[e.to];
    const distToNode = e.length - along;
    const crossHalf = lineHalfWidth(e.alongX ? toNode.gx : toNode.gz);

    // Choose the next edge ahead of time
    if (nav.nextEdgeId < 0) {
      const next = this.roads.pickNextEdge(toNode, e, this.rng, 0.55);
      nav.nextEdgeId = next.id;
    }
    const next = this.roads.edges[nav.nextEdgeId];
    // Switch edges once we pass the node centre
    if (along >= e.length) {
      nav.edgeId = next.id;
      nav.lane = Math.min(nav.lane, next.lanes.length - 1);
      nav.t = 0;
      nav.nextEdgeId = -1;
      return;
    }

    // Pursuit target
    const look = 5 + Math.abs(v.speed) * 0.55;
    let tx: number;
    let tz: number;
    if (distToNode > look) {
      this.roads.lanePoint(e, nav.lane, (along + look) / e.length, lanePt);
    } else {
      const over = look - distToNode;
      const nlane = Math.min(nav.lane, next.lanes.length - 1);
      this.roads.lanePoint(next, nlane, clamp(over / next.length, 0, 1), lanePt);
    }
    tx = lanePt.x;
    tz = lanePt.z;
    const targetYaw = Math.atan2(tx - v.x, tz - v.z);
    const angle = wrapAngle(targetYaw - v.yaw); // >0 = target is to the LEFT
    let steer = clamp(-angle * 2.2, -1, 1);

    // Target speed
    let target = this.cruiseSpeed(e);
    let reason: VehicleNav['reason'] = 'cruise';
    const turning = Math.abs(next.dx - e.dx) > 0.1 || Math.abs(next.dz - e.dz) > 0.1;
    if (turning && distToNode < 18) {
      target = Math.min(target, 6);
      reason = 'turn';
    }
    if (Math.abs(angle) > 0.5) {
      target = Math.min(target, 4);
      reason = 'turn';
    }

    // Traffic signals
    const sig = this.roads.signalState(toNode, time);
    if (sig !== 'none') {
      const myAxisNS = !e.alongX;
      const green = (sig === 'ns' && myAxisNS) || (sig === 'ew' && !myAxisNS);
      const stopLine = crossHalf + 2.5;
      if (!green && distToNode > crossHalf - 1 && distToNode < stopLine + 8) {
        // slow to a stop at the line
        const room = distToNode - stopLine;
        target = room < 0.6 ? 0 : Math.min(target, Math.sqrt(Math.max(0, room) * 2 * 6));
        reason = 'signal';
      }
    }

    // Following distance / obstacles ahead
    const ahead = this.obstacleAhead(v, p);
    if (ahead >= 0) {
      const gap = ahead;
      if (gap < 3.5) target = 0;
      else target = Math.min(target, Math.max(0, (gap - 3) * 1.4));
      nav.waitTimer += dt;
      reason = 'obstacle';
    } else nav.waitTimer = 0;
    nav.reason = reason;

    // Stuck recovery
    const moving = Math.abs(v.speed) > 0.4;
    if (!moving && target > 1) nav.stuckTimer += dt;
    else nav.stuckTimer = Math.max(0, nav.stuckTimer - dt * 2);
    if (nav.reverseTimer > 0) {
      nav.reverseTimer -= dt;
      nav.reason = 'reverse';
      v.controls.throttle = -0.7;
      v.controls.steer = -steer;
      v.controls.brake = 0;
      v.controls.handbrake = false;
      return;
    }
    if (nav.stuckTimer > 3.5) {
      nav.stuckTimer = 0;
      nav.reverseTimer = 1.4;
      return;
    }
    // Honk when blocked
    v.controls.horn = nav.waitTimer > 2.5 && nav.waitTimer < 2.8 && this.rng.chance(0.4);

    // Speed control
    const err = target - v.speed;
    if (err > 0.3) {
      v.controls.throttle = clamp(err * 0.45, 0.2, 1);
      v.controls.brake = 0;
    } else if (err < -0.6) {
      v.controls.throttle = 0;
      v.controls.brake = clamp(-err * 0.35, 0.15, 1);
    } else {
      v.controls.throttle = target > 0.1 ? 0.15 : 0;
      v.controls.brake = target <= 0.1 && Math.abs(v.speed) > 0.05 ? 0.6 : 0;
    }
    v.controls.steer = steer;
    v.controls.handbrake = false;
  }

  private lateralError(v: Vehicle, e: RoadEdge, lane: number): number {
    const a = this.roads.nodes[e.from];
    const along = (v.x - a.x) * e.dx + (v.z - a.z) * e.dz;
    this.roads.lanePoint(e, lane, clamp(along / e.length, 0, 1), lanePt);
    return Math.hypot(v.x - lanePt.x, v.z - lanePt.z);
  }

  /**
   * Distance to the nearest vehicle / pedestrian / player in a corridor ahead of the vehicle,
   * or -1 if clear.
   */
  private obstacleAhead(v: Vehicle, p: { x: number; z: number; onFoot: boolean }): number {
    const fx = v.forwardX;
    const fz = v.forwardZ;
    const rx = v.rightX;
    const rz = v.rightZ;
    const reach = v.spec.length / 2 + 4 + Math.abs(v.speed) * 1.1;
    const halfW = v.spec.width / 2 + 0.2;
    let best = -1;
    /**
     * alongRadius = obstacle half-extent along our heading, sideRadius = across it.
     * Oncoming vehicles in the opposite lane must not count, nor cars parked at the kerb.
     */
    const consider = (ox: number, oz: number, alongRadius: number, sideRadius: number, oSpeedAlong: number) => {
      const dx = ox - v.x;
      const dz = oz - v.z;
      const along = dx * fx + dz * fz;
      const side = Math.abs(dx * rx + dz * rz);
      if (along < 0 || along > reach + alongRadius) return;
      if (side > halfW + sideRadius) return;
      // ignore things moving away faster than us
      if (oSpeedAlong > v.speed + 0.5 && along > 6) return;
      const gap = along - v.spec.length / 2 - alongRadius;
      if (best < 0 || gap < best) best = Math.max(0, gap);
    };
    const cx = v.x + fx * reach * 0.5;
    const cz = v.z + fz * reach * 0.5;
    const vs = this.dynamics.vehiclesNear(cx, cz, reach * 0.5 + 6);
    for (let i = 0; i < vs.length; i++) {
      const o = vs[i].vehicle;
      if (o === v) continue;
      const headingDot = o.forwardX * fx + o.forwardZ * fz;
      const oSpeedAlong = o.vx * fx + o.vz * fz;
      // project the other car's box onto our axes
      const alongR = Math.abs(headingDot) * o.spec.length / 2 + (1 - Math.abs(headingDot)) * o.spec.width / 2;
      const sideR = Math.abs(headingDot) * o.spec.width / 2 + (1 - Math.abs(headingDot)) * o.spec.length / 2;
      // oncoming traffic that is not actually in our lane is ignored
      if (headingDot < -0.5) {
        const dx = o.x - v.x;
        const dz = o.z - v.z;
        const side = Math.abs(dx * rx + dz * rz);
        if (side > halfW + o.spec.width * 0.35) continue;
      }
      consider(o.x, o.z, alongR, sideR, oSpeedAlong);
    }
    const ps = this.dynamics.pedsNear(cx, cz, reach * 0.5 + 3);
    for (let i = 0; i < ps.length; i++) {
      const ped = ps[i].ped;
      if (ped.dead || ped.state === 'inVehicle') continue;
      consider(ped.x, ped.z, 0.5, 0.5, 0);
    }
    if (p.onFoot) consider(p.x, p.z, 0.6, 0.6, 0);
    return best;
  }

  // ------------------------------------------------------------------ driving primitives (police / missions)
  /**
   * Drive toward a world point with pure pursuit. Returns the distance remaining.
   * `aggressive` ignores speed limits and rams.
   */
  driveTo(v: Vehicle, gx: number, gz: number, maxSpeed: number, arriveRadius = 4, dt = 1 / 60, slowOnApproach = true): number {
    const dx = gx - v.x;
    const dz = gz - v.z;
    const dist = Math.hypot(dx, dz);
    const targetYaw = Math.atan2(dx, dz);
    const angle = wrapAngle(targetYaw - v.yaw);
    const nav = v.nav;
    // stuck handling
    if (Math.abs(v.speed) < 0.4 && dist > arriveRadius + 1) nav.stuckTimer += dt;
    else nav.stuckTimer = Math.max(0, nav.stuckTimer - dt * 2);
    if (nav.reverseTimer > 0) {
      nav.reverseTimer -= dt;
      v.controls.throttle = -0.8;
      v.controls.steer = angle > 0 ? 1 : -1;
      v.controls.brake = 0;
      v.controls.handbrake = false;
      return dist;
    }
    if (nav.stuckTimer > 2.5) {
      nav.stuckTimer = 0;
      nav.reverseTimer = 1.2;
    }
    if (Math.abs(angle) > 2.4 && dist < 14) {
      // target behind us: three-point turn
      v.controls.throttle = -0.7;
      v.controls.steer = angle > 0 ? 1 : -1;
      v.controls.brake = 0;
      v.controls.handbrake = false;
      return dist;
    }
    let target = maxSpeed;
    if (Math.abs(angle) > 0.9) target = Math.min(target, 7);
    else if (Math.abs(angle) > 0.4) target = Math.min(target, 13);
    if (slowOnApproach) {
      if (dist < arriveRadius) target = 0;
      else if (dist < 25) target = Math.min(target, 4 + dist * 0.5);
    }
    const err = target - v.speed;
    v.controls.steer = clamp(-angle * 2.0, -1, 1);
    v.controls.handbrake = false;
    if (err > 0.3) {
      v.controls.throttle = clamp(err * 0.5, 0.3, 1);
      v.controls.brake = 0;
    } else if (err < -0.8) {
      v.controls.throttle = 0;
      v.controls.brake = clamp(-err * 0.3, 0.2, 1);
    } else {
      v.controls.throttle = target > 0.1 ? 0.2 : 0;
      v.controls.brake = target <= 0.1 ? 0.5 : 0;
    }
    return dist;
  }

  /** Follow a road route (node ids) then a final point. Returns true when the route is consumed. */
  followRoute(v: Vehicle, route: number[], routeIndex: { i: number }, maxSpeed: number, dt: number): boolean {
    while (routeIndex.i < route.length) {
      const n = this.roads.nodes[route[routeIndex.i]];
      // aim for the right-hand lane of the edge we are on toward this node
      let tx = n.x;
      let tz = n.z;
      if (routeIndex.i > 0) {
        const prev = this.roads.nodes[route[routeIndex.i - 1]];
        const eid = this.roads.edgeBetween(prev.id, n.id);
        if (eid >= 0) {
          const e = this.roads.edges[eid];
          const a = prev;
          const look = 12 + Math.abs(v.speed) * 0.6;
          const along = clamp(((v.x - a.x) * e.dx + (v.z - a.z) * e.dz + look) / e.length, 0, 1);
          this.roads.lanePoint(e, 0, along, lanePt);
          tx = lanePt.x;
          tz = lanePt.z;
          if (along >= 0.999) {
            tx = n.x;
            tz = n.z;
          }
        }
      }
      const d = Math.hypot(v.x - n.x, v.z - n.z);
      if (d < 9) {
        routeIndex.i++;
        continue;
      }
      // slow for the corner when the route turns at this node
      let speed = maxSpeed;
      if (routeIndex.i + 1 < route.length && routeIndex.i > 0) {
        const prev = this.roads.nodes[route[routeIndex.i - 1]];
        const next = this.roads.nodes[route[routeIndex.i + 1]];
        const turns = Math.abs(Math.sign(next.x - n.x) - Math.sign(n.x - prev.x)) + Math.abs(Math.sign(next.z - n.z) - Math.sign(n.z - prev.z)) > 0;
        if (turns && d < 22) speed = Math.min(speed, 9);
      }
      this.driveTo(v, tx, tz, speed, 2, dt, false);
      return false;
    }
    return true;
  }

  findVehicle(id: number): Vehicle | undefined {
    return this.vehicles.find((v) => v.id === id);
  }

  /** Nearest enterable vehicle to a point within range. */
  nearestVehicle(x: number, z: number, range: number, filter?: (v: Vehicle) => boolean): Vehicle | null {
    let best: Vehicle | null = null;
    let bestD = range * range;
    const near = this.dynamics.vehiclesNear(x, z, range + 6);
    for (let i = 0; i < near.length; i++) {
      const v = near[i].vehicle;
      if (filter && !filter(v)) continue;
      // distance to the box surface approximately
      const d = v.distSq(x, z);
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    return best;
  }

  /** Remove the driver reference when a pedestrian dies etc. */
  clearDriver(ped: Pedestrian): void {
    for (const v of this.vehicles) if (v.driver === ped) v.driver = null;
  }
}
