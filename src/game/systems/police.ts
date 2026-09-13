/**
 * Wanted level + police response: heat accumulates from crimes, decays when out of sight;
 * police cars pursue (route-following then ramming), unload officers near an on-foot player;
 * officers chase and shoot; standing next to a cop gets you busted.
 */
import { COPS_ON_FOOT_PER_STAR, HEAT, POLICE_PER_STAR, WANTED_DECAY_PER_SEC, WANTED_OUT_OF_SIGHT_DELAY, WANTED_THRESHOLDS } from '../core/constants';
import { clamp } from '../core/mathUtils';
import { Rng } from '../core/rng';
import type { GameEvent, WorldData } from '../core/types';
import type { Pedestrian } from '../entities/pedestrian';
import type { Player } from '../entities/player';
import type { Vehicle } from '../entities/vehicle';
import type { DynamicWorld } from '../physics/dynamicWorld';
import type { StaticWorld } from '../physics/staticWorld';
import type { CombatSystem } from './combat';
import { COP_OPTS, hostileAI } from './npcCombat';
import type { PedestrianSystem } from './pedestrians';
import type { TrafficSystem } from './traffic';
import { GridRoadNetwork } from '../world/roadNetwork';

interface Pursuit {
  route: number[];
  idx: { i: number };
  routedAt: number;
  unloadedAt: number;
}

export class PoliceSystem {
  heat = 0;
  stars = 0;
  maxStarsReached = 0;
  private lastSeen = -100;
  private pursuits = new Map<number, Pursuit>();
  private spawnTimer = 0;
  private footSpawnTimer = 0;
  private bustedTimer = 0;
  busted = false;
  private rng = new Rng(9090);
  private roads: GridRoadNetwork;
  /** Seconds the player has been out of police sight. */
  outOfSight = 0;

  constructor(
    private world: WorldData,
    private statics: StaticWorld,
    private dynamics: DynamicWorld,
    private traffic: TrafficSystem,
    private peds: PedestrianSystem,
    private combat: CombatSystem,
  ) {
    this.roads = world.roads as GridRoadNetwork;
  }

  get policeVehicles(): Vehicle[] {
    return this.traffic.vehicles.filter((v) => v.role === 'police');
  }

  get cops(): Pedestrian[] {
    return this.peds.peds.filter((p) => p.kind === 'cop' && !p.dead);
  }

  addHeat(amount: number, time: number): void {
    this.heat = Math.min(WANTED_THRESHOLDS[5] * 1.3, this.heat + amount);
    this.lastSeen = time;
  }

  clear(): void {
    this.heat = 0;
    this.stars = 0;
    for (const v of this.policeVehicles) {
      v.role = 'traffic';
      v.siren = false;
      v.persistent = false;
    }
    this.pursuits.clear();
  }

  setStars(n: number, time: number): void {
    n = clamp(Math.round(n), 0, 5);
    this.heat = n === 0 ? 0 : WANTED_THRESHOLDS[n] + 10;
    this.stars = n;
    this.lastSeen = time;
    if (n === 0) this.clear();
  }

  /** Crime bookkeeping from the event stream. */
  handleEvent(e: GameEvent, time: number, player: Player): void {
    if (!e.byPlayer) return;
    switch (e.type) {
      case 'shotFired': {
        // Only counts if someone is around to notice (or already wanted)
        const witness = this.stars > 0 || this.peds.nearestPed(e.x, e.z, 45) !== null;
        if (witness) this.addHeat(HEAT.shotFired, time);
        break;
      }
      case 'pedHit':
        this.addHeat(HEAT.hitPed * 0.35, time);
        break;
      case 'pedKilled':
        this.addHeat(HEAT.killPed, time);
        break;
      case 'carjack':
        this.addHeat(HEAT.carjack, time);
        break;
      case 'vehicleDestroyed':
        this.addHeat(HEAT.destroyVehicle, time);
        break;
      case 'policeHit':
        this.addHeat(HEAT.shootPolice * (e.value ?? 1), time);
        break;
      case 'policeKilled':
        this.addHeat(HEAT.killPolice, time);
        break;
      case 'impact': {
        const v = typeof e.ref === 'number' ? this.traffic.findVehicle(e.ref) : undefined;
        if (v && v.type === 'police' && (e.value ?? 0) > 4) this.addHeat(HEAT.shootPolice * 0.25, time);
        break;
      }
      default:
        break;
    }
    void player;
  }

  update(dt: number, time: number, player: Player, events: GameEvent[]): void {
    // Stars with hysteresis
    let s = 0;
    for (let i = 1; i <= 5; i++) if (this.heat >= WANTED_THRESHOLDS[i]) s = i;
    if (s < this.stars && this.heat > WANTED_THRESHOLDS[this.stars] * 0.85) s = this.stars;
    if (s !== this.stars) {
      const prev = this.stars;
      this.stars = s;
      if (s > prev) events.push({ type: 'impact', x: player.x, y: player.y, z: player.z, ref: 'wantedUp', value: s });
    }
    this.maxStarsReached = Math.max(this.maxStarsReached, this.stars);

    // Visibility
    let seen = false;
    const pv = this.policeVehicles;
    for (const v of pv) {
      if (v.destroyed) continue;
      const d = Math.hypot(v.x - player.x, v.z - player.z);
      if (d < 75 && !this.statics.blocked(v.x, v.y + 1.2, v.z, player.x, player.y + 1, player.z)) {
        seen = true;
        break;
      }
    }
    if (!seen) {
      for (const c of this.cops) {
        const d = Math.hypot(c.x - player.x, c.z - player.z);
        if (d < 55 && !this.statics.blocked(c.x, c.y + 1.5, c.z, player.x, player.y + 1, player.z)) {
          seen = true;
          break;
        }
      }
    }
    if (seen) this.lastSeen = time;
    this.outOfSight = time - this.lastSeen;
    if (this.heat > 0) {
      if (this.stars === 0) this.heat = Math.max(0, this.heat - WANTED_DECAY_PER_SEC * 2 * dt);
      else if (this.outOfSight > WANTED_OUT_OF_SIGHT_DELAY) this.heat = Math.max(0, this.heat - WANTED_DECAY_PER_SEC * (1 + this.stars * 0.25) * dt);
    }
    if (this.heat <= 0 && this.stars === 0 && pv.length) {
      // stand down
      for (const v of pv) {
        v.role = 'traffic';
        v.siren = false;
        v.persistent = false;
        this.pursuits.delete(v.id);
      }
    }
    if (player.dead) return;

    // Spawn police vehicles
    const wantVehicles = POLICE_PER_STAR[this.stars];
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && pv.filter((v) => !v.destroyed).length < wantVehicles) {
      this.spawnTimer = this.stars >= 4 ? 2.5 : 4;
      this.spawnPoliceVehicle(player);
    }
    // Retire surplus (after stars drop)
    const alive = pv.filter((v) => !v.destroyed);
    if (alive.length > wantVehicles + 1) {
      const far = alive.sort((a, b) => b.distSq(player.x, player.z) - a.distSq(player.x, player.z))[0];
      far.role = 'traffic';
      far.siren = false;
      far.persistent = false;
      this.pursuits.delete(far.id);
    }

    // Vehicle AI
    for (const v of pv) {
      if (v.destroyed) {
        v.siren = false;
        continue;
      }
      this.pursue(v, player, dt, time);
    }

    // Cops on foot: spawn near the player at higher stars
    const wantCops = COPS_ON_FOOT_PER_STAR[this.stars];
    const cops = this.cops;
    this.footSpawnTimer -= dt;
    if (this.stars >= 2 && cops.length < wantCops && this.footSpawnTimer <= 0) {
      this.footSpawnTimer = 3;
      this.spawnCopOnFoot(player);
    }
    for (const c of cops) {
      if (c.state === 'inVehicle') continue;
      if (this.stars === 0) {
        // heat is gone: holster and wander off
        c.aiming = false;
        c.stop();
        if (c.state !== 'idle') c.setState('idle');
        if (c.stateTimer > 5) this.peds.despawn(c);
        continue;
      }
      hostileAI(c, player, this.combat, this.statics, dt, time, events, COP_OPTS);
      // far away cops despawn
      if (c.distSq(player.x, player.z) > 260 * 260) this.peds.despawn(c);
    }

    // Busted check
    this.busted = false;
    if (this.stars > 0) {
      const playerSpeed = Math.hypot(player.vx, player.vz);
      let adjacent = false;
      for (const c of cops) {
        if (c.distSq(player.x, player.z) < 2.4 * 2.4 && !player.vehicle) {
          adjacent = true;
          break;
        }
      }
      if (adjacent && playerSpeed < 0.6) this.bustedTimer += dt;
      else this.bustedTimer = Math.max(0, this.bustedTimer - dt * 2);
      if (this.bustedTimer > 1.6) {
        this.busted = true;
        this.bustedTimer = 0;
      }
    } else this.bustedTimer = 0;
  }

  private spawnPoliceVehicle(player: Player): Vehicle | null {
    for (let attempt = 0; attempt < 8; attempt++) {
      const ang = this.rng.range(0, Math.PI * 2);
      const dist = this.rng.range(110, 190);
      const x = player.x + Math.cos(ang) * dist;
      const z = player.z + Math.sin(ang) * dist;
      const ne = this.roads.nearestEdge(x, z);
      if (!ne) continue;
      const e = ne.edge;
      const pt = { x: 0, z: 0 };
      this.roads.lanePoint(e, 0, clamp(ne.t, 0.1, 0.9), pt);
      const yaw = Math.atan2(e.dx, e.dz);
      if (!this.traffic.isSpawnFree('police', pt.x, pt.z, yaw)) continue;
      const v = this.traffic.spawnVehicle('police', pt.x, pt.z, yaw, 'police');
      v.persistent = true;
      v.siren = true;
      v.headlights = true;
      const sp = 12;
      v.vx = e.dx * sp;
      v.vz = e.dz * sp;
      v.speed = sp;
      v.sleeping = false;
      // a driver cop (invisible inside; becomes visible when unloading)
      return v;
    }
    return null;
  }

  private spawnCopOnFoot(player: Player): void {
    for (let attempt = 0; attempt < 6; attempt++) {
      const ang = this.rng.range(0, Math.PI * 2);
      const dist = this.rng.range(45, 80);
      const x = player.x + Math.cos(ang) * dist;
      const z = player.z + Math.sin(ang) * dist;
      if (!this.statics.isFree(x, z, 0.6) || this.world.isWaterAt(x, z)) continue;
      const c = this.peds.spawnPed('cop', x, z, Math.atan2(player.x - x, player.z - z), { skin: '#e0ac7e', shirt: '#1f2d5a', pants: '#152040', hair: '#111111' });
      c.weapon = this.stars >= 3 ? 'smg' : 'pistol';
      c.setState('chase');
      return;
    }
  }

  private pursue(v: Vehicle, player: Player, dt: number, time: number): void {
    v.siren = true;
    v.persistent = true;
    let p = this.pursuits.get(v.id);
    if (!p) {
      p = { route: [], idx: { i: 0 }, routedAt: -100, unloadedAt: -100 };
      this.pursuits.set(v.id, p);
    }
    const dist = Math.hypot(player.x - v.x, player.z - v.z);
    const playerOnFoot = !player.vehicle;
    const los = dist < 90 && !this.statics.blocked(v.x, v.y + 1.2, v.z, player.x, player.y + 1, player.z);

    // Unload officers next to an on-foot player
    if (playerOnFoot && dist < 24) {
      v.controls.throttle = 0;
      v.controls.brake = 1;
      v.controls.steer = 0;
      v.controls.handbrake = true;
      if (time - p.unloadedAt > 25 && Math.abs(v.speed) < 3 && v.tag !== 'unloaded') {
        p.unloadedAt = time;
        v.tag = 'unloaded';
        const spots = v.exitPositions();
        const n = this.stars >= 3 ? 2 : 1;
        for (let i = 0; i < n && i < spots.length; i++) {
          const s = spots[i];
          if (!this.statics.isFree(s.x, s.z, 0.45)) continue;
          const c = this.peds.spawnPed('cop', s.x, s.z, v.yaw, { skin: '#e0ac7e', shirt: '#1f2d5a', pants: '#152040', hair: '#111111' });
          c.weapon = this.stars >= 3 ? 'smg' : 'pistol';
          c.setState('chase');
        }
      }
      return;
    }
    if (dist > 40) v.tag = '';

    const maxSpeed = 22 + this.stars * 4;
    if (los && dist < 70) {
      // direct pursuit / ram
      p.route = [];
      this.traffic.driveTo(v, player.x + player.vx * 0.5, player.z + player.vz * 0.5, maxSpeed, playerOnFoot ? 6 : 1.5, dt);
      return;
    }
    // Route via roads
    if (time - p.routedAt > 4 || p.route.length === 0 || p.idx.i >= p.route.length) {
      const from = this.roads.nearestNode(v.x, v.z);
      const to = this.roads.nearestNode(player.x, player.z);
      p.route = this.roads.route(from.id, to.id);
      p.idx = { i: 0 };
      p.routedAt = time;
    }
    const done = this.traffic.followRoute(v, p.route, p.idx, maxSpeed, dt);
    if (done) this.traffic.driveTo(v, player.x, player.z, maxSpeed, 5, dt);
  }
}
