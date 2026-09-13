/**
 * Shared hostile-NPC behaviour (cops, gang members, hit targets): approach the player, keep
 * line of sight, shoot in bursts or melee, strafe a little. Used by police + missions.
 */
import { WEAPON_SPECS, type GameEvent } from '../core/types';
import type { Pedestrian } from '../entities/pedestrian';
import type { Player } from '../entities/player';
import type { StaticWorld } from '../physics/staticWorld';
import type { CombatSystem } from './combat';
import { wrapAngle } from '../core/mathUtils';

export interface HostileOptions {
  /** Preferred engagement distance (m). */
  range: number;
  /** Damage multiplier for NPC shots (applied through spread only; damage is in weapon spec). */
  accuracy: number; // 0..1, higher = tighter
  /** Seconds between bursts. */
  burstInterval: number;
  burstLength: number;
  /** If true the NPC never melee-charges. */
  keepDistance: boolean;
  runSpeedMul: number;
}

export const COP_OPTS: HostileOptions = { range: 14, accuracy: 0.55, burstInterval: 1.4, burstLength: 3, keepDistance: true, runSpeedMul: 1.0 };
export const GANG_OPTS: HostileOptions = { range: 10, accuracy: 0.4, burstInterval: 1.8, burstLength: 2, keepDistance: false, runSpeedMul: 1.05 };

export function hasLineOfSight(statics: StaticWorld, ped: Pedestrian, player: Player): boolean {
  return !statics.blocked(ped.x, ped.y + 1.5, ped.z, player.x, player.y + 1.2, player.z);
}

/**
 * Drive one hostile pedestrian for a step. Returns true while engaged (player seen recently).
 */
export function hostileAI(ped: Pedestrian, player: Player, combat: CombatSystem, statics: StaticWorld, dt: number, time: number, events: GameEvent[], opts: HostileOptions): boolean {
  if (ped.dead || player.dead) {
    ped.stop();
    ped.aiming = false;
    return false;
  }
  const dx = player.x - ped.x;
  const dz = player.z - ped.z;
  const dist = Math.hypot(dx, dz);
  const los = dist < 120 && hasLineOfSight(statics, ped, player);
  if (los) ped.lastSeenPlayer = 0;
  else ped.lastSeenPlayer += dt;
  const weapon = ped.weapon ? WEAPON_SPECS[ped.weapon] : null;
  const isMelee = !weapon || weapon.clipSize === 0;
  const engageRange = isMelee ? (weapon ? weapon.range - 0.2 : 1.4) : opts.range;
  const playerInCar = !!player.vehicle;

  // Movement
  if (los && dist <= engageRange && !(isMelee && playerInCar)) {
    // hold position, strafe a bit
    const strafe = Math.sin(time * 1.3 + ped.seed * 9) * (opts.keepDistance ? 1.2 : 0.4);
    const rx = -dz / (dist || 1);
    const rz = dx / (dist || 1);
    if (dist < engageRange * 0.5 && opts.keepDistance) {
      ped.moveToward(ped.x - dx * 0.5 + rx * strafe, ped.z - dz * 0.5 + rz * strafe, ped.walkSpeed, dt, 10);
    } else {
      ped.moveToward(ped.x + rx * strafe, ped.z + rz * strafe, ped.walkSpeed * 0.6, dt, 10);
    }
    ped.yaw = wrapAngle(Math.atan2(dx, dz));
    ped.setState('attack');
  } else if (ped.lastSeenPlayer < 6 || dist < 40) {
    // chase (cops on foot won't chase a car forever)
    if (playerInCar && dist > 25 && Math.hypot(player.vx, player.vz) > 8) {
      ped.stop();
      ped.yaw = wrapAngle(Math.atan2(dx, dz));
    } else {
      ped.moveToward(player.x, player.z, ped.runSpeed * opts.runSpeedMul, dt, 8);
    }
    ped.setState('chase');
  } else {
    ped.stop();
    ped.setState('idle');
    ped.aiming = false;
    return false;
  }

  // Attack
  ped.aiming = los && !isMelee && dist < opts.range * 2.5;
  if (ped.aiming) {
    ped.aimYaw = Math.atan2(dx, dz);
    ped.aimPitch = Math.atan2(player.y + 1.2 - (ped.y + 1.4), dist);
  }
  if (los && ped.fireCooldown <= 0) {
    if (isMelee) {
      if (dist <= engageRange + 0.3 && !playerInCar) {
        ped.punchT = 0;
        ped.fireCooldown = weapon ? weapon.fireInterval + 0.2 : 0.8;
        combat.melee(ped.x, ped.y, ped.z, ped.yaw, weapon ?? WEAPON_SPECS.fist, ped, player, time, events);
      }
    } else if (weapon && dist < opts.range * 2.5) {
      if (ped.ammoBurst <= 0) {
        ped.ammoBurst = opts.burstLength;
      }
      const ox = ped.x + Math.sin(ped.yaw) * 0.4;
      const oy = ped.y + 1.4;
      const oz = ped.z + Math.cos(ped.yaw) * 0.4;
      const tx = player.x;
      const ty = player.y + (playerInCar ? 0.9 : 1.1);
      const tz = player.z;
      let ddx = tx - ox;
      let ddy = ty - oy;
      let ddz = tz - oz;
      const l = Math.hypot(ddx, ddy, ddz) || 1;
      ddx /= l;
      ddy /= l;
      ddz /= l;
      const spreadMul = (1.6 - opts.accuracy) * (1 + dist / 40) * 2.2;
      combat.fireHitscan(ox, oy, oz, ddx, ddy, ddz, weapon, ped, player, time, events, spreadMul);
      ped.ammoBurst--;
      ped.fireCooldown = ped.ammoBurst > 0 ? weapon.fireInterval * 1.6 : opts.burstInterval + ped.seed * 0.6;
    }
  }
  return true;
}
