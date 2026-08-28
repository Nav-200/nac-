import * as THREE from 'three';
import { CarModel } from '../car/carModel';
import { clamp, damp, lerp, wrapAngle } from '../engine/math';
import { CARS, type CarSpec, type QualitySettings } from '../types';
import type { Road } from '../world/road';
import type { Terrain } from '../world/terrain';

/** Lateral cornering the AI is willing to ask of its tyres, m/s^2. */
const AI_LATERAL_LIMIT = 9.8;

interface OpponentConfig {
  spec: CarSpec;
  /** Preferred offset from the centreline, so they do not drive in each other. */
  lane: number;
  /** Skill multiplier on corner speed. */
  pace: number;
}

/**
 * Rivals for the checkpoint race.
 *
 * They are kinematic: each one owns a distance along the loop rather than a
 * simulated chassis. That keeps them perfectly stable at any framerate and
 * costs almost nothing, and since they visibly lean and slide through corners
 * the difference is not readable in motion.
 */
class Opponent {
  readonly model: CarModel;
  /** Metres travelled along the loop since the start. */
  travelled = 0;

  private distance = 0;
  private speed = 0;
  private lateral: number;
  private targetLateral: number;
  private pace: number;
  private yaw = 0;
  private visualRoll = 0;
  private wheelSpin = 0;
  private readonly pos = new THREE.Vector3();

  constructor(config: OpponentConfig, quality: QualitySettings) {
    this.model = new CarModel(config.spec, quality.shadows);
    this.lateral = config.lane;
    this.targetLateral = config.lane;
    this.pace = config.pace;
  }

  reset(road: Road, startDistance: number, lane: number): void {
    this.distance = startDistance;
    this.travelled = 0;
    this.speed = 0;
    this.lateral = lane;
    this.targetLateral = lane;
    const idx = road.indexAtDistance(this.distance);
    this.yaw = road.headingAt(idx);
  }

  update(
    dt: number,
    road: Road,
    terrain: Terrain,
    playerProgress: number,
    running: boolean,
  ): void {
    if (running) {
      const idx = road.indexAtDistance(this.distance);

      // Look far enough ahead that the corner is anticipated rather than
      // reacted to, and scale that lookahead with speed.
      const lookaheadMetres = clamp(18 + this.speed * 1.4, 24, 120);
      const aheadIdx = road.indexAtDistance(this.distance + lookaheadMetres);
      const curvature = Math.max(
        road.curvatureAt(aheadIdx, 8),
        road.curvatureAt(idx, 8) * 0.6,
      );

      let targetSpeed = 63 * this.pace;
      if (curvature > 1e-5) {
        targetSpeed = Math.min(targetSpeed, Math.sqrt(AI_LATERAL_LIMIT / curvature) * this.pace);
      }

      // Gentle rubber-banding keeps the pack in sight without feeling rigged.
      const gap = playerProgress - this.travelled;
      targetSpeed *= clamp(1 + gap * 0.0022, 0.84, 1.18);
      targetSpeed = clamp(targetSpeed, 10, 72);

      // Braking is quicker than acceleration, same as the player's car.
      const rate = targetSpeed < this.speed ? 3.2 : 1.5;
      this.speed = damp(this.speed, targetSpeed, rate, dt);

      const step = this.speed * dt;
      this.distance += step;
      this.travelled += step;

      // Drift toward a racing line: outside on entry, tight through the apex.
      const apex = -Math.sign(this.signedCurvature(road, aheadIdx)) * Math.min(2.6, curvature * 900);
      this.targetLateral = clamp(this.lateral * 0.6 + apex, -3.4, 3.4);
      this.lateral = damp(this.lateral, this.targetLateral, 1.4, dt);
    }

    const idx = road.indexAtDistance(this.distance);
    road.positionAt(idx, this.pos, this.lateral);
    const ground = terrain.heightAt(this.pos.x, this.pos.z);
    this.pos.y = Math.max(ground, this.pos.y);

    const targetYaw = road.headingAt(idx);
    const delta = wrapAngle(targetYaw - this.yaw);
    this.yaw = wrapAngle(this.yaw + delta * (1 - Math.exp(-9 * dt)));

    this.model.group.position.set(this.pos.x, ground, this.pos.z);
    this.model.group.rotation.y = this.yaw;

    // Lean into the corner so they look like they are working for it.
    this.visualRoll = damp(this.visualRoll, clamp(-delta / dt * 0.06, -0.1, 0.1), 5, dt);
    this.wheelSpin += (this.speed / 0.34) * dt;
    this.model.updateVisuals(
      clamp(delta * 6, -0.4, 0.4),
      this.wheelSpin,
      0,
      this.visualRoll,
      this.speed < 24 ? 0.6 : 0,
      false,
      ground,
    );
  }

  private signedCurvature(road: Road, index: number): number {
    const a = road.headingAt(index);
    const b = road.headingAt(index + 10);
    return wrapAngle(b - a);
  }

  get position(): THREE.Vector3 {
    return this.pos;
  }

  dispose(): void {
    this.model.dispose();
  }
}

export class OpponentField {
  readonly group = new THREE.Group();
  private opponents: Opponent[] = [];

  constructor(quality: QualitySettings, count = 3) {
    this.group.name = 'opponents';
    const lanes = [-3.0, 3.0, -1.2, 1.2];
    const paces = [0.98, 0.93, 0.88, 0.85];
    for (let i = 0; i < count; i++) {
      const spec = CARS[(i + 1) % CARS.length];
      const opponent = new Opponent(
        { spec: { ...spec, color: shiftHue(spec.color, i) }, lane: lanes[i % lanes.length], pace: paces[i % paces.length] },
        quality,
      );
      this.opponents.push(opponent);
      this.group.add(opponent.model.group);
    }
    this.group.visible = false;
  }

  get racers(): number {
    return this.opponents.length + 1;
  }

  reset(road: Road, startDistance: number): void {
    const lanes = [-3.0, 3.0, -1.2, 1.2];
    for (let i = 0; i < this.opponents.length; i++) {
      // Stagger the grid back from the line so nobody starts inside anyone else.
      this.opponents[i].reset(road, startDistance - 7 - i * 6.5, lanes[i % lanes.length]);
    }
    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }

  update(
    dt: number,
    road: Road,
    terrain: Terrain,
    playerProgress: number,
    running: boolean,
  ): void {
    if (!this.group.visible) return;
    for (const o of this.opponents) o.update(dt, road, terrain, playerProgress, running);
  }

  /** 1 = leading. */
  playerPosition(playerProgress: number): number {
    if (!this.group.visible) return 1;
    let ahead = 0;
    for (const o of this.opponents) if (o.travelled > playerProgress) ahead++;
    return ahead + 1;
  }

  /** Pushes the player out of an opponent they have driven into. */
  resolveOverlap(
    playerX: number,
    playerZ: number,
    apply: (dx: number, dz: number) => void,
  ): void {
    if (!this.group.visible) return;
    for (const o of this.opponents) {
      const dx = playerX - o.position.x;
      const dz = playerZ - o.position.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.001 && d < 3.1) {
        const push = (3.1 - d) * 0.6;
        apply((dx / d) * push, (dz / d) * push);
      }
    }
  }

  dispose(): void {
    for (const o of this.opponents) o.dispose();
  }
}

/** Cheap hue shuffle so the rivals are not all the same colour. */
const shiftHue = (hex: number, i: number): number => {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL((hsl.h + i * 0.27) % 1, lerp(hsl.s, 0.85, 0.4), hsl.l);
  return c.getHex();
};
