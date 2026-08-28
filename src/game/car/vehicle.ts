import * as THREE from 'three';
import { clamp, clamp01, damp, lerp, moveToward, smoothstep, wrapAngle } from '../engine/math';
import type { CarSpec } from '../types';
import type { Terrain } from '../world/terrain';

const GRAVITY = 9.81;
const WHEELBASE = 2.62;
const WHEEL_RADIUS = 0.34;
const FINAL_DRIVE = 3.4;
const GEAR_RATIOS = [3.55, 2.42, 1.82, 1.41, 1.12, 0.92];
const IDLE_RPM = 900;
const MAX_RPM = 7400;
const SHIFT_UP_RPM = 6750;
const SHIFT_DOWN_RPM = 2750;

export interface SurfaceProps {
  gripScale: number;
  dragScale: number;
}

const TARMAC: SurfaceProps = { gripScale: 1, dragScale: 1 };
const OFFROAD: SurfaceProps = { gripScale: 0.6, dragScale: 2.6 };

/**
 * Arcade car model.
 *
 * The car is a single rigid body in the horizontal plane. Steering sets a
 * *target* yaw rate from the kinematic bicycle relation; the actual yaw rate
 * chases it, and is allowed to overshoot when the handbrake or throttle breaks
 * the rear loose. Lateral velocity builds up from yaw and is scrubbed off by a
 * grip-limited friction impulse, so a slide begins exactly when the corner asks
 * for more grip than the tyres have. Counter-steering falls out of the same
 * equations rather than being special-cased.
 *
 * Vertical motion is separate and simple: the car rides the heightfield, takes
 * the terrain's vertical velocity with it over a crest, and falls under gravity
 * until it lands.
 */
export class Vehicle {
  readonly position = new THREE.Vector3();
  yaw = 0;

  /** Body-frame velocity: forward and rightward, m/s. */
  forwardSpeed = 0;
  lateralSpeed = 0;
  verticalSpeed = 0;
  yawRate = 0;

  grounded = true;
  airTime = 0;
  offRoad = false;
  /** Set by the game while nitro is burning; read by camera, FX and audio. */
  boosting = false;

  gear = 1;
  rpm = IDLE_RPM;
  wheelSpin = 0;
  steerAngle = 0;

  /** Visual body attitude, damped toward the ground slope. */
  pitch = 0;
  roll = 0;
  bodyPitch = 0;
  bodyRoll = 0;

  // Previous fixed-step state, for render interpolation.
  readonly prevPosition = new THREE.Vector3();
  prevYaw = 0;

  private spec: CarSpec;
  private terrain: Terrain;
  private surface: SurfaceProps = TARMAC;
  private shiftCooldown = 0;
  private stuckTimer = 0;

  private readonly scratchNormal = new THREE.Vector3();

  constructor(spec: CarSpec, terrain: Terrain) {
    this.spec = spec;
    this.terrain = terrain;
  }

  setSpec(spec: CarSpec): void {
    this.spec = spec;
  }

  get speed(): number {
    return Math.hypot(this.forwardSpeed, this.lateralSpeed);
  }

  get speedKmh(): number {
    return this.speed * 3.6;
  }

  /** Angle between where the car points and where it is actually going. */
  get slipAngle(): number {
    if (Math.abs(this.forwardSpeed) < 0.6) return 0;
    return Math.atan2(this.lateralSpeed, Math.abs(this.forwardSpeed));
  }

  get isDrifting(): boolean {
    return this.speed > 9 && Math.abs(this.slipAngle) > 0.16;
  }

  get rpm01(): number {
    return clamp01((this.rpm - IDLE_RPM) / (MAX_RPM - IDLE_RPM));
  }

  placeAt(x: number, z: number, yaw: number): void {
    this.position.set(x, this.terrain.heightAt(x, z), z);
    this.prevPosition.copy(this.position);
    this.yaw = yaw;
    this.prevYaw = yaw;
    this.forwardSpeed = 0;
    this.lateralSpeed = 0;
    this.verticalSpeed = 0;
    this.yawRate = 0;
    this.gear = 1;
    this.rpm = IDLE_RPM;
    this.stuckTimer = 0;
    this.grounded = true;
  }

  setOffRoad(off: boolean): void {
    this.offRoad = off;
    this.surface = off ? OFFROAD : TARMAC;
  }

  update(
    dt: number,
    steerInput: number,
    throttleInput: number,
    brakeInput: number,
    handbrake: boolean,
    parked = false,
  ): void {
    this.prevPosition.copy(this.position);
    this.prevYaw = this.yaw;

    if (parked) {
      this.holdStill(dt, throttleInput);
      return;
    }

    const spec = this.spec;
    const speed = this.speed;
    const u = this.forwardSpeed;

    // --- Steering ---------------------------------------------------------
    // Full lock at a crawl, a narrow band at speed. Without this the car is
    // undriveable above 150 km/h on a touchscreen.
    const lockLimit = lerp(0.60, 0.105, smoothstep(0, 62, Math.abs(u)));
    this.steerAngle = damp(this.steerAngle, steerInput * lockLimit, 14, dt);
    const delta = this.steerAngle;

    // --- Throttle, brake, reverse ----------------------------------------
    let throttle = throttleInput;
    let brake = brakeInput;
    let reversing = false;
    if (brakeInput > 0.05 && u < 0.8) {
      // Holding the brake at a standstill backs up.
      reversing = true;
      throttle = brakeInput;
      brake = 0;
    }

    const boost = this.boosting ? 1.2 : 1;
    const topSpeed = spec.topSpeed * (this.offRoad ? 0.6 : 1) * boost;
    const speedFrac = clamp01(Math.abs(u) / topSpeed);
    // Force tapers off as the car approaches its top speed, which gives the
    // long, flattening pull that fast cars have.
    const powerFactor = Math.max(0, 1 - Math.pow(speedFrac, 1.7));
    let force = 0;
    if (this.grounded) {
      if (reversing) {
        force = -throttle * spec.power * 0.42;
      } else {
        force = throttle * spec.power * powerFactor * (this.boosting ? 1.45 : 1);
      }
      force -= brake * 26000 * Math.sign(u || 1) * Math.min(1, Math.abs(u) / 1.5);
    }

    // Resistance: quadratic aero plus linear rolling drag, both worse off-road.
    const drag = 0.55 * this.surface.dragScale;
    const rolling = 5.2 * this.surface.dragScale;
    force -= drag * u * Math.abs(u);
    force -= rolling * u;

    // Gravity along the slope: hills genuinely cost and give back speed. Only
    // while the wheels are down — in the air the ground below is irrelevant.
    const grade = this.gradeAhead();
    if (this.grounded) {
      force -= Math.sin(Math.atan(grade)) * spec.mass * GRAVITY;
    }

    this.forwardSpeed += (force / spec.mass) * dt;
    if (!reversing && Math.abs(this.forwardSpeed) < 0.05 && throttle < 0.02) {
      this.forwardSpeed = 0;
    }

    // --- Yaw --------------------------------------------------------------
    const kinematicYaw = (this.forwardSpeed * Math.tan(delta)) / WHEELBASE;

    // How far past the "on rails" line the rear is allowed to swing.
    let driftGain = 1;
    if (handbrake) driftGain += 0.95 * spec.looseness;
    driftGain += throttle * 0.3 * spec.looseness * smoothstep(7, 30, Math.abs(u));

    // Stabilisation: nudge the yaw toward killing the slip angle. This is the
    // assist that makes two-button steering forgiving; a real counter-steer
    // from the player simply adds to it.
    const beta = this.slipAngle;
    const assist = handbrake ? 0.45 : 1;
    const stabilise = beta * 1.55 * assist;

    const target = this.grounded ? kinematicYaw * driftGain + stabilise : this.yawRate;
    const response = handbrake ? 3.6 : 7.2;
    this.yawRate = damp(this.yawRate, target, response, dt);
    this.yaw = wrapAngle(this.yaw + this.yawRate * dt);

    // --- Lateral grip -----------------------------------------------------
    // Rotating the body re-expresses the same world velocity in the new frame.
    // That is a pure rotation of (forward, lateral): doing only the sideways
    // half of it would manufacture speed out of nothing, which is exactly what
    // an airborne car with any yaw rate would then do.
    const spin = this.yawRate * dt;
    const spinCos = Math.cos(spin);
    const spinSin = Math.sin(spin);
    const u0 = this.forwardSpeed;
    const w0 = this.lateralSpeed;
    this.forwardSpeed = u0 * spinCos + w0 * spinSin;
    this.lateralSpeed = w0 * spinCos - u0 * spinSin;

    if (this.grounded) {
      // ...and the tyres scrub that off, but only as fast as grip allows.
      let gripAccel = 13.6 * spec.grip * this.surface.gripScale;
      if (handbrake) gripAccel *= 0.4;
      // Weight comes off the tyres over a crest and piles on when landing.
      gripAccel *= clamp(1 - this.airTime * 2, 0.35, 1);
      this.lateralSpeed = moveToward(this.lateralSpeed, 0, gripAccel * dt);
    }

    // A hard ceiling, well above anything the model should reach, so a bad
    // interaction can never turn into a car that has left the planet.
    const ceiling = spec.topSpeed * 1.35 * boost;
    const totalSpeed = Math.hypot(this.forwardSpeed, this.lateralSpeed);
    if (totalSpeed > ceiling) {
      const k = ceiling / totalSpeed;
      this.forwardSpeed *= k;
      this.lateralSpeed *= k;
    }

    // --- Integrate horizontally -------------------------------------------
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const vx = this.forwardSpeed * sin + this.lateralSpeed * cos;
    const vz = this.forwardSpeed * cos - this.lateralSpeed * sin;
    this.position.x += vx * dt;
    this.position.z += vz * dt;

    // --- Vertical ---------------------------------------------------------
    const ground = this.terrain.heightAt(this.position.x, this.position.z);
    if (this.grounded) {
      // Riding the surface: inherit the slope's vertical rate so cresting a
      // rise actually launches the car instead of gluing it to the ground.
      this.verticalSpeed = this.forwardSpeed * grade;
      this.position.y = ground;
      if (this.verticalSpeed > 1.6 && Math.abs(this.forwardSpeed) > 12) {
        this.grounded = false;
      }
    } else {
      this.verticalSpeed -= GRAVITY * dt;
      this.position.y += this.verticalSpeed * dt;
      this.airTime += dt;
      if (this.position.y <= ground) {
        this.position.y = ground;
        // Landing scrubs a little speed and settles the body.
        this.forwardSpeed *= 1 - clamp01(this.airTime * 0.06);
        this.verticalSpeed = 0;
        this.grounded = true;
        this.airTime = 0;
      }
    }
    if (this.grounded) this.airTime = Math.max(0, this.airTime - dt * 4);

    // --- Attitude ---------------------------------------------------------
    this.terrain.normalAt(this.position.x, this.position.z, this.scratchNormal);
    const n = this.scratchNormal;
    const slopePitch = Math.asin(clamp(-(n.x * sin + n.z * cos), -1, 1));
    const slopeRoll = Math.asin(clamp(-(n.x * cos - n.z * sin), -1, 1));
    // Squat under power, dive under braking, lean into the slide.
    const loadPitch = (brake * 0.05 - throttle * 0.035) * clamp01(speed / 20);
    const loadRoll = clamp(this.yawRate * this.forwardSpeed * 0.006, -0.09, 0.09);
    this.pitch = damp(this.pitch, this.grounded ? slopePitch + loadPitch : 0, 6, dt);
    this.roll = damp(this.roll, this.grounded ? slopeRoll + loadRoll : 0, 6, dt);
    this.bodyPitch = this.pitch;
    this.bodyRoll = this.roll;

    // --- Drivetrain readouts ---------------------------------------------
    this.updateGearbox(dt, throttle);
    this.wheelSpin += (this.forwardSpeed / WHEEL_RADIUS) * dt;

    // --- Stuck detection --------------------------------------------------
    if (speed < 1.2 && (throttle > 0.4 || brake > 0.4)) this.stuckTimer += dt;
    else this.stuckTimer = Math.max(0, this.stuckTimer - dt * 2);
  }

  get isStuck(): boolean {
    return this.stuckTimer > 3.5;
  }

  clearStuck(): void {
    this.stuckTimer = 0;
  }

  /**
   * Held on the line during the countdown: no motion, but the engine still
   * revs and the car still settles onto the camber.
   */
  private holdStill(dt: number, throttle: number): void {
    this.forwardSpeed = 0;
    this.lateralSpeed = 0;
    this.yawRate = 0;
    this.verticalSpeed = 0;
    this.grounded = true;
    this.airTime = 0;
    this.steerAngle = damp(this.steerAngle, 0, 8, dt);
    this.position.y = this.terrain.heightAt(this.position.x, this.position.z);

    this.terrain.normalAt(this.position.x, this.position.z, this.scratchNormal);
    const n = this.scratchNormal;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    this.pitch = damp(this.pitch, Math.asin(clamp(-(n.x * sin + n.z * cos), -1, 1)), 6, dt);
    this.roll = damp(this.roll, Math.asin(clamp(-(n.x * cos - n.z * sin), -1, 1)), 6, dt);
    this.bodyPitch = this.pitch;
    this.bodyRoll = this.roll;

    // Blipping the throttle on the line is half the fun of a standing start.
    this.gear = 1;
    this.rpm = damp(this.rpm, 900 + throttle * 5200, 9, dt);
  }

  private updateGearbox(dt: number, throttle: number): void {
    this.shiftCooldown = Math.max(0, this.shiftCooldown - dt);
    const wheelRps = Math.abs(this.forwardSpeed) / (WHEEL_RADIUS * Math.PI * 2);
    const targetRpm =
      wheelRps * GEAR_RATIOS[this.gear - 1] * FINAL_DRIVE * 60;

    if (this.shiftCooldown === 0) {
      if (targetRpm > SHIFT_UP_RPM && this.gear < GEAR_RATIOS.length) {
        this.gear++;
        this.shiftCooldown = 0.32;
      } else if (targetRpm < SHIFT_DOWN_RPM && this.gear > 1) {
        this.gear--;
        this.shiftCooldown = 0.32;
      }
    }

    const idle = IDLE_RPM + throttle * 1400;
    const wanted = Math.max(idle, Math.min(MAX_RPM, targetRpm));
    // A short dip on the shift, so the audio and the tacho have a beat to them.
    const shifting = this.shiftCooldown > 0.18;
    this.rpm = damp(this.rpm, shifting ? wanted * 0.72 : wanted, 12, dt);
  }

  /** Slope in the direction of travel: rise over run, sampled a few metres out. */
  private gradeAhead(): number {
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const d = 2.6;
    const ahead = this.terrain.heightAt(
      this.position.x + sin * d,
      this.position.z + cos * d,
    );
    const behind = this.terrain.heightAt(
      this.position.x - sin * d,
      this.position.z - cos * d,
    );
    return clamp((ahead - behind) / (d * 2), -0.6, 0.6);
  }

  /**
   * Hard contact with a fixed obstacle whose surface normal (pointing at the
   * car) is (nx, nz). Removes the velocity component driving into it, scrubs a
   * little more for the crunch, and reports the impact speed for FX/audio.
   */
  collideNormal(nx: number, nz: number): number {
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    let vx = this.forwardSpeed * sin + this.lateralSpeed * cos;
    let vz = this.forwardSpeed * cos - this.lateralSpeed * sin;
    const into = vx * nx + vz * nz;
    if (into >= 0) return 0;
    vx -= nx * into;
    vz -= nz * into;
    vx *= 0.93;
    vz *= 0.93;
    this.forwardSpeed = vx * sin + vz * cos;
    this.lateralSpeed = vx * cos - vz * sin;
    // Glancing a tree also knocks the nose around a touch.
    this.yawRate += (nx * cos - nz * sin) * Math.min(-into, 8) * 0.05;
    return -into;
  }

  /** Extra rolling drag from ploughing through something soft. */
  applySoftDrag(dt: number, strength: number): void {
    const decay = Math.exp(-strength * dt);
    this.forwardSpeed *= decay;
    this.lateralSpeed *= decay;
  }

  /** Nudge used to separate cars that overlap. */
  applyPush(dx: number, dz: number): void {
    this.position.x += dx;
    this.position.z += dz;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    this.lateralSpeed += (dx * cos - dz * sin) * 4;
    this.forwardSpeed += (dx * sin + dz * cos) * 2;
  }

  /** Interpolated render transform between the last two fixed steps. */
  getRenderTransform(alpha: number, outPos: THREE.Vector3): number {
    outPos.lerpVectors(this.prevPosition, this.position, alpha);
    return this.prevYaw + wrapAngle(this.yaw - this.prevYaw) * alpha;
  }
}
