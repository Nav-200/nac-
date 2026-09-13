/**
 * Pedestrian / cop simulation state: circle collider, health, ragdoll, animation phases and
 * the navigation record used by the pedestrian AI. Pure simulation — no three.js.
 */
import { circleVsBox, type Contact } from '../core/collision';
import { clamp, dampAngle, headingFromDir } from '../core/mathUtils';
import type { GameEvent, WeaponId } from '../core/types';
import type { WorldData } from '../core/types';
import type { StaticWorld } from '../physics/staticWorld';
import type { DynamicWorld, PedBounds } from '../physics/dynamicWorld';
import type { Vehicle } from './vehicle';

export type PedKind = 'civilian' | 'cop' | 'target' | 'passenger' | 'criminal';
export type PedState = 'idle' | 'walk' | 'flee' | 'cower' | 'chase' | 'attack' | 'dead' | 'inVehicle' | 'follow' | 'enterVehicle';

export interface PedNav {
  edgeId: number;
  /** +1 travelling along the directed edge, always walking on its right-hand sidewalk. */
  t: number;
  targetX: number;
  targetZ: number;
  hasTarget: boolean;
  repathTimer: number;
}

export interface PedAppearance {
  skin: string;
  shirt: string;
  pants: string;
  hair: string;
}

let nextPedId = 1;
const scratch: Contact = { nx: 0, nz: 0, depth: 0 };

export class Pedestrian {
  readonly id = nextPedId++;
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;
  vx = 0;
  vz = 0;
  vy = 0;
  readonly radius = 0.35;
  readonly height = 1.8;
  health = 100;
  maxHealth = 100;
  dead = false;
  deathTime = 0;
  /** Seconds since death; corpse despawns after a while. */
  corpseTimer = 0;
  ragdoll = false;
  ragdollSpin = 0;
  ragdollTimer = 0;
  state: PedState = 'idle';
  stateTimer = 0;
  panicX = 0;
  panicZ = 0;
  nav: PedNav = { edgeId: -1, t: 0, targetX: 0, targetZ: 0, hasTarget: false, repathTimer: 0 };
  weapon: WeaponId | null = null;
  fireCooldown = 0;
  ammoBurst = 0;
  aimYaw = 0;
  aimPitch = 0;
  aiming = false;
  walkPhase = 0;
  moveSpeed01 = 0;
  hitFlash = 0;
  punchT = -1;
  appearance: PedAppearance;
  vehicle: Vehicle | null = null;
  /** Cop-specific: seconds since last saw the player. */
  lastSeenPlayer = 999;
  /** Mission tag ('target', 'passenger', ...). */
  tag = '';
  readonly bounds: PedBounds;
  /** For mission passengers etc. */
  destinationX = 0;
  destinationZ = 0;
  age = 0;
  lastHitByPlayer = false;
  /** Prevents the same bullet from hitting twice etc. */
  invulnTimer = 0;
  walkSpeed = 1.5;
  runSpeed = 5.2;
  seed = Math.random();

  constructor(public kind: PedKind, appearance: PedAppearance) {
    this.appearance = appearance;
    this.bounds = { minX: 0, minZ: 0, maxX: 0, maxZ: 0, ped: this };
    if (kind === 'cop') {
      this.weapon = 'pistol';
      this.health = 120;
      this.maxHealth = 120;
    }
    this.walkSpeed = 1.2 + this.seed * 0.6;
    this.runSpeed = 4.8 + this.seed * 0.9;
  }

  get forwardX(): number {
    return Math.sin(this.yaw);
  }
  get forwardZ(): number {
    return Math.cos(this.yaw);
  }

  setPosition(x: number, z: number, yaw = this.yaw, y = 0): void {
    this.x = x;
    this.z = z;
    this.y = y;
    this.yaw = yaw;
    this.syncBounds();
  }

  syncBounds(): void {
    const r = this.radius;
    this.bounds.minX = this.x - r;
    this.bounds.maxX = this.x + r;
    this.bounds.minZ = this.z - r;
    this.bounds.maxZ = this.z + r;
  }

  setState(s: PedState): void {
    if (this.state === s) return;
    this.state = s;
    this.stateTimer = 0;
  }

  /** Steer velocity toward a point at the given speed. Returns remaining distance. */
  moveToward(tx: number, tz: number, speed: number, dt: number, turnRate = 10): number {
    const dx = tx - this.x;
    const dz = tz - this.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) {
      this.vx = this.vz = 0;
      return 0;
    }
    const targetYaw = headingFromDir(dx, dz);
    this.yaw = dampAngle(this.yaw, targetYaw, turnRate, dt);
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const sp = Math.min(speed, d / Math.max(dt, 1e-3));
    this.vx = fx * sp;
    this.vz = fz * sp;
    return d;
  }

  stop(): void {
    this.vx = 0;
    this.vz = 0;
  }

  /**
   * Apply damage. Direction (dx,dz) is the direction the hit travels (for knockback).
   * Returns true if this hit killed the pedestrian.
   */
  applyDamage(amount: number, dx: number, dz: number, byPlayer: boolean, knockback: number, time: number, events?: GameEvent[]): boolean {
    if (this.dead || this.invulnTimer > 0) return false;
    this.health -= amount;
    this.hitFlash = 1;
    if (byPlayer) this.lastHitByPlayer = true;
    events?.push({ type: 'pedHit', x: this.x, y: this.y + 1.2, z: this.z, value: amount, ref: this.id, byPlayer });
    if (this.health <= 0) {
      this.kill(dx, dz, knockback, time, byPlayer, events);
      return true;
    }
    // flinch push
    const len = Math.hypot(dx, dz) || 1;
    this.vx += (dx / len) * knockback * 0.3;
    this.vz += (dz / len) * knockback * 0.3;
    return false;
  }

  kill(dx: number, dz: number, knockback: number, time: number, byPlayer: boolean, events?: GameEvent[]): void {
    if (this.dead) return;
    this.dead = true;
    this.deathTime = time;
    this.health = 0;
    this.setState('dead');
    this.ragdoll = true;
    this.ragdollTimer = 0;
    const len = Math.hypot(dx, dz) || 1;
    this.vx = (dx / len) * knockback;
    this.vz = (dz / len) * knockback;
    this.vy = Math.min(6, 1.5 + knockback * 0.35);
    this.ragdollSpin = (Math.random() - 0.5) * 6;
    this.aiming = false;
    if (this.vehicle) this.vehicle = null;
    events?.push({ type: 'pedKilled', x: this.x, y: this.y + 0.5, z: this.z, ref: this.id, byPlayer: byPlayer || this.lastHitByPlayer });
  }

  /** Integrate motion and resolve static collisions. */
  step(dt: number, world: WorldData, statics: StaticWorld, dynamics: DynamicWorld): void {
    this.age += dt;
    this.stateTimer += dt;
    if (this.hitFlash > 0) this.hitFlash = Math.max(0, this.hitFlash - dt * 4);
    if (this.invulnTimer > 0) this.invulnTimer -= dt;
    if (this.fireCooldown > 0) this.fireCooldown -= dt;
    if (this.punchT >= 0) {
      this.punchT += dt * 3;
      if (this.punchT > 1) this.punchT = -1;
    }
    if (this.state === 'inVehicle' && this.vehicle) {
      this.x = this.vehicle.x;
      this.z = this.vehicle.z;
      this.y = this.vehicle.y;
      this.yaw = this.vehicle.yaw;
      this.vx = this.vz = 0;
      this.syncBounds();
      dynamics.peds.update(this.bounds);
      return;
    }
    const groundY = world.groundHeightAt(this.x, this.z);
    if (this.dead) {
      this.corpseTimer += dt;
      if (this.ragdoll) {
        this.ragdollTimer += dt;
        this.vy -= 20 * dt;
        this.y += this.vy * dt;
        if (this.y <= groundY) {
          this.y = groundY;
          if (this.vy < -2) this.vy = -this.vy * 0.25;
          else this.vy = 0;
          // ground friction
          const f = Math.exp(-4 * dt);
          this.vx *= f;
          this.vz *= f;
          this.ragdollSpin *= f;
        }
        this.x += this.vx * dt;
        this.z += this.vz * dt;
        this.yaw += this.ragdollSpin * dt;
        if (this.ragdollTimer > 2.5 || (Math.abs(this.vx) + Math.abs(this.vz) < 0.05 && this.y <= groundY + 0.001)) {
          this.ragdoll = false;
          this.vx = this.vz = 0;
        }
        this.resolveStatics(statics);
      }
      this.moveSpeed01 = 0;
      this.syncBounds();
      dynamics.peds.update(this.bounds);
      return;
    }
    // Alive: horizontal motion
    const speed = Math.hypot(this.vx, this.vz);
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    // knock-up (from explosions/cars) while alive
    if (this.vy !== 0 || this.y > groundY + 0.01) {
      this.vy -= 20 * dt;
      this.y += this.vy * dt;
      if (this.y <= groundY) {
        this.y = groundY;
        this.vy = 0;
      }
    } else {
      this.y += (groundY - this.y) * Math.min(1, 12 * dt);
    }
    // Residual knockback decays
    const decay = Math.exp(-6 * dt);
    if (this.state === 'idle' || this.state === 'cower' || this.state === 'attack') {
      this.vx *= decay;
      this.vz *= decay;
    }
    this.walkPhase += speed * dt * 2.2;
    this.moveSpeed01 = clamp(speed / this.runSpeed, 0, 1);
    this.resolveStatics(statics);
    this.syncBounds();
    dynamics.peds.update(this.bounds);
  }

  private resolveStatics(statics: StaticWorld): void {
    const pos = { x: this.x, z: this.z };
    statics.resolveCircle(pos, this.radius, 0.3, 2);
    this.x = pos.x;
    this.z = pos.z;
  }

  /** Push out of a vehicle's box; returns the contact when overlapping. */
  collideVehicle(v: Vehicle): Contact | null {
    const c = circleVsBox(this.x, this.z, this.radius, v.collider, scratch);
    if (!c) return null;
    this.x += c.nx * c.depth;
    this.z += c.nz * c.depth;
    return c;
  }

  distSq(x: number, z: number): number {
    const dx = this.x - x;
    const dz = this.z - z;
    return dx * dx + dz * dz;
  }
}
