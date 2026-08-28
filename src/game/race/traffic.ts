import * as THREE from 'three';
import { clamp, damp, makeRng, wrapAngle } from '../engine/math';
import { mergeParts } from '../world/geometryUtils';
import type { Road } from '../world/road';
import type { Terrain } from '../world/terrain';

const CAR_COUNT = 5;
/** Beyond this arc distance from the player a car is quietly recycled. */
const RECYCLE_RANGE = 430;
const LANE_OFFSET = 2.6;

const TRAFFIC_TINTS = [0x9aa4b0, 0x6f86a8, 0xb08a6f, 0x7ba07b, 0xa07ba0];

/** One merged geometry for every traffic car: a whole car in a single mesh. */
const buildTrafficGeometry = (): THREE.BufferGeometry => {
  const tyre = 0x181a1e;
  const glass = 0x1a2430;
  const parts: Parameters<typeof mergeParts>[0] = [
    { geometry: new THREE.BoxGeometry(1.74, 0.52, 3.9), color: 0xffffff, position: [0, 0.62, 0] },
    { geometry: new THREE.BoxGeometry(1.5, 0.44, 1.9), color: glass, position: [0, 1.05, -0.1] },
    { geometry: new THREE.BoxGeometry(0.4, 0.12, 0.06), color: 0xfff0c8, position: [0.55, 0.62, 1.96] },
    { geometry: new THREE.BoxGeometry(0.4, 0.12, 0.06), color: 0xfff0c8, position: [-0.55, 0.62, 1.96] },
    { geometry: new THREE.BoxGeometry(0.44, 0.12, 0.06), color: 0x7a1520, position: [0.55, 0.62, -1.96] },
    { geometry: new THREE.BoxGeometry(0.44, 0.12, 0.06), color: 0x7a1520, position: [-0.55, 0.62, -1.96] },
  ];
  for (const sx of [0.82, -0.82]) {
    for (const sz of [1.3, -1.3]) {
      parts.push({
        geometry: new THREE.CylinderGeometry(0.33, 0.33, 0.24, 8),
        color: tyre,
        position: [sx, 0.34, sz],
        rotation: [0, 0, Math.PI / 2],
      });
    }
  }
  return mergeParts(parts);
};

interface TrafficCar {
  distance: number;
  direction: 1 | -1;
  speed: number;
  targetSpeed: number;
  yaw: number;
  x: number;
  y: number;
  z: number;
  /** Set after a near-miss until the player pulls clear, so it scores once. */
  nearMissLatch: boolean;
}

/**
 * Ambient cars cruising the loop in free roam.
 *
 * Deliberately not `OpponentField`: no standings, no racing line, no grid — and
 * one `InstancedMesh` for the whole set, so five cars cost one draw call.
 * Cars that fall too far behind or ahead of the player are recycled to just
 * outside view range, which keeps the road alive with only a handful of them.
 */
export class TrafficField {
  readonly mesh: THREE.InstancedMesh;
  private cars: TrafficCar[] = [];
  private geometry: THREE.BufferGeometry;
  private material: THREE.MeshLambertMaterial;
  private rng = makeRng(48151623);
  private active = false;

  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3(1, 1, 1);
  private readonly axis = new THREE.Vector3(0, 1, 0);

  constructor() {
    this.geometry = buildTrafficGeometry();
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, CAR_COUNT);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    const color = new THREE.Color();
    for (let i = 0; i < CAR_COUNT; i++) {
      this.mesh.setColorAt(i, color.setHex(TRAFFIC_TINTS[i % TRAFFIC_TINTS.length]));
      this.cars.push({
        distance: 0,
        direction: i % 2 === 0 ? 1 : -1,
        speed: 0,
        targetSpeed: 15,
        yaw: 0,
        x: 0,
        y: 0,
        z: 0,
        nearMissLatch: true,
      });
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  setActive(active: boolean, road: Road, playerArcDistance: number): void {
    if (this.active === active) return;
    this.active = active;
    this.mesh.visible = active;
    if (active) {
      for (const car of this.cars) this.recycle(car, road, playerArcDistance);
    }
  }

  get isActive(): boolean {
    return this.active;
  }

  private recycle(car: TrafficCar, road: Road, playerArcDistance: number): void {
    // Drop the car outside view range, ahead or behind, in a random direction.
    const side = this.rng() < 0.5 ? 1 : -1;
    const along = 180 + this.rng() * 190;
    car.distance = playerArcDistance + side * along;
    car.direction = this.rng() < 0.5 ? 1 : -1;
    car.speed = car.targetSpeed = 13 + this.rng() * 6;
    car.nearMissLatch = true;
    const idx = road.indexAtDistance(car.distance);
    car.yaw = road.headingAt(idx) + (car.direction === 1 ? 0 : Math.PI);
  }

  /**
   * Advance the cars; returns the count of fresh near-misses this step so the
   * game can score them. Player collision handling stays in `Game`.
   */
  update(
    dt: number,
    road: Road,
    terrain: Terrain,
    playerX: number,
    playerZ: number,
    playerArcDistance: number,
    playerSpeed: number,
  ): number {
    if (!this.active) return 0;
    let nearMisses = 0;

    for (let i = 0; i < CAR_COUNT; i++) {
      const car = this.cars[i];

      const gap = car.distance - playerArcDistance;
      const wrapped =
        ((gap % road.totalLength) + road.totalLength * 1.5) % road.totalLength -
        road.totalLength * 0.5;
      if (Math.abs(wrapped) > RECYCLE_RANGE) this.recycle(car, road, playerArcDistance);

      // Slow for corners a little, like someone actually commuting.
      const idx = road.indexAtDistance(car.distance);
      const curvature = road.curvatureAt(idx, car.direction * 8);
      const cornered = clamp(Math.sqrt(6.5 / Math.max(curvature, 1e-4)), 9, car.targetSpeed);
      car.speed = damp(car.speed, cornered, 2, dt);
      car.distance += car.direction * car.speed * dt;

      // Right-hand-traffic lane for its direction of travel.
      const lane = -LANE_OFFSET * car.direction;
      road.positionAt(idx, this.pos, lane);
      car.x = this.pos.x;
      car.z = this.pos.z;
      car.y = terrain.heightAt(car.x, car.z);

      const targetYaw = road.headingAt(idx) + (car.direction === 1 ? 0 : Math.PI);
      car.yaw = wrapAngle(car.yaw + wrapAngle(targetYaw - car.yaw) * (1 - Math.exp(-8 * dt)));

      // Near-miss: close pass at real speed, scored once per encounter.
      const dx = playerX - car.x;
      const dz = playerZ - car.z;
      const d2 = dx * dx + dz * dz;
      if (car.nearMissLatch) {
        if (d2 < 4.1 * 4.1 && d2 > 2.4 * 2.4 && playerSpeed > 17) {
          car.nearMissLatch = false;
          nearMisses++;
        }
      } else if (d2 > 12 * 12) {
        car.nearMissLatch = true;
      }

      this.pos.set(car.x, car.y, car.z);
      this.quat.setFromAxisAngle(this.axis, car.yaw);
      this.matrix.compose(this.pos, this.quat, this.scl);
      this.mesh.setMatrixAt(i, this.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    return nearMisses;
  }

  /** Hard-body contact check against the player; returns impact via callback. */
  resolveCollision(
    playerX: number,
    playerZ: number,
    onHit: (nx: number, nz: number, pushX: number, pushZ: number) => void,
  ): void {
    if (!this.active) return;
    for (const car of this.cars) {
      const dx = playerX - car.x;
      const dz = playerZ - car.z;
      const d = Math.hypot(dx, dz);
      const minD = 2.5;
      if (d > 0.001 && d < minD) {
        const nx = dx / d;
        const nz = dz / d;
        onHit(nx, nz, nx * (minD - d), nz * (minD - d));
      }
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}
