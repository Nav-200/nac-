import * as THREE from 'three';
import { clamp01, damp, lerp, smoothstep, wrapAngle } from '../engine/math';
import type { Vehicle } from '../car/vehicle';
import type { CameraMode } from '../types';
import type { Terrain } from '../world/terrain';

const BASE_FOV = 64;
const MAX_FOV = 84;

/**
 * Chase camera.
 *
 * The important detail is that it tracks the car's *direction of travel* more
 * than its heading. During a slide that keeps the car broadside in frame, which
 * is what makes drifting look good rather than confusing, while still turning
 * with the car enough to see where you are going.
 */
export class ChaseCamera {
  mode: CameraMode = 'chase';

  private yaw = 0;
  private readonly position = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly lookAt = new THREE.Vector3();
  private cinematicAngle = 0;
  private shake = 0;
  private impulseShake = 0;
  private boostZoom = 0;
  private initialised = false;

  reset(vehicle: Vehicle): void {
    this.yaw = vehicle.yaw;
    this.initialised = false;
  }

  cycleMode(): CameraMode {
    this.mode = this.mode === 'chase' ? 'hood' : this.mode === 'hood' ? 'cinematic' : 'chase';
    return this.mode;
  }

  update(
    dt: number,
    vehicle: Vehicle,
    camera: THREE.PerspectiveCamera,
    terrain: Terrain,
    carPos: THREE.Vector3,
    carYaw: number,
  ): void {
    const speed = vehicle.speed;
    const speed01 = clamp01(speed / 70);

    if (this.mode === 'hood') {
      this.updateHood(dt, vehicle, camera, carPos, carYaw, speed01);
      return;
    }
    if (this.mode === 'cinematic') {
      this.updateCinematic(dt, camera, terrain, carPos, speed01);
      return;
    }

    // Blend heading with travel direction. At a crawl there is no meaningful
    // travel direction, so fall back to the nose.
    const travelYaw = carYaw + vehicle.slipAngle;
    const blend = smoothstep(2, 12, speed) * 0.62;
    const wanted = carYaw + wrapAngle(travelYaw - carYaw) * blend;

    if (!this.initialised) {
      this.yaw = wanted;
      this.initialised = true;
    }
    // Slower yaw catch-up at speed keeps fast corners from whipping the view.
    this.yaw += wrapAngle(wanted - this.yaw) * (1 - Math.exp(-lerp(6.5, 3.4, speed01) * dt));

    const distance = lerp(6.4, 8.1, speed01);
    const height = lerp(2.45, 3.0, speed01);
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);

    this.desired.set(
      carPos.x - sin * distance,
      carPos.y + height,
      carPos.z - cos * distance,
    );

    // Critically damped follow; a touch looser vertically so crests breathe.
    this.position.x = damp(this.position.x, this.desired.x, 9, dt);
    this.position.y = damp(this.position.y, this.desired.y, 6, dt);
    this.position.z = damp(this.position.z, this.desired.z, 9, dt);

    // Never let the ground get between the camera and the car.
    const groundY = terrain.heightAt(this.position.x, this.position.z) + 1.15;
    if (this.position.y < groundY) this.position.y = groundY;

    // Look a little way up the road rather than at the boot lid.
    const leadSin = Math.sin(carYaw);
    const leadCos = Math.cos(carYaw);
    const lead = lerp(3.0, 9.5, speed01);
    this.target.set(
      carPos.x + leadSin * lead,
      carPos.y + 1.1,
      carPos.z + leadCos * lead,
    );
    this.lookAt.x = damp(this.lookAt.x, this.target.x, 11, dt);
    this.lookAt.y = damp(this.lookAt.y, this.target.y, 11, dt);
    this.lookAt.z = damp(this.lookAt.z, this.target.z, 11, dt);

    this.applyShake(dt, vehicle, speed01);
    camera.position.copy(this.position);
    camera.position.x += (Math.random() - 0.5) * this.shake;
    camera.position.y += (Math.random() - 0.5) * this.shake;
    camera.lookAt(this.lookAt);

    this.boostZoom = damp(this.boostZoom, vehicle.boosting ? 1 : 0, 5, dt);
    const fov = lerp(BASE_FOV, MAX_FOV, speed01 * speed01) + this.boostZoom * 9;
    if (Math.abs(camera.fov - fov) > 0.05) {
      camera.fov = damp(camera.fov, fov, 4, dt);
      camera.updateProjectionMatrix();
    }
  }

  private updateHood(
    dt: number,
    vehicle: Vehicle,
    camera: THREE.PerspectiveCamera,
    carPos: THREE.Vector3,
    carYaw: number,
    speed01: number,
  ): void {
    // Sit just ahead of the nose rather than inside the cabin: from the roof
    // the bonnet fills half the screen and you cannot see the apex.
    const sin = Math.sin(carYaw);
    const cos = Math.cos(carYaw);
    camera.position.set(
      carPos.x + sin * 2.45,
      carPos.y + 0.95,
      carPos.z + cos * 2.45,
    );
    this.applyShake(dt, vehicle, speed01);
    camera.position.y += (Math.random() - 0.5) * this.shake * 0.6;

    this.lookAt.set(
      carPos.x + sin * 30,
      carPos.y + 1.6 - vehicle.pitch * 12,
      carPos.z + cos * 30,
    );
    camera.up.set(0, 1, 0);
    camera.lookAt(this.lookAt);
    camera.rotateZ(-vehicle.roll * 0.5);

    this.boostZoom = damp(this.boostZoom, vehicle.boosting ? 1 : 0, 5, dt);
    const fov = lerp(BASE_FOV + 4, MAX_FOV + 4, speed01 * speed01) + this.boostZoom * 9;
    camera.fov = damp(camera.fov, fov, 4, dt);
    camera.updateProjectionMatrix();
  }

  private updateCinematic(
    dt: number,
    camera: THREE.PerspectiveCamera,
    terrain: Terrain,
    carPos: THREE.Vector3,
    speed01: number,
  ): void {
    this.cinematicAngle += dt * 0.28;
    const radius = lerp(9, 15, speed01);
    camera.position.set(
      carPos.x + Math.sin(this.cinematicAngle) * radius,
      carPos.y + 3.4,
      carPos.z + Math.cos(this.cinematicAngle) * radius,
    );
    const groundY = terrain.heightAt(camera.position.x, camera.position.z) + 1.6;
    if (camera.position.y < groundY) camera.position.y = groundY;
    camera.lookAt(carPos.x, carPos.y + 0.9, carPos.z);
    camera.fov = damp(camera.fov, 52, 4, dt);
    camera.updateProjectionMatrix();
  }

  /** One-off jolt (collisions, hard landings); decays on its own. */
  addImpulse(amount: number): void {
    this.impulseShake = Math.min(this.impulseShake + amount, 0.6);
  }

  private applyShake(dt: number, vehicle: Vehicle, speed01: number): void {
    let wanted = speed01 * speed01 * 0.055;
    if (vehicle.offRoad) wanted += speed01 * 0.11;
    if (vehicle.boosting) wanted += 0.06;
    if (!vehicle.grounded) wanted = 0;
    this.impulseShake *= Math.exp(-7 * dt);
    this.shake = damp(this.shake, wanted, 8, dt) + this.impulseShake;
  }

  /** Camera yaw, exposed for the audio panner and the minimap. */
  get currentYaw(): number {
    return this.yaw;
  }
}
