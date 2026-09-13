/**
 * Player state + on-foot controller (movement, jumping, health/armor/money, weapon inventory,
 * vehicle enter/exit). Camera-relative movement; the camera controller supplies its yaw.
 */
import { circleVsBox, type Contact } from '../core/collision';
import { clamp, dampAngle, headingFromDir, wrapAngle } from '../core/mathUtils';
import {
  PLAYER_ACCEL,
  PLAYER_AIM_SPEED,
  PLAYER_JUMP_SPEED,
  PLAYER_MAX_ARMOR,
  PLAYER_MAX_HEALTH,
  PLAYER_RADIUS,
  PLAYER_REGEN_DELAY,
  PLAYER_REGEN_RATE,
  PLAYER_RUN_SPEED,
  PLAYER_WALK_SPEED,
  GRAVITY,
  START_MONEY,
} from '../core/constants';
import type { InputState } from '../core/input';
import { WEAPON_ORDER, WEAPON_SPECS, type GameEvent, type WeaponId, type WorldData } from '../core/types';
import type { StaticWorld } from '../physics/staticWorld';
import type { DynamicWorld } from '../physics/dynamicWorld';
import type { Vehicle } from './vehicle';

export interface WeaponSlot {
  clip: number;
  reserve: number;
}

export interface PlayerStats {
  kills: number;
  vehiclesStolen: number;
  missionsDone: number;
  distance: number;
  maxWanted: number;
  deaths: number;
  moneyEarned: number;
}

const scratch: Contact = { nx: 0, nz: 0, depth: 0 };

export class Player {
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;
  vx = 0;
  vz = 0;
  vy = 0;
  onGround = true;
  readonly radius = PLAYER_RADIUS;
  health = PLAYER_MAX_HEALTH;
  armor = 0;
  money = START_MONEY;
  godMode = false;
  vehicle: Vehicle | null = null;
  /** Vehicle being entered (short animation). */
  entering: { vehicle: Vehicle; timer: number } | null = null;
  exitingTimer = 0;
  weapons: Partial<Record<WeaponId, WeaponSlot>> = { fist: { clip: 0, reserve: 0 } };
  currentWeapon: WeaponId = 'fist';
  fireCooldown = 0;
  reloading = false;
  reloadTimer = 0;
  aiming = false;
  walkPhase = 0;
  moveSpeed01 = 0;
  punchT = -1;
  hitFlash = 0;
  dead = false;
  deathTimer = 0;
  deathCause = '';
  lastDamageTime = -100;
  inWater = false;
  sprinting = false;
  stats: PlayerStats = { kills: 0, vehiclesStolen: 0, missionsDone: 0, distance: 0, maxWanted: 0, deaths: 0, moneyEarned: 0 };
  /** Seconds since the last footstep sound (for audio). */
  footstepTimer = 0;
  footstepEvent = false;
  jumpEvent = false;
  landEvent = false;

  get forwardX(): number {
    return Math.sin(this.yaw);
  }
  get forwardZ(): number {
    return Math.cos(this.yaw);
  }
  get inVehicle(): boolean {
    return this.vehicle !== null;
  }
  get weaponSpec() {
    return WEAPON_SPECS[this.currentWeapon];
  }
  get currentSlot(): WeaponSlot {
    return this.weapons[this.currentWeapon] ?? { clip: 0, reserve: 0 };
  }

  setPosition(x: number, z: number, yaw = this.yaw, y = 0): void {
    this.x = x;
    this.z = z;
    this.y = y;
    this.yaw = yaw;
    this.vx = this.vz = this.vy = 0;
  }

  respawn(x: number, z: number, yaw: number): void {
    this.setPosition(x, z, yaw);
    this.health = PLAYER_MAX_HEALTH;
    this.armor = 0;
    this.dead = false;
    this.deathTimer = 0;
    this.vehicle = null;
    this.entering = null;
    this.aiming = false;
    this.reloading = false;
    this.fireCooldown = 0;
    this.lastDamageTime = -100;
  }

  // ------------------------------------------------------------------ update
  update(dt: number, input: InputState, camYaw: number, world: WorldData, statics: StaticWorld, dynamics: DynamicWorld, time: number, events: GameEvent[]): void {
    this.footstepEvent = false;
    this.jumpEvent = false;
    this.landEvent = false;
    if (this.hitFlash > 0) this.hitFlash = Math.max(0, this.hitFlash - dt * 3);
    if (this.fireCooldown > 0) this.fireCooldown -= dt;
    if (this.punchT >= 0) {
      this.punchT += dt * 3.2;
      if (this.punchT > 1) this.punchT = -1;
    }
    if (this.reloading) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) this.finishReload();
    }
    if (this.dead) {
      this.deathTimer += dt;
      this.vx *= 0.9;
      this.vz *= 0.9;
      return;
    }
    // Health regen up to 50%
    if (time - this.lastDamageTime > PLAYER_REGEN_DELAY && this.health < PLAYER_MAX_HEALTH * 0.5) {
      this.health = Math.min(PLAYER_MAX_HEALTH * 0.5, this.health + PLAYER_REGEN_RATE * dt);
    }

    // Entering animation
    if (this.entering) {
      const e = this.entering;
      e.timer -= dt;
      // slide toward the door
      const door = e.vehicle.exitPositions()[0];
      this.x += (door.x - this.x) * Math.min(1, 10 * dt);
      this.z += (door.z - this.z) * Math.min(1, 10 * dt);
      this.yaw = dampAngle(this.yaw, e.vehicle.yaw, 8, dt);
      if (e.timer <= 0) {
        this.vehicle = e.vehicle;
        this.vehicle.playerDriving = true;
        this.vehicle.role = 'player';
        this.vehicle.persistent = true;
        this.vehicle.sleeping = false;
        this.entering = null;
        this.aiming = false;
        events.push({ type: 'vehicleEntered', x: this.x, y: this.y, z: this.z, ref: this.vehicle.id, byPlayer: true });
      }
      return;
    }

    if (this.vehicle) {
      this.updateInVehicle(dt, input);
      return;
    }
    this.updateOnFoot(dt, input, camYaw, world, statics, dynamics, time, events);
  }

  private updateInVehicle(dt: number, input: InputState): void {
    const v = this.vehicle!;
    const c = v.controls;
    if (v.destroyed) {
      c.throttle = 0;
      c.brake = 1;
    } else {
      c.throttle = input.forward ? 1 : input.back ? -1 : 0;
      c.brake = 0;
      c.steer = (input.right ? 1 : 0) - (input.left ? 1 : 0);
      c.handbrake = input.handbrake;
      c.horn = input.horn;
    }
    const seat = { x: 0, y: 0, z: 0 };
    v.seatPosition(seat);
    this.x = seat.x;
    this.z = seat.z;
    this.y = v.y;
    this.yaw = v.yaw;
    this.vx = v.vx;
    this.vz = v.vz;
    this.moveSpeed01 = 0;
    this.stats.distance += Math.abs(v.speed) * dt;
    void dt;
  }

  private updateOnFoot(dt: number, input: InputState, camYaw: number, world: WorldData, statics: StaticWorld, dynamics: DynamicWorld, time: number, events: GameEvent[]): void {
    // Desired movement in camera space
    const fX = Math.sin(camYaw);
    const fZ = Math.cos(camYaw);
    const rX = -Math.cos(camYaw);
    const rZ = Math.sin(camYaw);
    let mx = fX * ((input.forward ? 1 : 0) - (input.back ? 1 : 0)) + rX * ((input.right ? 1 : 0) - (input.left ? 1 : 0));
    let mz = fZ * ((input.forward ? 1 : 0) - (input.back ? 1 : 0)) + rZ * ((input.right ? 1 : 0) - (input.left ? 1 : 0));
    const mlen = Math.hypot(mx, mz);
    if (mlen > 1e-6) {
      mx /= mlen;
      mz /= mlen;
    }
    this.aiming = input.aim && this.currentWeapon !== 'fist' && this.currentWeapon !== 'bat';
    this.sprinting = input.sprint && !this.aiming && mlen > 0;
    const targetSpeed = mlen > 0 ? (this.aiming ? PLAYER_AIM_SPEED : this.sprinting ? PLAYER_RUN_SPEED : PLAYER_WALK_SPEED) : 0;
    const waterSlow = this.inWater ? 0.45 : 1;
    const tvx = mx * targetSpeed * waterSlow;
    const tvz = mz * targetSpeed * waterSlow;
    const accel = this.onGround ? PLAYER_ACCEL : PLAYER_ACCEL * 0.35;
    const k = Math.min(1, accel * dt / Math.max(0.1, targetSpeed || PLAYER_WALK_SPEED));
    this.vx += (tvx - this.vx) * k;
    this.vz += (tvz - this.vz) * k;

    // Facing
    if (this.aiming) this.yaw = dampAngle(this.yaw, camYaw, 18, dt);
    else if (mlen > 0) this.yaw = dampAngle(this.yaw, headingFromDir(mx, mz), 12, dt);

    // Jump / gravity
    const groundY = world.groundHeightAt(this.x, this.z);
    if (input.jump && this.onGround && !this.inWater) {
      this.vy = PLAYER_JUMP_SPEED;
      this.onGround = false;
      this.jumpEvent = true;
    }
    if (!this.onGround || this.y > groundY + 0.02) {
      this.vy -= GRAVITY * dt;
      this.y += this.vy * dt;
      if (this.y <= groundY) {
        this.y = groundY;
        if (!this.onGround) this.landEvent = true;
        this.onGround = true;
        this.vy = 0;
      } else {
        this.onGround = false;
      }
    } else {
      // step onto curbs smoothly
      this.y += (groundY - this.y) * Math.min(1, 14 * dt);
      this.onGround = true;
    }

    // Integrate
    const px = this.x;
    const pz = this.z;
    this.x += this.vx * dt;
    this.z += this.vz * dt;

    // Collide with statics (ignore very low props when airborne)
    const pos = { x: this.x, z: this.z };
    statics.resolveCircle(pos, this.radius, this.onGround ? 0 : this.y - groundY + 0.2, 3);
    this.x = pos.x;
    this.z = pos.z;

    // Collide with vehicles
    const near = dynamics.vehiclesNear(this.x, this.z, 6);
    for (let i = 0; i < near.length; i++) {
      const v = near[i].vehicle;
      const c = circleVsBox(this.x, this.z, this.radius, v.collider, scratch);
      if (!c) continue;
      this.x += c.nx * c.depth;
      this.z += c.nz * c.depth;
      const vs = Math.hypot(v.vx, v.vz);
      // relative closing speed along the normal
      const closing = -(v.vx * c.nx + v.vz * c.nz);
      if (vs > 3 && closing > 2) {
        const dmg = (closing - 1) * 6 * (v.spec.mass / 1400);
        this.takeDamage(dmg, time, 'vehicle', events);
        this.vx += v.vx * 0.9 + c.nx * 2;
        this.vz += v.vz * 0.9 + c.nz * 2;
        this.vy = Math.max(this.vy, 3 + closing * 0.15);
        this.onGround = false;
        events.push({ type: 'impact', x: this.x, y: this.y + 1, z: this.z, value: closing, byPlayer: v.playerDriving });
      }
    }

    // Water
    this.inWater = world.isWaterAt(this.x, this.z);
    if (this.inWater) {
      this.takeDamage(18 * dt, time, 'drowning', events, true);
    }

    // Distance / animation
    const moved = Math.hypot(this.x - px, this.z - pz);
    this.stats.distance += moved;
    const speed = Math.hypot(this.vx, this.vz);
    this.walkPhase += speed * dt * 2.1;
    this.moveSpeed01 = clamp(speed / PLAYER_RUN_SPEED, 0, 1);
    this.footstepTimer += dt;
    const stepInterval = this.sprinting ? 0.3 : 0.48;
    if (speed > 0.8 && this.onGround && this.footstepTimer >= stepInterval) {
      this.footstepTimer = 0;
      this.footstepEvent = true;
    }
  }

  // ------------------------------------------------------------------ damage
  /** Returns true if this damage killed the player. */
  takeDamage(amount: number, time: number, cause: string, events?: GameEvent[], silent = false): boolean {
    if (this.dead || amount <= 0) return false;
    if (this.godMode) return false;
    this.lastDamageTime = time;
    if (!silent) this.hitFlash = 1;
    if (this.armor > 0) {
      const absorbed = Math.min(this.armor, amount * 0.75);
      this.armor -= absorbed;
      amount -= absorbed;
    }
    this.health -= amount;
    events?.push({ type: 'playerDamaged', x: this.x, y: this.y, z: this.z, value: amount });
    if (this.health <= 0) {
      this.health = 0;
      this.dead = true;
      this.deathTimer = 0;
      this.deathCause = cause;
      this.stats.deaths++;
      this.aiming = false;
      this.reloading = false;
      if (this.vehicle) {
        this.vehicle.playerDriving = false;
        this.vehicle.controls.throttle = 0;
        this.vehicle.controls.brake = 1;
      }
      events?.push({ type: 'playerDied', x: this.x, y: this.y, z: this.z, ref: cause });
      return true;
    }
    return false;
  }

  heal(amount: number): void {
    this.health = Math.min(PLAYER_MAX_HEALTH, this.health + amount);
  }

  addArmor(amount: number): void {
    this.armor = Math.min(PLAYER_MAX_ARMOR, this.armor + amount);
  }

  addMoney(amount: number): void {
    this.money += amount;
    if (amount > 0) this.stats.moneyEarned += amount;
  }

  // ------------------------------------------------------------------ weapons
  hasWeapon(id: WeaponId): boolean {
    return !!this.weapons[id];
  }

  giveWeapon(id: WeaponId, ammo?: number): void {
    const spec = WEAPON_SPECS[id];
    const slot = this.weapons[id];
    const give = ammo ?? (spec.clipSize > 0 ? spec.clipSize * 3 : 0);
    if (slot) {
      slot.reserve = Math.min(spec.maxReserve, slot.reserve + give);
    } else {
      const clip = Math.min(spec.clipSize, give);
      this.weapons[id] = { clip, reserve: Math.min(spec.maxReserve, Math.max(0, give - clip)) };
      // auto-equip better weapons when holding fists
      if (this.currentWeapon === 'fist' || (this.currentWeapon === 'bat' && id !== 'fist')) this.selectWeapon(id);
    }
  }

  giveAmmo(id: WeaponId, amount: number): boolean {
    const slot = this.weapons[id];
    if (!slot) return false;
    const spec = WEAPON_SPECS[id];
    if (slot.reserve >= spec.maxReserve) return false;
    slot.reserve = Math.min(spec.maxReserve, slot.reserve + amount);
    return true;
  }

  selectWeapon(id: WeaponId): void {
    if (!this.weapons[id] || id === this.currentWeapon) return;
    this.currentWeapon = id;
    this.reloading = false;
    this.fireCooldown = Math.max(this.fireCooldown, 0.25);
  }

  cycleWeapon(dir: 1 | -1): void {
    const owned = WEAPON_ORDER.filter((w) => this.weapons[w]);
    if (owned.length <= 1) return;
    const i = owned.indexOf(this.currentWeapon);
    const next = owned[(i + dir + owned.length) % owned.length];
    this.selectWeapon(next);
  }

  selectSlot(slot: number): void {
    const candidates = WEAPON_ORDER.filter((w) => this.weapons[w] && WEAPON_SPECS[w].slot === slot);
    if (!candidates.length) return;
    const i = candidates.indexOf(this.currentWeapon);
    this.selectWeapon(candidates[(i + 1) % candidates.length]);
  }

  /** True when the trigger can fire right now (cooldown + ammo). */
  canFire(): boolean {
    if (this.dead || this.reloading || this.fireCooldown > 0) return false;
    const spec = this.weaponSpec;
    if (spec.clipSize === 0) return true;
    return this.currentSlot.clip > 0;
  }

  /** Consume a round; returns false if the clip was empty. */
  consumeShot(): boolean {
    const spec = this.weaponSpec;
    this.fireCooldown = spec.fireInterval;
    if (spec.clipSize === 0) {
      this.punchT = 0;
      return true;
    }
    const slot = this.currentSlot;
    if (slot.clip <= 0) return false;
    slot.clip--;
    if (slot.clip === 0 && slot.reserve > 0) this.startReload();
    return true;
  }

  startReload(): boolean {
    const spec = this.weaponSpec;
    const slot = this.currentSlot;
    if (spec.clipSize === 0 || this.reloading || slot.clip >= spec.clipSize || slot.reserve <= 0) return false;
    this.reloading = true;
    this.reloadTimer = spec.reloadTime;
    return true;
  }

  private finishReload(): void {
    this.reloading = false;
    const spec = this.weaponSpec;
    const slot = this.currentSlot;
    const need = spec.clipSize - slot.clip;
    const take = Math.min(need, slot.reserve);
    slot.clip += take;
    slot.reserve -= take;
  }

  // ------------------------------------------------------------------ vehicles
  beginEnterVehicle(v: Vehicle): void {
    if (this.vehicle || this.entering) return;
    this.entering = { vehicle: v, timer: 0.55 };
    this.aiming = false;
    this.vx = this.vz = 0;
  }

  /** Leave the vehicle at the first free door position. */
  exitVehicle(statics: StaticWorld, events: GameEvent[]): boolean {
    const v = this.vehicle;
    if (!v) return false;
    const spots = v.exitPositions();
    let spot = spots[0];
    for (const s of spots) {
      if (statics.isFree(s.x, s.z, this.radius + 0.1)) {
        spot = s;
        break;
      }
    }
    v.playerDriving = false;
    v.controls.throttle = 0;
    v.controls.steer = 0;
    v.controls.handbrake = Math.abs(v.speed) < 3;
    v.controls.horn = false;
    v.role = 'parked';
    this.vehicle = null;
    this.x = spot.x;
    this.z = spot.z;
    this.y = v.y;
    this.vx = v.vx * 0.5;
    this.vz = v.vz * 0.5;
    this.yaw = wrapAngle(v.yaw);
    this.exitingTimer = 0.4;
    events.push({ type: 'vehicleExited', x: this.x, y: this.y, z: this.z, ref: v.id, byPlayer: true });
    return true;
  }
}
