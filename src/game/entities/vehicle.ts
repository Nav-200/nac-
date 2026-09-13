/**
 * Vehicle simulation: arcade car dynamics (bicycle steering, longitudinal engine/brake
 * model, lateral grip with handbrake drift), OBB collisions against the static world and
 * other vehicles with impulse + angular response, damage, fire and explosion timers.
 *
 * Pure simulation — no three.js here. The render layer syncs a model to this state.
 */
import { boxVsBox, makeBox, refreshBoxBounds, type BoxCollider, type Contact } from '../core/collision';
import { clamp, dampAngle, moveToward, wrapAngle } from '../core/mathUtils';
import { VEHICLE_SPECS, type GameEvent, type VehicleSpec, type VehicleType } from '../core/types';
import type { StaticWorld } from '../physics/staticWorld';
import type { DynamicWorld, VehicleBounds } from '../physics/dynamicWorld';
import type { WorldData } from '../core/types';
import type { Pedestrian } from './pedestrian';

export type VehicleRole = 'parked' | 'traffic' | 'police' | 'mission' | 'player';

export interface VehicleNav {
  edgeId: number;
  lane: number;
  t: number; // 0..1 along the edge
  nextEdgeId: number;
  targetSpeed: number;
  waitTimer: number;
  /** For police / chase AI: target position. */
  goalX: number;
  goalZ: number;
  stuckTimer: number;
  reverseTimer: number;
  lastProgressX: number;
  lastProgressZ: number;
  progressTimer: number;
  /** Debug: why the traffic AI chose its current target speed. */
  reason?: 'cruise' | 'turn' | 'signal' | 'obstacle' | 'reverse';
}

export interface VehicleControls {
  throttle: number; // -1..1 (negative = reverse)
  brake: number; // 0..1
  steer: number; // -1 (left) .. 1 (right)
  handbrake: boolean;
  horn: boolean;
}

let nextVehicleId = 1;

const scratch: Contact = { nx: 0, nz: 0, depth: 0 };
const corners = new Float64Array(8);

export class Vehicle {
  readonly id = nextVehicleId++;
  readonly spec: VehicleSpec;
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;
  vx = 0;
  vz = 0;
  yawRate = 0;
  /** Signed forward speed (m/s), derived each step. */
  speed = 0;
  /** Current steering angle of the front wheels (rad, +right). */
  steerAngle = 0;
  controls: VehicleControls = { throttle: 0, brake: 0, steer: 0, handbrake: false, horn: false };
  health: number;
  destroyed = false;
  /** Seconds burning before explosion (-1 = not burning). */
  burnTimer = -1;
  exploded = false;
  /** Cosmetic body pitch/roll from acceleration. */
  pitch = 0;
  roll = 0;
  wheelSpin = 0;
  /** 0..1 how hard the tyres are sliding (audio/effects). */
  skid = 0;
  headlights = false;
  brakeLights = false;
  reverseLights = false;
  siren = false;
  hornTimer = 0;
  driver: Pedestrian | null = null;
  playerDriving = false;
  role: VehicleRole = 'parked';
  /** Never despawn while true (player used it recently, mission vehicle...). */
  persistent = false;
  colorHex: number;
  readonly collider: VehicleBounds;
  nav: VehicleNav = { edgeId: -1, lane: 0, t: 0, nextEdgeId: -1, targetSpeed: 0, waitTimer: 0, goalX: 0, goalZ: 0, stuckTimer: 0, reverseTimer: 0, lastProgressX: 0, lastProgressZ: 0, progressTimer: 0 };
  /** Who damaged this vehicle last (for wanted heat attribution). */
  lastHitByPlayer = false;
  lastHitTime = -100;
  /** Accumulated impact this step (m/s) for audio. */
  impactThisStep = 0;
  sleeping = false;
  /** Mission tag (e.g. 'target', 'delivery') */
  tag = '';
  /** Age in seconds. */
  age = 0;
  onGrass = false;

  constructor(public readonly type: VehicleType, colorHex: number) {
    this.spec = VEHICLE_SPECS[type];
    this.health = this.spec.health;
    this.colorHex = colorHex;
    const b = makeBox('prop', 0, 0, this.spec.width / 2, this.spec.length / 2, 0, this.spec.height, true) as VehicleBounds;
    b.vehicle = this;
    this.collider = b;
  }

  get maxHealth(): number {
    return this.spec.health;
  }

  get damage01(): number {
    return 1 - clamp(this.health / this.spec.health, 0, 1);
  }

  get forwardX(): number {
    return Math.sin(this.yaw);
  }
  get forwardZ(): number {
    return Math.cos(this.yaw);
  }
  get rightX(): number {
    return -Math.cos(this.yaw);
  }
  get rightZ(): number {
    return Math.sin(this.yaw);
  }

  setPose(x: number, z: number, yaw: number, y = 0): void {
    this.x = x;
    this.z = z;
    this.y = y;
    this.yaw = yaw;
    this.vx = this.vz = this.yawRate = 0;
    this.syncCollider();
  }

  syncCollider(): void {
    const c = this.collider;
    c.cx = this.x;
    c.cz = this.z;
    c.yaw = this.yaw;
    refreshBoxBounds(c);
  }

  /** World-space seat position for the driver (left side, +X local). */
  seatPosition(out: { x: number; y: number; z: number }): void {
    const sx = 0.38; // toward local +X (left)
    const sz = this.spec.length * 0.08;
    out.x = this.x - this.rightX * sx + this.forwardX * sz;
    out.z = this.z - this.rightZ * sx + this.forwardZ * sz;
    out.y = this.y + this.spec.cabinHeight * 0.55;
  }

  /** Candidate exit positions (left, right, back). */
  exitPositions(): { x: number; z: number }[] {
    const off = this.spec.width / 2 + 0.75;
    const left = { x: this.x - this.rightX * off, z: this.z - this.rightZ * off };
    const right = { x: this.x + this.rightX * off, z: this.z + this.rightZ * off };
    const back = { x: this.x - this.forwardX * (this.spec.length / 2 + 0.8), z: this.z - this.forwardZ * (this.spec.length / 2 + 0.8) };
    return [left, right, back];
  }

  applyDamage(amount: number, byPlayer: boolean, time: number): boolean {
    if (this.destroyed) return false;
    this.health -= amount;
    if (byPlayer) this.lastHitByPlayer = true;
    this.lastHitTime = time;
    if (this.health <= this.spec.health * 0.22 && this.burnTimer < 0) this.burnTimer = 6 + Math.random() * 4;
    if (this.health <= 0 && !this.destroyed) {
      this.destroyed = true;
      return true;
    }
    return false;
  }

  /**
   * Integrate one fixed step. Collisions with statics and other vehicles are resolved here.
   * `events` receives impacts / explosions for audio + effects.
   */
  step(dt: number, world: WorldData, statics: StaticWorld, dynamics: DynamicWorld, time: number, events: GameEvent[], onPropHit?: (c: BoxCollider, impact: number) => boolean): void {
    this.age += dt;
    this.impactThisStep = 0;
    const s = this.spec;
    const c = this.controls;
    if (this.destroyed) {
      c.throttle = 0;
      c.brake = 1;
      c.handbrake = true;
    }
    // Burning → explosion
    if (this.burnTimer >= 0 && !this.exploded) {
      this.burnTimer -= dt;
      if (this.burnTimer <= 0) {
        this.explode(time, events);
      }
    }

    const fx = this.forwardX;
    const fz = this.forwardZ;
    const rx = this.rightX;
    const rz = this.rightZ;
    let vf = this.vx * fx + this.vz * fz;
    let vr = this.vx * rx + this.vz * rz;
    const absVf = Math.abs(vf);

    // Sleep when parked and untouched
    const hasInput = Math.abs(c.throttle) > 0.01 || c.brake > 0.01 || Math.abs(c.steer) > 0.01;
    if (!hasInput && absVf < 0.03 && Math.abs(vr) < 0.03 && Math.abs(this.yawRate) < 0.01) {
      this.vx = this.vz = this.yawRate = 0;
      this.speed = 0;
      this.skid = 0;
      this.brakeLights = c.brake > 0.1;
      this.reverseLights = false;
      this.sleeping = true;
      this.pitch = dampAngle(this.pitch, 0, 8, dt);
      this.roll = dampAngle(this.roll, 0, 8, dt);
      this.y = this.groundY(world, dt);
      this.syncCollider();
      return;
    }
    this.sleeping = false;

    // Surface
    this.onGrass = !world.isRoadAt(this.x, this.z) && world.districtAt(this.x, this.z) !== 'downtown' && world.districtAt(this.x, this.z) !== 'midtown' && world.districtAt(this.x, this.z) !== 'airfield';
    const surfaceGrip = this.onGrass ? 0.62 : 1;
    const surfaceAccel = this.onGrass ? 0.7 : 1;

    // --- longitudinal
    const maxRev = s.maxSpeed * 0.35;
    let accel = 0;
    const throttle = clamp(c.throttle, -1, 1);
    if (throttle > 0) {
      const ratio = clamp(vf / s.maxSpeed, 0, 1);
      accel += throttle * s.accel * (1 - ratio * ratio * 0.85) * surfaceAccel;
      if (vf < -0.5) accel += s.brake * 0.8; // braking out of reverse
    } else if (throttle < 0) {
      if (vf > 0.5) accel -= s.brake * -throttle; // brake first
      else accel += throttle * s.accel * 0.6 * clamp(1 - Math.abs(vf) / maxRev, 0, 1) * surfaceAccel; // then reverse
    }
    if (c.brake > 0) {
      if (absVf > 0.3) accel -= Math.sign(vf) * s.brake * c.brake;
      else vf = 0;
    }
    // rolling resistance + aero drag
    const rolling = 0.9 + (this.onGrass ? 2.5 : 0);
    const dragK = s.accel / (s.maxSpeed * s.maxSpeed) * 0.35;
    if (absVf > 0.05) accel -= Math.sign(vf) * (rolling + dragK * vf * vf);
    const handbrake = c.handbrake && !this.destroyed;
    if (handbrake) {
      // Locks the rear wheels: strong decel, lose lateral grip
      if (absVf > 0.3) accel -= Math.sign(vf) * s.brake * 0.55;
      else vf *= 0.5;
    }
    const prevVf = vf;
    vf += accel * dt;
    if (Math.sign(vf) !== Math.sign(prevVf) && Math.abs(accel) > 0 && c.brake > 0) vf = 0; // brake doesn't reverse
    vf = clamp(vf, -maxRev - 1, s.maxSpeed * 1.15);

    // --- lateral grip
    const gripBase = s.grip * surfaceGrip * (handbrake ? 0.28 : 1);
    // less grip at high lateral slip (progressive drift)
    const slip = Math.abs(vr);
    const grip = gripBase * (1 / (1 + slip * 0.08));
    vr *= Math.exp(-grip * dt);
    this.skid = clamp((slip - 1.5) / 6, 0, 1) * clamp(absVf / 6, 0, 1);

    // --- steering (bicycle model)
    const speedFactor = 1 / (1 + absVf / 22);
    const targetSteer = clamp(c.steer, -1, 1) * s.steerMax * speedFactor;
    this.steerAngle = moveToward(this.steerAngle, targetSteer, s.steerRate * dt * (Math.abs(targetSteer) < Math.abs(this.steerAngle) ? 1.6 : 1));
    const wheelbase = s.length * 0.6;
    // yaw increases toward the LEFT in this convention, so a right turn (steer>0) decreases yaw.
    let yawRateTarget = -(vf / wheelbase) * Math.tan(this.steerAngle);
    if (handbrake && absVf > 3) yawRateTarget *= 1.35;
    // Drift adds yaw from lateral slip
    yawRateTarget += -vr * 0.05 * clamp(absVf / 10, 0, 1) * (handbrake ? 1.5 : 0.5);
    this.yawRate = this.yawRate + (yawRateTarget - this.yawRate) * (1 - Math.exp(-9 * dt));
    this.yaw = wrapAngle(this.yaw + this.yawRate * dt);

    // --- recompose velocity with the (new) heading
    const nfx = Math.sin(this.yaw);
    const nfz = Math.cos(this.yaw);
    const nrx = -Math.cos(this.yaw);
    const nrz = Math.sin(this.yaw);
    this.vx = nfx * vf + nrx * vr;
    this.vz = nfz * vf + nrz * vr;
    this.speed = vf;

    // --- integrate
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.y = this.groundY(world, dt);
    this.wheelSpin += (vf / 0.34) * dt;

    // cosmetic pitch/roll
    const longAccel = (vf - prevVf) / dt;
    this.pitch = dampAngle(this.pitch, clamp(-longAccel * 0.004, -0.06, 0.06), 6, dt);
    this.roll = dampAngle(this.roll, clamp(this.yawRate * vf * 0.004, -0.08, 0.08), 6, dt);

    // lights
    this.brakeLights = c.brake > 0.1 || (throttle < 0 && vf > 0.5) || handbrake;
    this.reverseLights = vf < -0.3;
    if (c.horn) this.hornTimer = 0.3;
    else this.hornTimer = Math.max(0, this.hornTimer - dt);

    // --- collisions
    this.syncCollider();
    this.collideStatics(statics, time, events, onPropHit);
    this.collideVehicles(dynamics, time, events);
    this.syncCollider();
    dynamics.vehicles.update(this.collider);

    // World bounds safety
    if (world.isWaterAt(this.x, this.z)) {
      // sink: heavy drag, engine dies
      this.vx *= 0.9;
      this.vz *= 0.9;
      if (!this.destroyed) this.applyDamage(80 * dt, false, time);
    }
  }

  private groundY(world: WorldData, dt: number): number {
    const target = world.groundHeightAt(this.x, this.z);
    const diff = target - this.y;
    if (Math.abs(diff) < 0.001) return target;
    // step up curbs quickly, drop gently
    const rate = diff > 0 ? 14 : 8;
    return this.y + diff * Math.min(1, rate * dt);
  }

  private collideStatics(statics: StaticWorld, time: number, events: GameEvent[], onPropHit?: (c: BoxCollider, impact: number) => boolean): void {
    statics.resolveBox(this.collider, (other, contact) => {
      // relative velocity along the normal (normal points from obstacle toward us)
      const vn = -(this.vx * contact.nx + this.vz * contact.nz); // >0 when moving into the obstacle
      const impact = Math.max(0, vn);
      // breakable prop? let the game decide (returns true when the prop gave way)
      if (onPropHit && other.kind !== 'building' && other.kind !== 'wall' && onPropHit(other, impact)) {
        // undo the push for this contact so the car ploughs through
        this.collider.cx -= contact.nx * contact.depth;
        this.collider.cz -= contact.nz * contact.depth;
        this.collider.minX -= contact.nx * contact.depth;
        this.collider.maxX -= contact.nx * contact.depth;
        this.collider.minZ -= contact.nz * contact.depth;
        this.collider.maxZ -= contact.nz * contact.depth;
        this.vx *= 0.92;
        this.vz *= 0.92;
        return;
      }
      if (vn > 0) {
        const restitution = 0.18;
        this.vx += contact.nx * vn * (1 + restitution);
        this.vz += contact.nz * vn * (1 + restitution);
        // tangential friction scrub
        const tx = -contact.nz;
        const tz = contact.nx;
        const vt = this.vx * tx + this.vz * tz;
        this.vx -= tx * vt * 0.25;
        this.vz -= tz * vt * 0.25;
        // angular response from the most penetrating corner
        this.applyAngularKick(contact, vn);
        if (impact > 2.5) {
          const dmg = (impact - 2.5) * (this.spec.mass / 1400) * 3.2;
          this.applyDamage(dmg, this.playerDriving, time);
          this.impactThisStep = Math.max(this.impactThisStep, impact);
          events.push({ type: 'impact', x: this.x, y: this.y + 0.6, z: this.z, value: impact, ref: this.id, byPlayer: this.playerDriving });
        }
      }
    });
    this.x = this.collider.cx;
    this.z = this.collider.cz;
  }

  private applyAngularKick(contact: Contact, vn: number): void {
    // Find the corner deepest along -n
    const c = this.collider;
    const ax = c.c * c.hx;
    const az = c.s * c.hx;
    const bx = -c.s * c.hz;
    const bz = c.c * c.hz;
    corners[0] = ax + bx;
    corners[1] = az + bz;
    corners[2] = -ax + bx;
    corners[3] = -az + bz;
    corners[4] = -ax - bx;
    corners[5] = -az - bz;
    corners[6] = ax - bx;
    corners[7] = az - bz;
    let best = -Infinity;
    let rxp = 0;
    let rzp = 0;
    for (let i = 0; i < 4; i++) {
      const d = -(corners[i * 2] * contact.nx + corners[i * 2 + 1] * contact.nz);
      if (d > best) {
        best = d;
        rxp = corners[i * 2];
        rzp = corners[i * 2 + 1];
      }
    }
    // torque = r × impulse (2D cross), impulse along +n
    const cross = rxp * contact.nz - rzp * contact.nx;
    const inertia = (this.spec.length * this.spec.length + this.spec.width * this.spec.width) / 12;
    // yaw increases to the left; positive cross means the corner is to the right of the push → spin right (negative yaw)
    this.yawRate += (-cross * vn * 0.35) / Math.max(1, inertia);
    this.yawRate = clamp(this.yawRate, -4, 4);
  }

  private collideVehicles(dynamics: DynamicWorld, time: number, events: GameEvent[]): void {
    const c = this.collider;
    const near = dynamics.vehiclesInRect(c.minX - 0.5, c.minZ - 0.5, c.maxX + 0.5, c.maxZ + 0.5);
    for (let i = 0; i < near.length; i++) {
      const ob = near[i];
      const other = ob.vehicle;
      if (other === this) continue;
      const hit = boxVsBox(c, ob, scratch);
      if (!hit) continue;
      const mA = this.spec.mass;
      const mB = other.spec.mass;
      const total = mA + mB;
      const shareA = other.sleeping && !this.sleeping ? 0.35 : mB / total;
      const shareB = 1 - shareA;
      // separate
      this.x += hit.nx * hit.depth * shareA;
      this.z += hit.nz * hit.depth * shareA;
      other.x -= hit.nx * hit.depth * shareB;
      other.z -= hit.nz * hit.depth * shareB;
      // relative velocity along the normal (n points from other toward this)
      const rvx = this.vx - other.vx;
      const rvz = this.vz - other.vz;
      const vn = rvx * hit.nx + rvz * hit.nz; // negative when approaching
      if (vn < 0) {
        const e = 0.25;
        const j = (-(1 + e) * vn) / (1 / mA + 1 / mB);
        this.vx += (j / mA) * hit.nx;
        this.vz += (j / mA) * hit.nz;
        other.vx -= (j / mB) * hit.nx;
        other.vz -= (j / mB) * hit.nz;
        other.sleeping = false;
        const impact = -vn;
        // spin both a little
        this.applyAngularKick(hit, impact * 0.6 * (mB / total));
        const flipped: Contact = { nx: -hit.nx, nz: -hit.nz, depth: hit.depth };
        other.applyAngularKick(flipped, impact * 0.6 * (mA / total));
        if (impact > 2) {
          const dmgA = (impact - 1.5) * (mB / 1400) * 3.2;
          const dmgB = (impact - 1.5) * (mA / 1400) * 3.2;
          this.applyDamage(dmgA, other.playerDriving, time);
          other.applyDamage(dmgB, this.playerDriving, time);
          this.impactThisStep = Math.max(this.impactThisStep, impact);
          other.impactThisStep = Math.max(other.impactThisStep, impact);
          events.push({ type: 'impact', x: (this.x + other.x) / 2, y: this.y + 0.6, z: (this.z + other.z) / 2, value: impact, ref: this.id, byPlayer: this.playerDriving || other.playerDriving });
        }
      }
      this.syncCollider();
      other.syncCollider();
      dynamics.vehicles.update(ob);
    }
  }

  explode(time: number, events: GameEvent[]): void {
    if (this.exploded) return;
    this.exploded = true;
    this.destroyed = true;
    this.burnTimer = -1;
    this.health = 0;
    // hop
    events.push({ type: 'explosion', x: this.x, y: this.y + 0.8, z: this.z, value: 7, ref: this.id, byPlayer: this.lastHitByPlayer });
    events.push({ type: 'vehicleDestroyed', x: this.x, y: this.y, z: this.z, ref: this.id, byPlayer: this.lastHitByPlayer });
    void time;
  }

  /** Apply an outward impulse (explosions). */
  applyImpulse(ix: number, iz: number, spin = 0): void {
    this.vx += ix / (this.spec.mass / 1000);
    this.vz += iz / (this.spec.mass / 1000);
    this.yawRate += spin;
    this.sleeping = false;
  }

  /** Distance-squared from a point to the vehicle centre. */
  distSq(x: number, z: number): number {
    const dx = this.x - x;
    const dz = this.z - z;
    return dx * dx + dz * dz;
  }
}
