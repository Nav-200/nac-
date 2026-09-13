/**
 * Third-person orbit camera with aim mode, vehicle auto-centre, wall collision, FOV kicks
 * and shake. Yaw is the horizontal look direction (yaw 0 = looking toward +Z).
 */
import * as THREE from 'three';
import {
  CAM_AIM_DIST,
  CAM_AIM_FOV,
  CAM_AIM_SIDE,
  CAM_FOLLOW_DIST_CAR,
  CAM_FOLLOW_DIST_FOOT,
  CAM_FOLLOW_HEIGHT_CAR,
  CAM_FOLLOW_HEIGHT_FOOT,
  CAM_FOV,
  CAM_PITCH_MAX,
  CAM_PITCH_MIN,
  MOUSE_SENS,
} from '../core/constants';
import type { InputState } from '../core/input';
import { clamp, damp, dampAngle, lerp } from '../core/mathUtils';
import type { StaticWorld, StaticRayResult } from '../physics/staticWorld';
import type { Player } from '../entities/player';

export type CameraMode = 'near' | 'far' | 'first';

const ray: StaticRayResult = { hit: null, t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0 };

export class CameraController {
  yaw = Math.PI; // start looking toward -Z (into the plaza)
  pitch = 0.22;
  mode: CameraMode = 'near';
  sensitivity = 1;
  private pos = new THREE.Vector3();
  private target = new THREE.Vector3();
  private lookPoint = new THREE.Vector3();
  private dist = CAM_FOLLOW_DIST_FOOT;
  private fov = CAM_FOV;
  private lastMouse = 0;
  private shakeAmt = 0;
  private shakeT = 0;
  private initialized = false;
  private tmp = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private rightVec = new THREE.Vector3();

  addShake(amount: number): void {
    this.shakeAmt = Math.min(1.5, this.shakeAmt + amount);
  }

  cycleMode(): void {
    this.mode = this.mode === 'near' ? 'far' : this.mode === 'far' ? 'first' : 'near';
  }

  /** Reset behind the player (respawn / teleport). */
  snapBehind(player: Player): void {
    this.yaw = player.vehicle ? player.vehicle.yaw : player.yaw;
    this.pitch = 0.22;
    this.initialized = false;
  }

  update(dt: number, input: InputState, player: Player, statics: StaticWorld, camera: THREE.PerspectiveCamera, time: number): void {
    const sens = MOUSE_SENS * this.sensitivity;
    if (Math.abs(input.lookDX) > 0 || Math.abs(input.lookDY) > 0) {
      // yaw increases to the left in this convention, so mouse-right decreases yaw
      this.yaw -= input.lookDX * sens;
      this.pitch = clamp(this.pitch + input.lookDY * sens, CAM_PITCH_MIN, CAM_PITCH_MAX);
      this.lastMouse = time;
    }
    const v = player.vehicle;
    const first = this.mode === 'first';
    const aiming = player.aiming && !v;

    // Vehicle auto-centre when the mouse is idle
    if (v && time - this.lastMouse > 1.0) {
      const behindYaw = v.speed < -1 ? v.yaw + Math.PI : v.yaw;
      const rate = 1.8 + Math.min(2.5, Math.abs(v.speed) * 0.08);
      this.yaw = dampAngle(this.yaw, behindYaw, rate, dt);
      this.pitch = damp(this.pitch, 0.2, 2, dt);
    }

    // Target point
    let targetDist: number;
    let height: number;
    let side = 0;
    let targetFov = CAM_FOV;
    if (v) {
      const sizeK = clamp(v.spec.length / 4.6, 0.9, 2.2);
      targetDist = (this.mode === 'far' ? CAM_FOLLOW_DIST_CAR * 1.6 : CAM_FOLLOW_DIST_CAR) * sizeK;
      height = CAM_FOLLOW_HEIGHT_CAR * (0.7 + sizeK * 0.3);
      this.target.set(v.x, v.y + v.spec.height * 0.55, v.z);
      targetFov = CAM_FOV + clamp(Math.abs(v.speed) / v.spec.maxSpeed, 0, 1) * 14;
    } else if (aiming) {
      targetDist = CAM_AIM_DIST;
      height = 1.55;
      side = CAM_AIM_SIDE;
      this.target.set(player.x, player.y + height, player.z);
      targetFov = CAM_AIM_FOV;
    } else {
      targetDist = this.mode === 'far' ? CAM_FOLLOW_DIST_FOOT * 1.7 : CAM_FOLLOW_DIST_FOOT;
      height = CAM_FOLLOW_HEIGHT_FOOT;
      this.target.set(player.x, player.y + 1.5, player.z);
    }

    const lx = Math.sin(this.yaw);
    const lz = Math.cos(this.yaw);
    this.rightVec.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));

    if (first) {
      // First person: at the head / seat
      if (v) {
        const seat = { x: 0, y: 0, z: 0 };
        v.seatPosition(seat);
        this.pos.set(seat.x, seat.y + 0.35, seat.z);
      } else {
        this.pos.set(player.x + player.forwardX * 0.15, player.y + 1.65, player.z + player.forwardZ * 0.15);
      }
      const cp = Math.cos(this.pitch);
      this.lookPoint.set(this.pos.x + lx * cp * 10, this.pos.y - Math.sin(this.pitch) * 10, this.pos.z + lz * cp * 10);
      camera.position.copy(this.pos);
      camera.lookAt(this.lookPoint);
      this.fov = damp(this.fov, targetFov + 5, 6, dt);
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
      return;
    }

    // Desired camera position on the orbit sphere
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const anchor = this.tmp.copy(this.target).addScaledVector(this.rightVec, side);
    const desired = new THREE.Vector3(anchor.x - lx * cp * targetDist, anchor.y + sp * targetDist + (v ? 0 : 0.0), anchor.z - lz * cp * targetDist);
    if (!aiming && !v) desired.y = Math.max(desired.y, player.y + 0.6);

    // Collision: shorten the boom when a wall is in the way
    const dx = desired.x - anchor.x;
    const dy = desired.y - anchor.y;
    const dz = desired.z - anchor.z;
    const full = Math.hypot(dx, dy, dz);
    let allowed = full;
    if (full > 0.01 && statics.raycast(anchor.x, anchor.y, anchor.z, dx / full, dy / full, dz / full, full, ray)) {
      allowed = Math.max(0.35, ray.t - 0.35);
    }
    // Snap in fast, relax out slowly
    if (!this.initialized) {
      this.dist = allowed;
      this.initialized = true;
    } else if (allowed < this.dist) this.dist = allowed;
    else this.dist = damp(this.dist, allowed, 3, dt);
    const k = this.dist / full;
    desired.set(anchor.x + dx * k, anchor.y + dy * k, anchor.z + dz * k);

    // Smooth position (vehicles lag more for a sense of speed)
    const lambda = v ? 10 : aiming ? 26 : 16;
    if (!this.initialized) this.pos.copy(desired);
    this.pos.x = damp(this.pos.x, desired.x, lambda, dt);
    this.pos.y = damp(this.pos.y, desired.y, lambda, dt);
    this.pos.z = damp(this.pos.z, desired.z, lambda, dt);
    // never let the camera go below the ground plane
    this.pos.y = Math.max(this.pos.y, (v ? v.y : player.y) + 0.35);

    // Look point: slightly ahead of the target so the character sits low-centre
    const lead = v ? clamp(Math.abs(v.speed) * 0.12, 0, 6) : aiming ? 20 : 1.2;
    this.lookPoint.set(anchor.x + lx * lead, anchor.y - (aiming ? Math.sin(this.pitch) * 20 : 0.1), anchor.z + lz * lead);

    // Shake
    if (this.shakeAmt > 0.001) {
      this.shakeT += dt * 40;
      const s = this.shakeAmt;
      this.pos.x += Math.sin(this.shakeT * 1.3) * s * 0.15;
      this.pos.y += Math.cos(this.shakeT * 1.7) * s * 0.12;
      this.shakeAmt = damp(this.shakeAmt, 0, 5, dt);
    }

    camera.position.copy(this.pos);
    camera.up.copy(this.up);
    camera.lookAt(this.lookPoint);
    this.fov = damp(this.fov, targetFov, aiming ? 14 : 5, dt);
    camera.fov = this.fov;
    camera.updateProjectionMatrix();
  }

  /** Aim ray from the camera through the crosshair. */
  getAimRay(camera: THREE.PerspectiveCamera, out: { ox: number; oy: number; oz: number; dx: number; dy: number; dz: number }): void {
    camera.getWorldDirection(this.tmp);
    out.ox = camera.position.x;
    out.oy = camera.position.y;
    out.oz = camera.position.z;
    out.dx = this.tmp.x;
    out.dy = this.tmp.y;
    out.dz = this.tmp.z;
  }

  get position(): THREE.Vector3 {
    return this.pos;
  }

  /** Blend helper for HUD fades. */
  fovBlend(): number {
    return lerp(0, 1, (this.fov - CAM_AIM_FOV) / (CAM_FOV - CAM_AIM_FOV));
  }
}
