/**
 * Combat: hitscan bullets, melee, rockets and explosions — shared by the player and NPCs.
 * Produces GameEvents for audio/effects/heat; visual effects are applied by the Game.
 */
import { rayVsBox, rayVsCylinder, type BoxCollider } from '../core/collision';
import { clamp } from '../core/mathUtils';
import { WEAPON_SPECS, type GameEvent, type WeaponId, type WeaponSpec, type WorldData } from '../core/types';
import type { Pedestrian } from '../entities/pedestrian';
import type { Player } from '../entities/player';
import type { Vehicle } from '../entities/vehicle';
import type { DynamicWorld } from '../physics/dynamicWorld';
import type { StaticWorld, StaticRayResult } from '../physics/staticWorld';

export type Shooter = 'player' | Pedestrian;

export interface ShotResult {
  kind: 'none' | 'static' | 'ped' | 'vehicle' | 'player';
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  dist: number;
  ped: Pedestrian | null;
  vehicle: Vehicle | null;
  collider: BoxCollider | null;
  headshot: boolean;
  killed: boolean;
}

export interface Rocket {
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
  speed: number;
  life: number;
  byPlayer: boolean;
  spec: WeaponSpec;
  id: number;
}

const ray: StaticRayResult = { hit: null, t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0 };
let nextRocketId = 1;

export interface CombatHooks {
  /** Damage a breakable prop; return true if it was destroyed. */
  damageProp(c: BoxCollider, amount: number, byPlayer: boolean): boolean;
}

export class CombatSystem {
  readonly rockets: Rocket[] = [];
  private rng = Math.random;

  constructor(
    private world: WorldData,
    private statics: StaticWorld,
    private dynamics: DynamicWorld,
    private hooks: CombatHooks,
  ) {}

  /** Cone spread applied to a direction (returns a new unit vector in out). */
  private spread(dx: number, dy: number, dz: number, angle: number, out: { x: number; y: number; z: number }): void {
    if (angle <= 0) {
      out.x = dx;
      out.y = dy;
      out.z = dz;
      return;
    }
    // orthonormal basis
    let ux = -dz;
    let uy = 0;
    let uz = dx;
    let ul = Math.hypot(ux, uy, uz);
    if (ul < 1e-4) {
      ux = 1;
      uy = 0;
      uz = 0;
      ul = 1;
    }
    ux /= ul;
    uz /= ul;
    const vx = dy * uz - dz * uy;
    const vy = dz * ux - dx * uz;
    const vz = dx * uy - dy * ux;
    const r = Math.sqrt(this.rng()) * angle;
    const a = this.rng() * Math.PI * 2;
    const ox = Math.cos(a) * r;
    const oy = Math.sin(a) * r;
    out.x = dx + ux * ox + vx * oy;
    out.y = dy + uy * ox + vy * oy;
    out.z = dz + uz * ox + vz * oy;
    const l = Math.hypot(out.x, out.y, out.z);
    out.x /= l;
    out.y /= l;
    out.z /= l;
  }

  private dir = { x: 0, y: 0, z: 0 };

  /**
   * Fire a hitscan weapon. Returns one ShotResult per pellet (array reused per call).
   */
  fireHitscan(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, spec: WeaponSpec, shooter: Shooter, player: Player, time: number, events: GameEvent[], spreadMul = 1): ShotResult[] {
    const results: ShotResult[] = [];
    const byPlayer = shooter === 'player';
    events.push({ type: 'shotFired', x: ox, y: oy, z: oz, ref: spec.id, byPlayer });
    for (let i = 0; i < spec.pellets; i++) {
      this.spread(dx, dy, dz, spec.spread * spreadMul, this.dir);
      const r = this.trace(ox, oy, oz, this.dir.x, this.dir.y, this.dir.z, spec.range, shooter, player);
      this.applyHit(r, spec, shooter, player, this.dir.x, this.dir.y, this.dir.z, time, events);
      results.push(r);
    }
    return results;
  }

  /** Trace a ray against statics, vehicles, pedestrians and (for NPC shooters) the player. */
  trace(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, shooter: Shooter, player: Player): ShotResult {
    const r: ShotResult = { kind: 'none', x: ox + dx * maxDist, y: oy + dy * maxDist, z: oz + dz * maxDist, nx: -dx, ny: -dy, nz: -dz, dist: maxDist, ped: null, vehicle: null, collider: null, headshot: false, killed: false };
    let best = maxDist;
    // statics
    if (this.statics.raycast(ox, oy, oz, dx, dy, dz, best, ray)) {
      best = ray.t;
      r.kind = 'static';
      r.x = ray.x;
      r.y = ray.y;
      r.z = ray.z;
      r.nx = ray.nx;
      r.ny = ray.ny;
      r.nz = ray.nz;
      r.collider = ray.hit;
    }
    // ground plane
    if (dy < -1e-4) {
      const gy = 0.1;
      const t = (gy - oy) / dy;
      if (t > 0 && t < best) {
        best = t;
        r.kind = 'static';
        r.x = ox + dx * t;
        r.y = gy;
        r.z = oz + dz * t;
        r.nx = 0;
        r.ny = 1;
        r.nz = 0;
        r.collider = null;
      }
    }
    // vehicles
    const ex = ox + dx * best;
    const ez = oz + dz * best;
    const vs = this.dynamics.vehiclesAlongRay(ox, oz, ex, ez);
    const shooterVehicle = shooter === 'player' ? player.vehicle : shooter.vehicle;
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i].vehicle;
      if (v === shooterVehicle) continue;
      const c = v.collider;
      // temporarily lift the box to the vehicle's y (collider height starts at 0)
      const t = rayVsBox(ox, oy - v.y, oz, dx, dy, dz, c, best);
      if (t >= 0 && t < best) {
        best = t;
        r.kind = 'vehicle';
        r.vehicle = v;
        r.ped = null;
        r.collider = null;
        r.x = ox + dx * t;
        r.y = oy + dy * t;
        r.z = oz + dz * t;
        // approximate normal: from vehicle centre to hit point, horizontal
        const nx = r.x - v.x;
        const nz = r.z - v.z;
        const nl = Math.hypot(nx, nz) || 1;
        r.nx = nx / nl;
        r.ny = 0.2;
        r.nz = nz / nl;
      }
    }
    // pedestrians
    const ps = this.dynamics.pedsAlongRay(ox, oz, ox + dx * best, oz + dz * best);
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i].ped;
      if (p === shooter || p.dead || p.state === 'inVehicle') continue;
      const h = p.height;
      const t = rayVsCylinder(ox, oy, oz, dx, dy, dz, p.x, p.z, 0.42, p.y, p.y + h, best);
      if (t >= 0 && t < best) {
        best = t;
        r.kind = 'ped';
        r.ped = p;
        r.vehicle = null;
        r.collider = null;
        r.x = ox + dx * t;
        r.y = oy + dy * t;
        r.z = oz + dz * t;
        r.nx = -dx;
        r.ny = -dy;
        r.nz = -dz;
        r.headshot = r.y > p.y + h * 0.82;
      }
    }
    // player (NPC shooters only)
    if (shooter !== 'player' && !player.dead) {
      const py = player.y;
      const t = player.vehicle ? -1 : rayVsCylinder(ox, oy, oz, dx, dy, dz, player.x, player.z, 0.45, py, py + 1.8, best);
      if (t >= 0 && t < best) {
        best = t;
        r.kind = 'player';
        r.ped = null;
        r.vehicle = null;
        r.collider = null;
        r.x = ox + dx * t;
        r.y = oy + dy * t;
        r.z = oz + dz * t;
        r.nx = -dx;
        r.ny = -dy;
        r.nz = -dz;
      }
    }
    r.dist = best;
    return r;
  }

  private applyHit(r: ShotResult, spec: WeaponSpec, shooter: Shooter, player: Player, dx: number, dy: number, dz: number, time: number, events: GameEvent[]): void {
    const byPlayer = shooter === 'player';
    switch (r.kind) {
      case 'ped': {
        const p = r.ped!;
        const dmg = spec.damage * (r.headshot ? 2.5 : 1);
        const wasCop = p.kind === 'cop';
        r.killed = p.applyDamage(dmg, dx, dz, byPlayer, spec.knockback, time, events);
        if (wasCop && byPlayer) events.push({ type: r.killed ? 'policeKilled' : 'policeHit', x: p.x, y: p.y, z: p.z, ref: p.id, byPlayer: true });
        break;
      }
      case 'vehicle': {
        const v = r.vehicle!;
        const destroyed = v.applyDamage(spec.damage * spec.vehicleDamageMul, byPlayer, time);
        if (v.playerDriving && !byPlayer) player.takeDamage(spec.damage * 0.35, time, 'shot', events);
        if (v.driver && !v.driver.dead && this.rng() < 0.3) v.driver.applyDamage(spec.damage * 0.5, dx, dz, byPlayer, 1, time, events);
        if (destroyed) v.explode(time, events);
        if (v.type === 'police' && byPlayer) events.push({ type: 'policeHit', x: v.x, y: v.y, z: v.z, ref: v.id, byPlayer: true, value: 0.3 });
        break;
      }
      case 'player': {
        player.takeDamage(spec.damage * 0.55, time, 'shot', events);
        break;
      }
      case 'static': {
        if (r.collider && r.collider.kind !== 'building' && r.collider.kind !== 'wall') this.hooks.damageProp(r.collider, spec.damage, byPlayer);
        break;
      }
      default:
        break;
    }
  }

  /**
   * Melee swing from a position facing yaw. Hits the closest ped / vehicle / prop within a cone.
   */
  melee(x: number, y: number, z: number, yaw: number, spec: WeaponSpec, shooter: Shooter, player: Player, time: number, events: GameEvent[]): ShotResult {
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const r: ShotResult = { kind: 'none', x: x + fx * spec.range, y: y + 1.2, z: z + fz * spec.range, nx: -fx, ny: 0, nz: -fz, dist: spec.range, ped: null, vehicle: null, collider: null, headshot: false, killed: false };
    const byPlayer = shooter === 'player';
    let best = spec.range + 0.5;
    const near = this.dynamics.pedsNear(x, z, spec.range + 1);
    for (let i = 0; i < near.length; i++) {
      const p = near[i].ped;
      if (p === shooter || p.dead || p.state === 'inVehicle') continue;
      const dx = p.x - x;
      const dz = p.z - z;
      const d = Math.hypot(dx, dz);
      if (d > best) continue;
      const dot = (dx * fx + dz * fz) / (d || 1);
      if (dot < 0.5) continue;
      best = d;
      r.kind = 'ped';
      r.ped = p;
      r.x = p.x;
      r.y = p.y + 1.2;
      r.z = p.z;
    }
    if (r.kind === 'none' && shooter !== 'player' && !player.dead && !player.vehicle) {
      const dx = player.x - x;
      const dz = player.z - z;
      const d = Math.hypot(dx, dz);
      if (d < best && (dx * fx + dz * fz) / (d || 1) > 0.5) {
        r.kind = 'player';
        r.x = player.x;
        r.y = player.y + 1.2;
        r.z = player.z;
      }
    }
    if (r.kind === 'none') {
      const vs = this.dynamics.vehiclesNear(x + fx * 1.2, z + fz * 1.2, spec.range + 2.5);
      for (let i = 0; i < vs.length; i++) {
        const v = vs[i].vehicle;
        if (v === (shooter === 'player' ? player.vehicle : shooter.vehicle)) continue;
        const t = rayVsBox(x, y + 1.0 - v.y, z, fx, 0, fz, v.collider, spec.range + 0.6);
        if (t >= 0) {
          r.kind = 'vehicle';
          r.vehicle = v;
          r.x = x + fx * t;
          r.y = y + 1.0;
          r.z = z + fz * t;
          break;
        }
      }
    }
    if (r.kind === 'none') {
      if (this.statics.raycast(x, y + 1.0, z, fx, 0, fz, spec.range + 0.3, ray) && ray.hit) {
        r.kind = 'static';
        r.collider = ray.hit;
        r.x = ray.x;
        r.y = ray.y;
        r.z = ray.z;
        r.nx = ray.nx;
        r.nz = ray.nz;
      }
    }
    this.applyHit(r, spec, shooter, player, fx, 0, fz, time, events);
    if (r.kind !== 'none') events.push({ type: 'impact', x: r.x, y: r.y, z: r.z, value: 1, ref: 'melee', byPlayer });
    return r;
  }

  // ------------------------------------------------------------------ rockets
  launchRocket(x: number, y: number, z: number, dx: number, dy: number, dz: number, spec: WeaponSpec, byPlayer: boolean): Rocket {
    const rk: Rocket = { x, y, z, dx, dy, dz, speed: 55, life: spec.range / 55, byPlayer, spec, id: nextRocketId++ };
    this.rockets.push(rk);
    return rk;
  }

  /** Advance rockets; explosions are pushed as events (the game applies damage via applyExplosion). */
  updateRockets(dt: number, player: Player, events: GameEvent[]): void {
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const rk = this.rockets[i];
      rk.life -= dt;
      const step = rk.speed * dt;
      const res = this.trace(rk.x, rk.y, rk.z, rk.dx, rk.dy, rk.dz, step + 0.4, rk.byPlayer ? 'player' : ({} as Pedestrian), player);
      let explode = rk.life <= 0;
      if (res.kind !== 'none' && res.dist <= step + 0.4) {
        rk.x = res.x - rk.dx * 0.2;
        rk.y = res.y - rk.dy * 0.2;
        rk.z = res.z - rk.dz * 0.2;
        explode = true;
      } else {
        rk.x += rk.dx * step;
        rk.y += rk.dy * step;
        rk.z += rk.dz * step;
        if (rk.y <= this.world.groundHeightAt(rk.x, rk.z) + 0.05) explode = true;
      }
      if (explode) {
        events.push({ type: 'explosion', x: rk.x, y: Math.max(rk.y, 0.3), z: rk.z, value: rk.spec.explosionRadius, ref: 'rocket', byPlayer: rk.byPlayer });
        this.rockets.splice(i, 1);
      }
    }
  }

  /**
   * Apply explosion damage + impulses to everything in radius. `sourceVehicle` is excluded
   * from damage (it already exploded) but still pushes others.
   */
  applyExplosion(x: number, y: number, z: number, radius: number, byPlayer: boolean, player: Player, time: number, events: GameEvent[], sourceVehicleId: number | string | undefined, props: BoxCollider[] = []): void {
    const maxDamage = 200;
    // peds
    const ps = this.dynamics.pedsNear(x, z, radius + 1);
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i].ped;
      if (p.dead) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d > radius) continue;
      const f = 1 - d / radius;
      const dmg = maxDamage * f + 20;
      const wasCop = p.kind === 'cop';
      const killed = p.applyDamage(dmg, p.x - x, p.z - z, byPlayer, 8 + 14 * f, time, events);
      if (killed) p.vy = 4 + 6 * f;
      if (wasCop && byPlayer) events.push({ type: killed ? 'policeKilled' : 'policeHit', x: p.x, y: p.y, z: p.z, ref: p.id, byPlayer: true });
    }
    // vehicles
    const vs = this.dynamics.vehiclesNear(x, z, radius + 4);
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i].vehicle;
      const d = Math.hypot(v.x - x, v.z - z);
      if (d > radius + 2) continue;
      const f = clamp(1 - d / (radius + 2), 0, 1);
      const nx = (v.x - x) / (d || 1);
      const nz = (v.z - z) / (d || 1);
      v.applyImpulse(nx * 9000 * f, nz * 9000 * f, (this.rng() - 0.5) * 3 * f);
      if (v.id === sourceVehicleId) continue;
      const destroyed = v.applyDamage(240 * f, byPlayer, time);
      if (v.playerDriving) player.takeDamage(45 * f, time, 'explosion', events);
      if (destroyed) {
        // chain reaction with a small delay is nicer, but keep it simple
        v.burnTimer = 0.4 + this.rng() * 0.8;
      }
      if (v.type === 'police' && byPlayer) events.push({ type: 'policeHit', x: v.x, y: v.y, z: v.z, ref: v.id, byPlayer: true, value: 1 });
    }
    // player
    if (!player.dead && !player.vehicle) {
      const d = Math.hypot(player.x - x, player.z - z);
      if (d < radius) {
        const f = 1 - d / radius;
        player.takeDamage(120 * f + 10, time, 'explosion', events);
        const nx = (player.x - x) / (d || 1);
        const nz = (player.z - z) / (d || 1);
        player.vx += nx * 8 * f;
        player.vz += nz * 8 * f;
        player.vy = Math.max(player.vy, 4 * f);
        player.onGround = false;
      }
    }
    // props
    for (const c of props) {
      const d = Math.hypot(c.cx - x, c.cz - z);
      if (d < radius) this.hooks.damageProp(c, 120 * (1 - d / radius) + 20, byPlayer);
    }
  }

  static weaponSpec(id: WeaponId): WeaponSpec {
    return WEAPON_SPECS[id];
  }
}
