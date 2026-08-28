import * as THREE from 'three';
import { EngineAudio } from './audio/engineAudio';
import { CarModel } from './car/carModel';
import { Vehicle } from './car/vehicle';
import { Engine, type EngineHooks } from './engine/Engine';
import { Input } from './engine/input';
import { clamp01 } from './engine/math';
import { ChaseCamera } from './fx/camera';
import { SkidMarks, SmokeSystem } from './fx/particles';
import { OpponentField, type RivalResult } from './race/opponents';
import { TrafficField } from './race/traffic';
import { eventById, Race, type RaceEvent } from './race/route';
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
import { Grass } from './world/grass';
import { Scenery } from './world/scenery';
import { Sky, type TimeOfDay } from './world/sky';
import { Terrain } from './world/terrain';
import { Trackside } from './world/trackside';
import { findLakeSite, Water, type LakeSite } from './world/water';

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
  private trackside: Trackside;
  private grass: Grass;
  private water: Water | null = null;
  private lake: LakeSite | null = null;
  private sky: Sky;
  private vehicle: Vehicle;
  private carModel: CarModel;
  private opponents: OpponentField;
  private traffic: TrafficField;
  private race: Race;
  private chaseCamera = new ChaseCamera();
  private smoke: SmokeSystem;
  private skids: SkidMarks;

  private phase: GamePhase = 'menu';
  private carSpec: CarSpec = CARS[0];

  // Nitro.
  private nitro = 0;
  private wasBoosting = false;

  /** Buzz the phone, if the platform has a motor and the user allows it. */
  hapticsEnabled = true;

  private vibrate(ms: number): void {
    if (!this.hapticsEnabled) return;
    try {
      navigator.vibrate?.(ms);
    } catch {
      // No motor, no permission — fine.
    }
  }

  // Free-roam drift chain.
  private driftChain = 0;
  private driftIdle = 0;
  private bankedScore = 0;

  private smokeTimer = 0;
  private flameTimer = 0;
  private lastCountdownTick = 4;
  private lastGear = 1;
  /** Keeps ticking after the player finishes, until every rival crosses. */
  private rivalClock = 0;
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
    this.lake = findLakeSite(this.road);
    this.terrain = new Terrain(this.road, this.lake);
    this.scenery = new Scenery(
      this.road,
      this.terrain,
      this.engine.quality,
      this.lake ? this.lake.level : null,
    );
    this.trackside = new Trackside(this.road, this.terrain);
    this.scenery.registerColliders(this.trackside.colliders);
    this.grass = new Grass(this.road, this.terrain, this.lake ? this.lake.level : null);
    this.grass.setVisible(this.engine.quality.tier === 'high');
    this.sky = new Sky(this.engine.scene, this.engine.renderer, this.engine.quality);

    this.engine.scene.add(this.terrain.group);
    this.engine.scene.add(this.road.buildMesh());
    this.engine.scene.add(this.scenery.group);
    this.engine.scene.add(this.trackside.group);
    this.engine.scene.add(this.grass.group);
    if (this.lake) {
      this.water = new Water(this.lake);
      this.engine.scene.add(this.water.mesh);
    }

    this.vehicle = new Vehicle(this.carSpec, this.terrain);
    this.carModel = new CarModel(this.carSpec, this.engine.quality.shadows);
    this.engine.scene.add(this.carModel.group);

    this.race = new Race(this.road);
    this.engine.scene.add(this.race.group);

    this.opponents = new OpponentField(this.engine.quality);
    this.engine.scene.add(this.opponents.group);

    this.traffic = new TrafficField();
    this.engine.scene.add(this.traffic.mesh);

    this.smoke = new SmokeSystem(260);
    this.skids = new SkidMarks(420);
    this.engine.scene.add(this.smoke.points);
    this.engine.scene.add(this.skids.mesh);
    this.syncParticleProjection();
    window.addEventListener('resize', this.handleResize, { passive: true });

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

  setEvent(id: string): void {
    const event = eventById(id);
    if (this.race.event.id === event.id) return;
    if (this.phase === 'countdown' || this.phase === 'racing') return;
    this.race.configure(event);
    this.hud.eventId = event.id;
    this.hud.bestTime = this.race.bestTime;
    this.hud.lastTime = null;
  }

  get currentEvent(): RaceEvent {
    return this.race.event;
  }

  bestTimeFor(eventId: string): number | null {
    return this.race.bestFor(eventId);
  }

  startRace(): void {
    this.race.beginCountdown();
    const heading = this.race.startTransform(this.scratchA, 0);
    this.vehicle.placeAt(this.scratchA.x, this.scratchA.z, heading);
    this.chaseCamera.reset(this.vehicle);
    this.opponents.reset(this.road, this.race.startDistance, this.race.direction);
    this.rivalClock = 0;
    this.skids.clear();
    this.smoke.clear();
    this.lastCountdownTick = 4;
    this.setPhase('countdown');
  }

  returnToMenu(): void {
    this.race.abandon();
    this.opponents.hide();
    // fixedUpdate does not run in the menu, so retire the traffic here or its
    // frozen cars would haunt the cinematic backdrop.
    this.traffic.setActive(false, this.road, 0);
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

  /** Whether the pause menu should offer a race restart. */
  get pausedFromRace(): boolean {
    return this.resumePhase === 'racing' || this.resumePhase === 'countdown';
  }

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
    this.grass.setVisible(tier === 'high');
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

  setMusic(on: boolean): void {
    this.audio.setMusicEnabled(on);
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

    this.updateNitro(dt, frozen);

    this.vehicle.update(
      dt,
      this.input.steer,
      this.input.throttle,
      this.input.brake,
      !frozen && this.input.handbrake,
      frozen,
    );

    this.keepInsideMap();
    if (this.lake && this.vehicle.position.y < this.lake.level - 0.5) {
      // Into the drink: fish the car out and put it back on the road.
      this.audio.impact(0.5);
      this.respawnOnRoad();
    }
    this.resolveSceneryCollisions();
    this.updateTraffic(dt);

    const progress = this.race.progressFor(this.vehicle.position.x, this.vehicle.position.z);
    // Rivals keep racing after the player finishes so the results screen can
    // show real crossing times, then freeze once the last one is home.
    const rivalsRunning =
      this.phase === 'racing' || (this.phase === 'finished' && !this.opponents.allFinished);
    if (this.phase === 'racing' || this.phase === 'finished') {
      if (rivalsRunning) this.rivalClock += dt;
      this.opponents.recordFinishes(this.rivalClock, this.race.raceDistance);
    }
    this.opponents.update(dt, this.road, this.terrain, progress, rivalsRunning);
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

  /** Meter charges from driving well and burns while the button is held. */
  private updateNitro(dt: number, frozen: boolean): void {
    const v = this.vehicle;
    if (v.isDrifting && v.grounded) this.nitro += dt * 0.09;
    if (!v.grounded && v.airTime > 0.25) this.nitro += dt * 0.14;
    this.nitro = clamp01(this.nitro);

    const wantBoost = this.input.nitro && !frozen && this.nitro > 0.02 && v.grounded;
    v.boosting = wantBoost;
    if (wantBoost) {
      this.nitro = Math.max(0, this.nitro - dt * 0.27);
      if (!this.wasBoosting) {
        this.audio.whoosh();
        this.vibrate(30);
      }
    }
    this.wasBoosting = wantBoost;
  }

  /** Circle-vs-circle against the static collider grid; allocation-free. */
  private resolveSceneryCollisions(): void {
    const grid = this.scenery.colliders;
    const p = this.vehicle.position;
    const carR = 1.0;
    const cx = grid.cellIndex(p.x);
    const cz = grid.cellIndex(p.z);

    for (let gz = Math.max(0, cz - 1); gz <= Math.min(grid.dim - 1, cz + 1); gz++) {
      for (let gx = Math.max(0, cx - 1); gx <= Math.min(grid.dim - 1, cx + 1); gx++) {
        const c = gz * grid.dim + gx;
        const start = grid.cellStart[c];
        const end = grid.cellStart[c + 1];
        for (let k = start; k < end; k++) {
          const i = grid.cellItems[k];
          const dx = p.x - grid.x[i];
          const dz = p.z - grid.z[i];
          const minD = grid.radius[i] + carR;
          const d2 = dx * dx + dz * dz;
          if (d2 >= minD * minD || d2 < 1e-8) continue;
          const d = Math.sqrt(d2);
          const nx = dx / d;
          const nz = dz / d;

          if (grid.hard[i] === 1) {
            p.x = grid.x[i] + nx * minD;
            p.z = grid.z[i] + nz * minD;
            const impact = this.vehicle.collideNormal(nx, nz);
            if (impact > 3.5) {
              const intensity = clamp01(impact / 25);
              this.audio.impact(intensity);
              this.chaseCamera.addImpulse(0.08 + intensity * 0.3);
              this.vibrate(Math.round(20 + intensity * 60));
              // A real crunch also ends any drift chain.
              if (impact > 9) this.driftChain = 0;
            }
          } else {
            this.vehicle.applySoftDrag(1 / 120, 2.6);
          }
        }
      }
    }
  }

  private updateTraffic(dt: number): void {
    const wantTraffic = this.phase === 'freeroam';
    const playerArc = this.road.cum[this.roadHit.index];
    this.traffic.setActive(wantTraffic, this.road, playerArc);
    if (!this.traffic.isActive) return;

    const v = this.vehicle;
    const nearMisses = this.traffic.update(
      dt,
      this.road,
      this.terrain,
      v.position.x,
      v.position.z,
      playerArc,
      v.speed,
    );
    for (let i = 0; i < nearMisses; i++) {
      this.driftChain += 120;
      this.driftIdle = 0;
      this.nitro = clamp01(this.nitro + 0.16);
      this.audio.swish();
      this.vibrate(18);
    }

    this.traffic.resolveCollision(v.position.x, v.position.z, (nx, nz, pushX, pushZ) => {
      v.position.x += pushX;
      v.position.z += pushZ;
      const impact = v.collideNormal(nx, nz);
      if (impact > 3) {
        const intensity = clamp01(impact / 22);
        this.audio.impact(intensity);
        this.chaseCamera.addImpulse(0.1 + intensity * 0.3);
        this.vibrate(Math.round(25 + intensity * 60));
      }
    });
  }

  private updateRace(dt: number): void {
    if (this.phase !== 'countdown' && this.phase !== 'racing') return;

    if (this.phase === 'racing') this.rivalClock = this.race.time;

    const passed = this.race.update(
      dt,
      this.vehicle.position.x,
      this.vehicle.position.z,
      this.vehicle.position.y,
      this.road.cum[this.roadHit.index],
      this.roadHit.dist,
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

    if (passed) {
      this.audio.blip(1180, 0.12, 0.22);
      this.vibrate(24);
    }

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
        if (this.driftChain > 300) this.vibrate(20);
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
    // In a reverse-direction event the road's sample order points backwards.
    const againstSamples =
      this.race.direction === -1 &&
      (this.phase === 'racing' || this.phase === 'countdown');
    const heading = this.road.headingAt(i) + (againstSamples ? Math.PI : 0);
    this.vehicle.placeAt(this.scratchA.x, this.scratchA.z, heading);
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
    this.sky.update(dt, this.engine.camera.position, this.renderPos);
    this.water?.update(dt, this.sky.sunDirection);

    this.syncParticleProjection();
    this.emitTyreEffects(dt, yaw);
    this.smoke.update(dt);
    this.skids.update(dt);

    if (this.vehicle.gear !== this.lastGear) {
      if (this.phase === 'racing' || this.phase === 'freeroam') {
        this.audio.blip(this.vehicle.gear > this.lastGear ? 340 : 250, 0.06, 0.08);
      }
      this.lastGear = this.vehicle.gear;
    }

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

    if (v.boosting && v.grounded) {
      // Twin exhaust flames: short, hot, blue.
      this.flameTimer += dt * 48 * this.particleScale;
      let flames = 3;
      while (this.flameTimer >= 1 && flames-- > 0) {
        this.flameTimer -= 1;
        const side = Math.random() < 0.5 ? 1 : -1;
        const wx = this.renderPos.x + rx * 0.45 * side - fx * 2.2;
        const wz = this.renderPos.z + rz * 0.45 * side - fz * 2.2;
        const wy = this.renderPos.y + 0.55;
        this.smoke.spawn(
          wx, wy, wz,
          -fx * v.speed * 0.55 + (Math.random() - 0.5) * 0.8,
          0.4 + Math.random() * 0.5,
          -fz * v.speed * 0.55 + (Math.random() - 0.5) * 0.8,
          0.55 + Math.random() * 0.3,
          0.28,
          0.55, 0.75, 1.0,
          0.85,
        );
      }
    } else {
      this.flameTimer = 0;
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
        0.34,
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
    h.checkpointTotal = this.race.gateCount;
    h.eventId = this.race.event.id;
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

    h.nitro01 = this.nitro;
    h.boosting = this.vehicle.boosting;
    h.rivalCount = this.opponents.writePositions(h.rivals);
    h.wrongWay = this.isWrongWay();

    h.fps = this.engine.fps;
    h.resolutionScale = this.engine.getResolutionScale();
  }

  /** True while racing with the car clearly pointed against the route. */
  private isWrongWay(): boolean {
    if (this.phase !== 'racing') return false;
    const v = this.vehicle;
    if (v.forwardSpeed < 4) return false;
    const i = this.roadHit.index;
    const along =
      Math.sin(v.yaw) * this.road.tx[i] + Math.cos(v.yaw) * this.road.tz[i];
    return along * this.race.direction < -0.35;
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

  /** Live view of the active event's gates; mutated in place on event change. */
  get gatePositions(): Float32Array {
    return this.race.gatePositions;
  }

  rivalResults(): RivalResult[] {
    return this.opponents.results();
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
    this.traffic.dispose();
    this.carModel.dispose();
    this.race.dispose();
    this.scenery.dispose();
    this.trackside.dispose();
    this.grass.dispose();
    this.water?.dispose();
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
