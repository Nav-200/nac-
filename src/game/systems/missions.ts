/**
 * Missions: markers in the world start short activities — courier runs, vehicle deliveries,
 * taxi fares, checkpoint races, assassination contracts, vigilante chases and rampages.
 */
import { clamp } from '../core/mathUtils';
import { Rng } from '../core/rng';
import type { HudMission } from '../core/store';
import type { GameEvent, MissionSpawn, MissionType, WorldData } from '../core/types';
import type { Pedestrian } from '../entities/pedestrian';
import type { Player } from '../entities/player';
import type { Vehicle } from '../entities/vehicle';
import type { DynamicWorld } from '../physics/dynamicWorld';
import type { StaticWorld } from '../physics/staticWorld';
import type { CombatSystem } from './combat';
import { GANG_OPTS, hostileAI } from './npcCombat';
import type { PedestrianSystem } from './pedestrians';
import type { TrafficSystem } from './traffic';
import { GridRoadNetwork, rightOf } from '../world/roadNetwork';

export interface MissionCallbacks {
  player(): Player;
  notify(text: string, kind: 'info' | 'money' | 'mission' | 'warning'): void;
  bigText(title: string, sub: string, color: string): void;
  setWaypoint(x: number, z: number): void;
  clearWaypoint(): void;
  /** Show a single objective marker in the world (null hides it). kind selects the look. */
  setObjective(pos: { x: number; z: number; kind: 'checkpoint' | 'marker' | 'target' } | null): void;
  time(): number;
}

interface Point {
  x: number;
  z: number;
}

interface ActiveMission {
  spawn: MissionSpawn;
  type: MissionType;
  startTime: number;
  /** Deadline in game time (Infinity = untimed). */
  deadline: number;
  objective: string;
  progress: string;
  reward: number;
  stage: number;
  // type-specific
  points: Point[];
  pointIndex: number;
  vehicle: Vehicle | null;
  peds: Pedestrian[];
  target: Pedestrian | null;
  kills: number;
  killGoal: number;
  waves: number;
  wave: number;
  timerStarted: boolean;
  fareEarned: number;
  outOfVehicleTimer: number;
  spawnTimer: number;
  par: number;
}

const MARKER_RADIUS = 2.4;
const COOLDOWN_DONE = 40;
const COOLDOWN_FAIL = 12;

export class MissionSystem {
  active: ActiveMission | null = null;
  readonly completed = new Map<string, number>(); // best time
  private cooldownUntil = new Map<string, number>();
  private rng = new Rng(31337);
  private roads: GridRoadNetwork;
  private endedMessageUntil = 0;

  constructor(
    private world: WorldData,
    private statics: StaticWorld,
    private dynamics: DynamicWorld,
    private traffic: TrafficSystem,
    private peds: PedestrianSystem,
    private combat: CombatSystem,
    private cb: MissionCallbacks,
  ) {
    this.roads = world.roads as GridRoadNetwork;
  }

  get markers(): MissionSpawn[] {
    return this.world.missions;
  }

  isMarkerActive(m: MissionSpawn, time: number): boolean {
    if (this.active) return false;
    return (this.cooldownUntil.get(m.id) ?? 0) <= time;
  }

  hud(): HudMission | null {
    const a = this.active;
    if (!a) return null;
    const now = this.cb.time();
    return { active: true, id: a.spawn.id, title: a.spawn.title, objective: a.objective, timeLeft: isFinite(a.deadline) ? Math.max(0, a.deadline - now) : null, progress: a.progress, reward: a.reward };
  }

  // ------------------------------------------------------------------ helpers
  /** Random sidewalk point roughly `min..max` metres from (x,z). */
  private randomSidewalkPoint(x: number, z: number, min: number, max: number): Point {
    for (let i = 0; i < 20; i++) {
      const a = this.rng.range(0, Math.PI * 2);
      const d = this.rng.range(min, max);
      const px = clamp(x + Math.cos(a) * d, -960, 900);
      const pz = clamp(z + Math.sin(a) * d, -960, 960);
      const ne = this.roads.nearestEdge(px, pz);
      if (!ne) continue;
      const e = ne.edge;
      const t = this.rng.range(0.15, 0.85);
      const a0 = this.roads.nodes[e.from];
      const [rx, rz] = rightOf(e.dx, e.dz);
      const off = e.halfWidth + 1.6;
      const pt = { x: a0.x + e.dx * e.length * t + rx * off, z: a0.z + e.dz * e.length * t + rz * off };
      if (this.statics.isFree(pt.x, pt.z, 0.8) && !this.world.isWaterAt(pt.x, pt.z)) return pt;
    }
    return { x, z };
  }

  /** Random lane point (on the road) `min..max` metres away. */
  private randomLanePoint(x: number, z: number, min: number, max: number): { pt: Point; yaw: number } | null {
    for (let i = 0; i < 20; i++) {
      const a = this.rng.range(0, Math.PI * 2);
      const d = this.rng.range(min, max);
      const px = clamp(x + Math.cos(a) * d, -960, 900);
      const pz = clamp(z + Math.sin(a) * d, -960, 960);
      const ne = this.roads.nearestEdge(px, pz);
      if (!ne) continue;
      const pt = { x: 0, z: 0 };
      this.roads.lanePoint(ne.edge, 0, clamp(ne.t, 0.15, 0.85), pt);
      const yaw = Math.atan2(ne.edge.dx, ne.edge.dz);
      if (this.traffic.isSpawnFree('sedan', pt.x, pt.z, yaw)) return { pt, yaw };
    }
    return null;
  }

  private spawnHostile(x: number, z: number, weapon: 'bat' | 'pistol' | 'smg' | 'fist', kind: 'criminal' | 'target' = 'criminal'): Pedestrian {
    const p = this.peds.spawnPed(kind, x, z, 0, { skin: this.rng.pick(['#e0ac7e', '#c68642', '#8d5524', '#f1c9a5']), shirt: kind === 'target' ? '#ffffff' : this.rng.pick(['#111111', '#4a0d0d', '#2b2b2b', '#5c2a83']), pants: '#1b1b1b', hair: '#111111' });
    p.weapon = weapon === 'fist' ? null : weapon;
    p.tag = kind;
    p.setState('chase');
    return p;
  }

  private setObjectivePoint(pt: Point, kind: 'checkpoint' | 'marker' | 'target' = 'marker'): void {
    this.cb.setWaypoint(pt.x, pt.z);
    this.cb.setObjective({ x: pt.x, z: pt.z, kind });
  }

  private distTo(pt: Point): number {
    const p = this.cb.player();
    return Math.hypot(p.x - pt.x, p.z - pt.z);
  }

  // ------------------------------------------------------------------ lifecycle
  update(dt: number, time: number, events: GameEvent[]): void {
    const player = this.cb.player();
    if (!this.active) {
      if (player.dead || time < this.endedMessageUntil) return;
      for (const m of this.world.missions) {
        if (!this.isMarkerActive(m, time)) continue;
        const d = Math.hypot(m.x - player.x, m.z - player.z);
        if (d < MARKER_RADIUS + (player.vehicle ? 2 : 0)) {
          this.start(m, time);
          break;
        }
      }
      return;
    }
    const a = this.active;
    if (player.dead) {
      this.fail('You died.', time);
      return;
    }
    if (time > a.deadline) {
      this.fail('Out of time.', time);
      return;
    }
    switch (a.type) {
      case 'courier':
        this.updateCourier(a, time);
        break;
      case 'delivery':
        this.updateDelivery(a, time);
        break;
      case 'taxi':
        this.updateTaxi(a, dt, time);
        break;
      case 'race':
        this.updateRace(a, time);
        break;
      case 'hit':
        this.updateHit(a, dt, time, events);
        break;
      case 'vigilante':
        this.updateVigilante(a, dt, time, events);
        break;
      case 'rampage':
        this.updateRampage(a, dt, time, events);
        break;
    }
  }

  start(m: MissionSpawn, time: number): boolean {
    if (this.active) return false;
    const player = this.cb.player();
    const a: ActiveMission = {
      spawn: m,
      type: m.type,
      startTime: time,
      deadline: Infinity,
      objective: '',
      progress: '',
      reward: 0,
      stage: 0,
      points: [],
      pointIndex: 0,
      vehicle: null,
      peds: [],
      target: null,
      kills: 0,
      killGoal: 0,
      waves: 1,
      wave: 0,
      timerStarted: false,
      fareEarned: 0,
      outOfVehicleTimer: 0,
      spawnTimer: 0,
      par: 0,
    };
    this.active = a;
    switch (m.type) {
      case 'courier': {
        let last: Point = { x: m.x, z: m.z };
        for (let i = 0; i < 3; i++) {
          last = this.randomSidewalkPoint(last.x, last.z, 220, 480);
          a.points.push(last);
        }
        a.reward = 300;
        this.nextCourierLeg(a, time);
        break;
      }
      case 'delivery': {
        const spot = this.randomLanePoint(m.x, m.z, 12, 40);
        if (!spot) {
          this.active = null;
          return false;
        }
        const v = this.traffic.spawnVehicle('van', spot.pt.x, spot.pt.z, spot.yaw, 'mission', 0xdddddd);
        v.persistent = true;
        v.tag = 'delivery';
        a.vehicle = v;
        const harbor = this.world.poi.find((p) => p.icon === 'harbor');
        const dest = this.randomSidewalkPoint(harbor ? harbor.x : 600, harbor ? harbor.z : 800, 20, 60);
        a.points = [dest];
        a.reward = 1200;
        a.objective = 'Get in the delivery van';
        a.deadline = time + 240;
        this.setObjectivePoint({ x: v.x, z: v.z }, 'marker');
        break;
      }
      case 'taxi': {
        a.waves = 3;
        a.reward = 0;
        a.deadline = Infinity;
        a.objective = player.vehicle ? 'Pick up the passenger' : 'Get a vehicle, then pick up the passenger';
        this.newFare(a, time);
        break;
      }
      case 'race': {
        // random walk over the road graph, every 2nd node is a checkpoint
        let node = this.roads.nearestNode(m.x, m.z);
        let prevEdge = null as null | number;
        let total = 0;
        let lastPt: Point = { x: m.x, z: m.z };
        for (let i = 0; i < 16; i++) {
          const arriving = prevEdge !== null ? this.roads.edges[prevEdge] : null;
          const e = this.roads.pickNextEdge(node, arriving, this.rng, 0.65);
          node = this.roads.nodes[e.to];
          prevEdge = e.id;
          if (i % 2 === 1) {
            const pt = { x: node.x, z: node.z };
            total += Math.hypot(pt.x - lastPt.x, pt.z - lastPt.z);
            lastPt = pt;
            a.points.push(pt);
          }
        }
        a.par = total / 16 + 12;
        a.deadline = Infinity; // timer starts at the first checkpoint
        a.reward = 2000;
        a.objective = player.vehicle ? 'Drive through the checkpoints' : 'Get a car, then hit the first checkpoint';
        a.progress = `0/${a.points.length}`;
        this.setObjectivePoint(a.points[0], 'checkpoint');
        break;
      }
      case 'hit': {
        const pt = this.randomSidewalkPoint(m.x, m.z, 140, 260);
        const t = this.spawnHostile(pt.x, pt.z, 'pistol', 'target');
        t.setState('idle');
        a.target = t;
        a.peds.push(t);
        for (let i = 0; i < 2; i++) {
          const g = this.spawnHostile(pt.x + this.rng.range(-3, 3), pt.z + this.rng.range(-3, 3), i === 0 ? 'smg' : 'pistol');
          g.setState('idle');
          a.peds.push(g);
        }
        a.reward = 1500;
        a.deadline = time + 240;
        a.objective = 'Take out the target (white shirt)';
        this.setObjectivePoint(pt, 'target');
        break;
      }
      case 'vigilante': {
        a.waves = 3;
        a.reward = 0;
        this.newCriminalWave(a, time);
        break;
      }
      case 'rampage': {
        a.killGoal = 12;
        a.deadline = time + 120;
        a.reward = 2500;
        a.objective = 'Kill the gang members';
        a.progress = `0/${a.killGoal}`;
        if (!player.hasWeapon('smg')) player.giveWeapon('smg', 150);
        else player.giveAmmo('smg', 120);
        player.selectWeapon('smg');
        this.cb.setObjective(null);
        this.cb.clearWaypoint();
        break;
      }
    }
    this.cb.bigText(m.title.toUpperCase(), a.objective, '#f5b700');
    this.cb.notify(`Mission started: ${m.title}`, 'mission');
    events_push_mission_started(this.cb, m);
    return true;
  }

  private finish(time: number, bonus = 0): void {
    const a = this.active;
    if (!a) return;
    const player = this.cb.player();
    const total = a.reward + bonus;
    player.addMoney(total);
    player.stats.missionsDone++;
    const elapsed = time - a.startTime;
    const best = this.completed.get(a.spawn.id);
    if (best === undefined || elapsed < best) this.completed.set(a.spawn.id, elapsed);
    this.cb.bigText('MISSION PASSED', `+$${total}`, '#f5b700');
    this.cb.notify(`Mission passed! +$${total}`, 'money');
    this.cooldownUntil.set(a.spawn.id, time + COOLDOWN_DONE);
    this.cleanup(a);
    this.endedMessageUntil = time + 3;
    this.active = null;
  }

  fail(reason: string, time: number): void {
    const a = this.active;
    if (!a) return;
    this.cb.bigText('MISSION FAILED', reason, '#e5484d');
    this.cb.notify(`Mission failed: ${reason}`, 'warning');
    this.cooldownUntil.set(a.spawn.id, time + COOLDOWN_FAIL);
    this.cleanup(a);
    this.endedMessageUntil = time + 3;
    this.active = null;
  }

  /** Abort silently (new game / respawn). */
  abort(time: number): void {
    if (!this.active) return;
    this.cooldownUntil.set(this.active.spawn.id, time + COOLDOWN_FAIL);
    this.cleanup(this.active);
    this.active = null;
  }

  private cleanup(a: ActiveMission): void {
    this.cb.clearWaypoint();
    this.cb.setObjective(null);
    if (a.vehicle) {
      a.vehicle.persistent = a.vehicle.playerDriving;
      if (a.vehicle.role === 'mission') a.vehicle.role = a.vehicle.playerDriving ? 'player' : 'parked';
      a.vehicle.tag = '';
    }
    for (const p of a.peds) {
      if (p.dead) continue;
      if (p.state === 'inVehicle') {
        this.peds.despawn(p);
        continue;
      }
      // remaining hostiles calm down and wander off
      p.kind = 'civilian';
      p.tag = '';
      p.weapon = null;
      p.aiming = false;
      p.setState('flee');
      p.panicX = this.cb.player().x;
      p.panicZ = this.cb.player().z;
    }
  }

  // ------------------------------------------------------------------ courier
  private nextCourierLeg(a: ActiveMission, time: number): void {
    const pt = a.points[a.pointIndex];
    const d = this.distTo(pt);
    a.deadline = time + d / 8 + 30;
    a.objective = 'Deliver the package to the marker';
    a.progress = `${a.pointIndex + 1}/${a.points.length}`;
    this.setObjectivePoint(pt, 'marker');
  }

  private updateCourier(a: ActiveMission, time: number): void {
    const pt = a.points[a.pointIndex];
    if (this.distTo(pt) < 3.2) {
      const player = this.cb.player();
      player.addMoney(300);
      this.cb.notify('Package delivered +$300', 'money');
      a.pointIndex++;
      if (a.pointIndex >= a.points.length) {
        a.reward = 0;
        this.finish(time, 500);
      } else this.nextCourierLeg(a, time);
    }
  }

  // ------------------------------------------------------------------ delivery
  private updateDelivery(a: ActiveMission, time: number): void {
    const player = this.cb.player();
    const v = a.vehicle!;
    if (v.destroyed) {
      this.fail('The van was destroyed.', time);
      return;
    }
    if (a.stage === 0) {
      if (player.vehicle === v) {
        a.stage = 1;
        const dest = a.points[0];
        a.deadline = time + this.distTo(dest) / 11 + 45;
        a.objective = 'Drive the van to the docks';
        this.setObjectivePoint(dest, 'marker');
      } else this.cb.setObjective({ x: v.x, z: v.z, kind: 'marker' });
      return;
    }
    if (player.vehicle !== v) {
      a.objective = 'Get back in the van';
      this.cb.setObjective({ x: v.x, z: v.z, kind: 'marker' });
      return;
    }
    a.objective = 'Drive the van to the docks';
    const dest = a.points[0];
    this.cb.setObjective({ x: dest.x, z: dest.z, kind: 'marker' });
    if (Math.hypot(v.x - dest.x, v.z - dest.z) < 6 && Math.abs(v.speed) < 2) {
      const bonus = v.damage01 < 0.3 ? 400 : 0;
      if (bonus) this.cb.notify('Undamaged bonus +$400', 'money');
      this.finish(time, bonus);
    }
  }

  // ------------------------------------------------------------------ taxi
  private newFare(a: ActiveMission, time: number): void {
    const player = this.cb.player();
    const pt = this.randomSidewalkPoint(player.x, player.z, 110, 240);
    const p = this.peds.spawnPed('passenger', pt.x, pt.z, 0);
    p.tag = 'passenger';
    p.setState('idle');
    a.peds.push(p);
    a.target = p;
    a.stage = 0; // 0 = pick up, 1 = drive
    a.deadline = time + 120;
    a.objective = 'Pick up the passenger';
    a.progress = `Fare ${a.wave + 1}/${a.waves}`;
    this.setObjectivePoint(pt, 'marker');
  }

  private updateTaxi(a: ActiveMission, dt: number, time: number): void {
    const player = this.cb.player();
    const pax = a.target!;
    if (pax.dead) {
      this.fail('Your passenger died.', time);
      return;
    }
    if (a.stage === 0) {
      if (!player.vehicle) {
        a.objective = 'Get a vehicle, then pick up the passenger';
        return;
      }
      a.objective = 'Pick up the passenger';
      const d = Math.hypot(pax.x - player.x, pax.z - player.z);
      if (d < 7 && Math.abs(player.vehicle.speed) < 1.5) {
        pax.vehicle = player.vehicle;
        pax.setState('inVehicle');
        a.stage = 1;
        const dest = this.randomSidewalkPoint(player.x, player.z, 280, 620);
        a.points = [dest];
        const dist = this.distTo(dest);
        a.deadline = time + dist / 10 + 35;
        a.objective = 'Drive the passenger to the destination';
        this.setObjectivePoint(dest, 'marker');
        this.cb.notify('Passenger picked up', 'mission');
      } else if (d < 30 && Math.abs(player.vehicle.speed) < 1.5) {
        // walk to the car
        pax.moveToward(player.x, player.z, pax.walkSpeed * 1.4, dt);
        pax.setState('follow');
      }
      return;
    }
    // driving
    if (!player.vehicle || player.vehicle !== pax.vehicle) {
      a.outOfVehicleTimer += dt;
      a.objective = 'Get back in your vehicle';
      if (a.outOfVehicleTimer > 20) {
        this.fail('You abandoned your passenger.', time);
        return;
      }
      if (pax.vehicle && pax.vehicle.destroyed) {
        this.fail('Your vehicle was destroyed.', time);
      }
      return;
    }
    a.outOfVehicleTimer = 0;
    a.objective = 'Drive the passenger to the destination';
    const dest = a.points[0];
    if (this.distTo(dest) < 8 && Math.abs(player.vehicle.speed) < 1.5) {
      const fare = Math.round(60 + Math.hypot(dest.x - pax.destinationX, dest.z - pax.destinationZ) * 0 + (a.deadline - time) * 4);
      player.addMoney(fare);
      a.fareEarned += fare;
      this.cb.notify(`Fare +$${fare}`, 'money');
      pax.setState('idle');
      pax.vehicle = null;
      pax.setPosition(dest.x, dest.z);
      pax.kind = 'civilian';
      pax.tag = '';
      a.peds = a.peds.filter((p) => p !== pax);
      a.wave++;
      if (a.wave >= a.waves) {
        a.reward = 0;
        this.finish(time, 500);
      } else this.newFare(a, time);
    }
  }

  // ------------------------------------------------------------------ race
  private updateRace(a: ActiveMission, time: number): void {
    const player = this.cb.player();
    const pt = a.points[a.pointIndex];
    if (!player.vehicle) {
      a.objective = a.pointIndex === 0 ? 'Get a car, then hit the first checkpoint' : 'Get back in a car!';
      return;
    }
    a.objective = 'Drive through the checkpoints';
    if (this.distTo(pt) < 6) {
      if (!a.timerStarted) {
        a.timerStarted = true;
        a.startTime = time;
        a.deadline = time + a.par;
      }
      a.pointIndex++;
      a.progress = `${a.pointIndex}/${a.points.length}`;
      this.cb.notify(`Checkpoint ${a.pointIndex}/${a.points.length}`, 'mission');
      if (a.pointIndex >= a.points.length) {
        const elapsed = time - a.startTime;
        const bonus = elapsed < a.par * 0.75 ? 1000 : 0;
        if (bonus) this.cb.notify('Fast time bonus +$1000', 'money');
        this.finish(time, bonus);
        return;
      }
      this.setObjectivePoint(a.points[a.pointIndex], 'checkpoint');
    }
  }

  // ------------------------------------------------------------------ hit
  private updateHit(a: ActiveMission, dt: number, time: number, events: GameEvent[]): void {
    const player = this.cb.player();
    const t = a.target!;
    if (t.dead) {
      this.finish(time, 0);
      return;
    }
    const d = Math.hypot(t.x - player.x, t.z - player.z);
    const alerted = d < 30 || t.hitFlash > 0 || a.stage === 1;
    if (alerted) {
      a.stage = 1;
      // target flees, guards fight
      const dx = t.x - player.x;
      const dz = t.z - player.z;
      const len = Math.hypot(dx, dz) || 1;
      t.moveToward(t.x + (dx / len) * 8, t.z + (dz / len) * 8, t.runSpeed, dt, 8);
      t.setState('flee');
      if (t.stateTimer > 0.8 && Math.hypot(t.vx, t.vz) < 0.3) {
        t.panicX = t.x + Math.cos(this.rng.range(0, 6.28)) * 5;
        t.moveToward(t.panicX, t.z + this.rng.range(-4, 4), t.runSpeed, dt, 8);
      }
      // occasionally shoots back
      if (d < 20 && t.fireCooldown <= 0 && t.weapon) {
        hostileAI(t, player, this.combat, this.statics, dt, time, events, { ...GANG_OPTS, keepDistance: true });
      }
      for (const g of a.peds) if (g !== t && !g.dead) hostileAI(g, player, this.combat, this.statics, dt, time, events, GANG_OPTS);
    } else {
      // idle chatter
      for (const g of a.peds) {
        if (g.dead) continue;
        g.stop();
        g.yaw += Math.sin(time * 0.5 + g.seed) * 0.002;
      }
    }
    this.cb.setObjective({ x: t.x, z: t.z, kind: 'target' });
    this.cb.setWaypoint(t.x, t.z);
  }

  // ------------------------------------------------------------------ vigilante
  private newCriminalWave(a: ActiveMission, time: number): void {
    const player = this.cb.player();
    const spot = this.randomLanePoint(player.x, player.z, 110, 170);
    if (!spot) {
      this.fail('No criminals found.', time);
      return;
    }
    const type = this.rng.pick(['sedan', 'sports', 'suv', 'pickup'] as const);
    const v = this.traffic.spawnVehicle(type, spot.pt.x, spot.pt.z, spot.yaw, 'mission', 0x222222);
    v.persistent = true;
    v.tag = 'criminal';
    v.nav.goalX = NaN;
    a.vehicle = v;
    const driver = this.spawnHostile(v.x, v.z, 'pistol');
    driver.vehicle = v;
    driver.setState('inVehicle');
    v.driver = driver;
    a.peds.push(driver);
    a.target = driver;
    a.stage = 0;
    a.deadline = time + 150;
    a.objective = 'Stop the criminal vehicle';
    a.progress = `Suspect ${a.wave + 1}/${a.waves}`;
    this.setObjectivePoint({ x: v.x, z: v.z }, 'target');
  }

  private updateVigilante(a: ActiveMission, dt: number, time: number, events: GameEvent[]): void {
    const player = this.cb.player();
    const v = a.vehicle!;
    const crim = a.target!;
    if (a.stage === 0) {
      // flee: drive to a far goal away from the player, re-plan when reached
      if (v.destroyed || v.damage01 > 0.65 || (v.health < v.maxHealth * 0.5 && Math.abs(v.speed) < 1.5)) {
        // bail out
        const spots = v.exitPositions();
        const s = spots.find((p) => this.statics.isFree(p.x, p.z, 0.45)) ?? spots[0];
        crim.setPosition(s.x, s.z, v.yaw);
        crim.vehicle = null;
        crim.setState('chase');
        v.driver = null;
        v.role = 'parked';
        v.persistent = false;
        v.controls.throttle = 0;
        v.controls.brake = 1;
        a.stage = 1;
        a.objective = 'Take down the suspect on foot';
        return;
      }
      const dx = v.x - player.x;
      const dz = v.z - player.z;
      const d = Math.hypot(dx, dz);
      if (Number.isNaN(v.nav.goalX) || Math.hypot(v.x - v.nav.goalX, v.z - v.nav.goalZ) < 25 || v.nav.progressTimer > 6) {
        // pick a node ~300 m away, biased away from the player
        const gx = clamp(v.x + (dx / (d || 1)) * 320 + this.rng.range(-120, 120), -950, 900);
        const gz = clamp(v.z + (dz / (d || 1)) * 320 + this.rng.range(-120, 120), -950, 950);
        const n = this.roads.nearestNode(gx, gz);
        v.nav.goalX = n.x;
        v.nav.goalZ = n.z;
        v.nav.progressTimer = 0;
        const from = this.roads.nearestNode(v.x, v.z);
        (v as unknown as { _route?: number[]; _ri?: { i: number } })._route = this.roads.route(from.id, n.id);
        (v as unknown as { _route?: number[]; _ri?: { i: number } })._ri = { i: 0 };
      }
      const ext = v as unknown as { _route?: number[]; _ri?: { i: number } };
      v.nav.progressTimer += Math.abs(v.speed) < 1 ? dt : -dt * 0.5;
      if (v.nav.progressTimer < 0) v.nav.progressTimer = 0;
      const done = ext._route && ext._ri ? this.traffic.followRoute(v, ext._route, ext._ri, 24, dt) : true;
      if (done) this.traffic.driveTo(v, v.nav.goalX, v.nav.goalZ, 24, 6, dt);
      this.cb.setObjective({ x: v.x, z: v.z, kind: 'target' });
      this.cb.setWaypoint(v.x, v.z);
      return;
    }
    // on foot
    if (crim.dead) {
      player.addMoney(800);
      this.cb.notify('Suspect neutralised +$800', 'money');
      a.wave++;
      if (a.wave >= a.waves) {
        a.reward = 0;
        this.finish(time, 600);
      } else {
        a.peds = a.peds.filter((p) => p !== crim);
        this.newCriminalWave(a, time);
      }
      return;
    }
    hostileAI(crim, player, this.combat, this.statics, dt, time, events, GANG_OPTS);
    this.cb.setObjective({ x: crim.x, z: crim.z, kind: 'target' });
    this.cb.setWaypoint(crim.x, crim.z);
  }

  // ------------------------------------------------------------------ rampage
  private updateRampage(a: ActiveMission, dt: number, time: number, events: GameEvent[]): void {
    const player = this.cb.player();
    // count kills
    for (let i = a.peds.length - 1; i >= 0; i--) {
      const p = a.peds[i];
      if (p.dead) {
        a.kills++;
        a.peds.splice(i, 1);
      }
    }
    a.progress = `${a.kills}/${a.killGoal}`;
    if (a.kills >= a.killGoal) {
      this.finish(time, 0);
      return;
    }
    a.spawnTimer -= dt;
    const alive = a.peds.length;
    if (alive < 5 && a.spawnTimer <= 0 && a.kills + alive < a.killGoal + 2) {
      a.spawnTimer = 1.2;
      for (let i = 0; i < 2; i++) {
        const ang = this.rng.range(0, Math.PI * 2);
        const d = this.rng.range(22, 45);
        const x = player.x + Math.cos(ang) * d;
        const z = player.z + Math.sin(ang) * d;
        if (!this.statics.isFree(x, z, 0.6) || this.world.isWaterAt(x, z)) continue;
        const w = this.rng.pick(['bat', 'pistol', 'pistol', 'fist'] as const);
        a.peds.push(this.spawnHostile(x, z, w));
      }
    }
    for (const g of a.peds) hostileAI(g, player, this.combat, this.statics, dt, time, events, GANG_OPTS);
    a.objective = `Kill the gang members`;
  }

  summaries(): { id: string; title: string; type: string; x: number; z: number; done: boolean; bestTime: number | null }[] {
    return this.world.missions.map((m) => ({ id: m.id, title: m.title, type: m.type, x: m.x, z: m.z, done: this.completed.has(m.id), bestTime: this.completed.get(m.id) ?? null }));
  }
}

function events_push_mission_started(cb: MissionCallbacks, m: MissionSpawn): void {
  void cb;
  void m;
}
