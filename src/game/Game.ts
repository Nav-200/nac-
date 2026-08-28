import * as THREE from 'three';
import { EngineAudio } from './audio/engineAudio';
import { CarModel } from './car/carModel';
import { Vehicle } from './car/vehicle';
import { Engine, type EngineHooks } from './engine/Engine';
import { Input } from './engine/input';
import { clamp01 } from './engine/math';
import { ChaseCamera } from './fx/camera';
import { SkidMarks, SmokeSystem } from './fx/particles';
import { OpponentField } from './race/opponents';
import { Race } from './race/route';
import {
  CARS,
  createHudState,
  QUALITY,
  type CameraMode,
  type CarSpec,
  type GamePhase,
  type HudState,
  type QualityTier,
} from './types';
import { MAP_HALF } from './world/heightfield';
import { makeRoadHit, Road } from './world/road';
import { Scenery } from './world/scenery';
import { Sky, type TimeOfDay } from './world/sky';
import { Terrain } from './world/terrain';

const DRIFT_BANK_DELAY = 1.4;
const RESPAWN_CLEARANCE = 1.2;

/**
 * Owns the world and drives every system. `Engine` calls `fixedUpdate` at a
 * constant rate and `frameUpdate` once per rendered frame; nothing in either
 * path allocates, which is what keeps the frame time flat enough to feel smooth
 * on a phone.
 */
export class Game implements EngineHooks {
  readonly hud: HudState = createHudState();
  readonly input = new Input();
  readonly audio = new EngineAudio();

  onPhaseChange: ((phase: GamePhase) => void) | null = null;

  private engine: Engine;
  private road: Road;
  private terrain: Terrain;
  private scenery: Scenery;
  private sky: Sky;
  private vehicle: Vehicle;
  private carModel: CarModel;
  private opponents: OpponentField;
  private race: Race;
  private chaseCamera = new ChaseCamera();
  private smoke: SmokeSystem;
  private skids: SkidMarks;

  private phase: GamePhase = 'menu';
  private carSpec: CarSpec = CARS[0];

  // Free-roam drift chain.
  private driftChain = 0;
  private driftIdle = 0;
  private bankedScore = 0;

  private smokeTimer = 0;
  private lastCountdownTick = 4;
  private particleScale = 1;

  // Scratch objects reused every frame.
  private readonly roadHit = makeRoadHit();
  private readonly renderPos = new THREE.Vector3();
  private readonly scratchA = new THREE.Vector3();
  private readonly scratchB = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement, tier: QualityTier = 'high') {
    this.engine = new Engine(canvas, tier);
    this.engine.onQualityDrop = (next) => this.applyQuality(next);

    this.road = new Road();
    this.terrain = new Terrain(this.road);
    this.scenery = new Scenery(this.road, this.terrain, this.engine.quality);
    this.sky = new Sky(this.engine.scene, this.engine.renderer, this.engine.quality);

    this.engine.scene.add(this.terrain.group);
    this.engine.scene.add(this.road.buildMesh());
    this.engine.scene.add(this.scenery.group);

    this.vehicle = new Vehicle(this.carSpec, this.terrain);
    this.carModel = new CarModel(this.carSpec, this.engine.quality.shadows);
    this.engine.scene.add(this.carModel.group);

    this.race = new Race(this.road);
    this.engine.scene.add(this.race.group);

    this.opponents = new OpponentField(this.engine.quality);
    this.engine.scene.add(this.opponents.group);

    this.smoke = new SmokeSystem(260);
    this.skids = new SkidMarks(420);
    this.engine.scene.add(this.smoke.points);
    this.engine.scene.add(this.skids.mesh);
    this.syncParticleProjection();
    window.addEventListener('resize', this.handleResize, { passive: true });

    this.hud.checkpointTotal = this.race.gateCount;
    this.hud.bestTime = this.race.bestTime;
    this.hud.racerCount = this.opponents.racers;
    this.hud.quality = this.engine.quality.tier;

    this.respawnOnRoad(0);
    this.engine.setHooks(this);
    this.input.attach();
  }

  private handleResize = (): void => {
    this.syncParticleProjection();
  };

  private syncParticleProjection(): void {
    const size = this.engine.renderer.getDrawingBufferSize(this.drawSize);
    this.smoke.setProjection(size.y, this.engine.camera.fov);
  }

  private readonly drawSize = new THREE.Vector2();

  // --- Lifecycle -----------------------------------------------------------

  start(): void {
    this.engine.start();
  }

  setPhase(phase: GamePhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.hud.phase = phase;
    this.onPhaseChange?.(phase);
    if (phase === 'paused' || phase === 'menu') {
      this.audio.setIdle();
      this.input.releaseAll();
    }
  }

  get currentPhase(): GamePhase {
    return this.phase;
  }

  beginFreeRoam(): void {
    this.race.abandon();
    this.opponents.hide();
    this.setPhase('freeroam');
  }

  startRace(): void {
    this.race.beginCountdown();
    const heading = this.race.startTransform(this.scratchA, 0);
    this.vehicle.placeAt(this.scratchA.x, this.scratchA.z, heading);
    this.chaseCamera.reset(this.vehicle);
    this.opponents.reset(this.road, this.race.lapLength - 26);
    this.skids.clear();
    this.smoke.clear();
    this.lastCountdownTick = 4;
    this.setPhase('countdown');
  }

  returnToMenu(): void {
    this.race.abandon();
    this.opponents.hide();
    this.setCameraMode('cinematic');
    this.respawnOnRoad(0);
    this.setPhase('menu');
  }

  abandonRace(): void {
    this.race.abandon();
    this.opponents.hide();
    this.setPhase('freeroam');
  }

  pause(): void {
    if (this.phase === 'paused' || this.phase === 'menu') return;
    this.resumePhase = this.phase;
    this.setPhase('paused');
  }

  private resumePhase: GamePhase = 'freeroam';

  resume(): void {
    if (this.phase !== 'paused') return;
    this.setPhase(this.resumePhase);
  }

  // --- Configuration -------------------------------------------------------

  setCar(spec: CarSpec): void {
    this.carSpec = spec;
    this.vehicle.setSpec(spec);
    this.engine.scene.remove(this.carModel.group);
    this.carModel.dispose();
    this.carModel = new CarModel(spec, this.engine.quality.shadows);
    this.engine.scene.add(this.carModel.group);
    this.carModel.setShadowBlobVisible(!this.engine.quality.shadows);
  }

  setTimeOfDay(time: TimeOfDay): void {
    this.sky.setTimeOfDay(time);
  }

  applyQuality(tier: QualityTier): void {
    this.engine.setQuality(tier);
    this.sky.configureShadow(QUALITY[tier]);
    this.sky.setDrawDistance(QUALITY[tier].drawDistance);
    this.particleScale = QUALITY[tier].particleDensity;
    this.carModel.setShadowBlobVisible(!QUALITY[tier].shadows);
    this.hud.quality = tier;
  }

  setCameraMode(mode: CameraMode): void {
    this.chaseCamera.mode = mode;
    this.chaseCamera.reset(this.vehicle);
  }

  cycleCamera(): CameraMode {
    return this.chaseCamera.cycleMode();
  }

  async enableTilt(): Promise<boolean> {
    return this.input.enableTilt();
  }

  disableTilt(): void {
    this.input.disableTilt();
  }

  setMuted(muted: boolean): void {
    this.audio.setMuted(muted);
  }

  // --- Simulation ----------------------------------------------------------

  fixedUpdate(dt: number): void {
    if (this.phase === 'menu' || this.phase === 'paused') return;

    this.input.update(dt);

    if (this.input.consumeCamera()) this.chaseCamera.cycleMode();
    if (this.input.consumeReset()) this.respawnOnRoad();

    // The lights hold the car on the line; the throttle still revs the engine.
    const frozen = this.phase === 'countdown';

    this.road.query(this.vehicle.position.x, this.vehicle.position.z, this.roadHit);
    this.vehicle.setOffRoad(this.roadHit.dist > this.road.halfWidth + this.road.shoulder);

    this.vehicle.update(
      dt,
      this.input.steer,
      this.input.throttle,
      this.input.brake,
      !frozen && this.input.handbrake,
      frozen,
    );

    this.keepInsideMap();

    const progress = this.race.progressFor(this.vehicle.position.x, this.vehicle.position.z);
    this.opponents.update(dt, this.road, this.terrain, progress, this.phase === 'racing');
    this.opponents.resolveOverlap(
      this.vehicle.position.x,
      this.vehicle.position.z,
      (dx, dz) => this.vehicle.applyPush(dx, dz),
    );

    this.updateRace(dt);
    this.updateDriftChain(dt);

    if (this.vehicle.isStuck) {
      this.vehicle.clearStuck();
      this.respawnOnRoad();
    }
  }

  private updateRace(dt: number): void {
    if (this.phase !== 'countdown' && this.phase !== 'racing') return;

    const passed = this.race.update(
      dt,
      this.vehicle.position.x,
      this.vehicle.position.z,
      this.vehicle.position.y,
    );

    if (this.phase === 'countdown') {
      const tick = Math.ceil(this.race.countdown);
      if (tick < this.lastCountdownTick) {
        this.lastCountdownTick = tick;
        this.audio.blip(tick > 0 ? 620 : 1080, tick > 0 ? 0.14 : 0.5, 0.3);
      }
      if (this.race.state === 'running') this.setPhase('racing');
      return;
    }

    if (passed) this.audio.blip(1180, 0.12, 0.22);

    if (this.race.state === 'finished') {
      this.race.finishPosition = this.opponents.playerPosition(
        this.race.progressFor(this.vehicle.position.x, this.vehicle.position.z),
      );
      this.audio.blip(880, 0.7, 0.3);
      this.hud.bestTime = this.race.bestTime;
      this.hud.lastTime = this.race.lastTime;
      this.setPhase('finished');
    }
  }

  private updateDriftChain(dt: number): void {
    const v = this.vehicle;
    const drifting = v.isDrifting && v.grounded && v.speed > 10;
    if (drifting) {
      // Reward angle and speed together: a fast, shallow slide and a slow,
      // lurid one both score, a slow shallow one does not.
      const angle = clamp01((Math.abs(v.slipAngle) - 0.14) / 0.6);
      this.driftChain += angle * v.speed * dt * 1.9;
      this.driftIdle = 0;
    } else {
      this.driftIdle += dt;
      if (this.driftIdle > DRIFT_BANK_DELAY && this.driftChain > 0) {
        this.bankedScore += Math.round(this.driftChain);
        this.driftChain = 0;
      }
    }
  }

  private keepInsideMap(): void {
    const limit = MAP_HALF - 40;
    const p = this.vehicle.position;
    const r = Math.hypot(p.x, p.z);
    if (r > limit) {
      const k = limit / r;
      p.x *= k;
      p.z *= k;
      this.vehicle.forwardSpeed *= 0.6;
    }
  }

  /** Puts the car back on the tarmac facing the right way. */
  respawnOnRoad(index?: number): void {
    let i = index;
    if (i === undefined) {
      this.road.query(this.vehicle.position.x, this.vehicle.position.z, this.roadHit);
      i = this.roadHit.index;
    }
    this.road.positionAt(i, this.scratchA);
    this.vehicle.placeAt(this.scratchA.x, this.scratchA.z, this.road.headingAt(i));
    this.vehicle.position.y += RESPAWN_CLEARANCE;
    this.chaseCamera.reset(this.vehicle);
    this.skids.clear();
  }

  // --- Per-frame -----------------------------------------------------------

  frameUpdate(dt: number, alpha: number): void {
    const yaw = this.vehicle.getRenderTransform(alpha, this.renderPos);

    this.carModel.group.position.copy(this.renderPos);
    this.carModel.group.rotation.y = yaw;
    const ground = this.terrain.heightAt(this.renderPos.x, this.renderPos.z);
    this.carModel.updateVisuals(
      this.vehicle.steerAngle,
      this.vehicle.wheelSpin,
      this.vehicle.bodyPitch,
      this.vehicle.bodyRoll,
      this.input.brake,
      this.sky.isNight,
      ground,
    );

    this.chaseCamera.update(
      dt,
      this.vehicle,
      this.engine.camera,
      this.terrain,
      this.renderPos,
      yaw,
    );
    this.sky.update(this.engine.camera.position, this.renderPos);

    this.syncParticleProjection();
    this.emitTyreEffects(dt, yaw);
    this.smoke.update(dt);
    this.skids.update(dt);

    if (this.phase !== 'paused' && this.phase !== 'menu') {
      this.audio.update(
        this.vehicle.rpm01,
        this.input.throttle,
        this.vehicle.speed,
        this.vehicle.slipAngle,
        this.vehicle.offRoad,
        this.vehicle.grounded,
      );
    }

    this.syncHud();
  }

  /**
   * Smoke and rubber come off the rear wheels whenever they are sliding, and
   * dust comes off all four off-road. Emission is rate-limited rather than
   * per-frame so the look does not change with framerate.
   */
  private emitTyreEffects(dt: number, yaw: number): void {
    const v = this.vehicle;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    // Body axes in world space.
    const fx = sin;
    const fz = cos;
    const rx = cos;
    const rz = -sin;

    const slip = Math.abs(v.slipAngle);
    const sliding = v.grounded && v.speed > 6 && (slip > 0.15 || this.input.handbrake);
    const dusty = v.grounded && v.offRoad && v.speed > 7;

    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const wx = this.renderPos.x + rx * 0.88 * side - fx * 1.34;
      const wz = this.renderPos.z + rz * 0.88 * side - fz * 1.34;
      const wy = this.terrain.heightAt(wx, wz);

      if (sliding && !v.offRoad) {
        // Contact patch edges, perpendicular to the direction of travel.
        const halfPatch = 0.16;
        this.skids.extend(
          i,
          wx + rx * halfPatch, wy, wz + rz * halfPatch,
          wx - rx * halfPatch, wy, wz - rz * halfPatch,
          clamp01((slip - 0.13) * 2.4) * 0.85,
        );
      } else {
        this.skids.breakTrail(i);
      }
    }

    if (!sliding && !dusty) {
      this.smokeTimer = 0;
      return;
    }

    const intensity = dusty
      ? clamp01((v.speed - 8) / 45) * 0.55
      : clamp01((slip - 0.13) * 2.2);
    const rate = 20 * intensity * this.particleScale;
    this.smokeTimer += dt * rate;

    let budget = 3;
    while (this.smokeTimer >= 1 && budget-- > 0) {
      this.smokeTimer -= 1;
      const side = Math.random() < 0.5 ? 1 : -1;
      const wx = this.renderPos.x + rx * 0.88 * side - fx * 1.34;
      const wz = this.renderPos.z + rz * 0.88 * side - fz * 1.34;
      const wy = this.terrain.heightAt(wx, wz) + 0.16;
      const spread = 1.6;
      const tint = v.offRoad ? 1 : 0;
      this.smoke.spawn(
        wx + (Math.random() - 0.5) * 0.5,
        wy,
        wz + (Math.random() - 0.5) * 0.5,
        -fx * v.speed * 0.1 + (Math.random() - 0.5) * spread,
        0.6 + Math.random() * 0.9,
        -fz * v.speed * 0.1 + (Math.random() - 0.5) * spread,
        0.5 + Math.random() * 0.45,
        v.offRoad ? 0.8 : 1.05,
        tint ? 0.60 : 0.80,
        tint ? 0.51 : 0.80,
        tint ? 0.38 : 0.82,
        0.5,
      );
    }
  }

  private syncHud(): void {
    const h = this.hud;
    const v = this.vehicle;
    h.speedKmh = Math.abs(v.speedKmh);
    h.rpm01 = v.rpm01;
    h.gear = v.gear;
    h.carX = v.position.x;
    h.carZ = v.position.z;
    h.carHeading = v.yaw;
    h.offRoad = v.offRoad;

    h.checkpoint = Math.min(this.race.currentGate, this.race.gateCount);
    h.raceTime = this.race.time;
    h.countdown = this.race.countdown;
    h.bestTime = this.race.bestTime;
    h.lastTime = this.race.lastTime;
    h.position =
      this.phase === 'finished'
        ? this.race.finishPosition
        : this.opponents.playerPosition(this.race.progressFor(v.position.x, v.position.z));

    h.driftChain = Math.round(this.driftChain);
    h.driftScore = Math.round(this.bankedScore + this.driftChain);
    h.bankedScore = this.bankedScore;
    h.driftActive = this.driftChain > 0;

    if (this.phase === 'freeroam') {
      const d = this.race.distanceToStart(v.position.x, v.position.z, this.scratchB);
      h.nearStartGate = d < 42 && v.speed < 14;
    } else {
      h.nearStartGate = false;
    }

    h.fps = this.engine.fps;
    h.resolutionScale = this.engine.getResolutionScale();
  }

  /** Exposed for the minimap: the route as a flat polyline. */
  getRoutePolyline(step = 6): Float32Array {
    const n = Math.floor(this.road.count / step);
    const out = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      out[i * 2] = this.road.px[i * step];
      out[i * 2 + 1] = this.road.pz[i * step];
    }
    return out;
  }

  getGatePositions(): Float32Array {
    const gates = this.race.gates;
    const out = new Float32Array(gates.length * 2);
    for (let i = 0; i < gates.length; i++) {
      out[i * 2] = gates[i].x;
      out[i * 2 + 1] = gates[i].z;
    }
    return out;
  }

  get mapHalfExtent(): number {
    return MAP_HALF;
  }

  /** Used by the diagnostics overlay. */
  get renderInfo(): { calls: number; triangles: number } {
    const info = this.engine.renderer.info.render;
    return { calls: info.calls, triangles: info.triangles };
  }

  dispose(): void {
    window.removeEventListener('resize', this.handleResize);
    this.input.detach();
    this.audio.dispose();
    this.engine.stop();
    this.opponents.dispose();
    this.carModel.dispose();
    this.race.dispose();
    this.scenery.dispose();
    this.terrain.dispose();
    this.sky.dispose();
    this.smoke.dispose();
    this.skids.dispose();
    this.engine.dispose();
  }
}

export const driftGradeFor = (score: number): string => {
  if (score > 24000) return 'LEGENDARY';
  if (score > 12000) return 'INSANE';
  if (score > 6000) return 'WILD';
  if (score > 2500) return 'GREAT';
  if (score > 800) return 'NICE';
  return 'DRIFT';
};
