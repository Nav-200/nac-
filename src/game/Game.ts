/**
 * Game orchestrator: owns the scene, the world, the fixed-step simulation loop and every
 * gameplay system, and bridges them to the React HUD and the debug API.
 */
import * as THREE from 'three';
import { audio } from './audio/audioEngine';
import type { BoxCollider } from './core/collision';
import {
  DAY_LENGTH_SEC,
  DEATH_MONEY_LOSS_FRAC,
  FIXED_DT,
  MAX_SUBSTEPS,
  SAVE_KEY,
  START_TIME_OF_DAY,
  VEHICLE_ENTER_RANGE,
  WORLD_HALF,
} from './core/constants';
import { InputManager, type InputState } from './core/input';
import { clamp, formatClock } from './core/mathUtils';
import { store, type GamePhase } from './core/store';
import { DISTRICT_NAMES, VEHICLE_SPECS, WEAPON_SPECS, type GameEvent, type PropRecord, type VehicleType, type WeaponId, type WorldData } from './core/types';
import { installDebugApi, type GameDebugApi } from './debugApi';
import { Player } from './entities/player';
import type { Pedestrian } from './entities/pedestrian';
import type { Vehicle } from './entities/vehicle';
import { DynamicWorld } from './physics/dynamicWorld';
import { StaticWorld } from './physics/staticWorld';
import { EffectsSystem } from './render/effects';
import { EntityViews } from './render/entityViews';
import { SceneSetup } from './render/sceneSetup';
import { WorldRenderer } from './render/worldRenderer';
import { CameraController } from './systems/camera';
import { CombatSystem, type ShotResult } from './systems/combat';
import { MissionSystem } from './systems/missions';
import { PedestrianSystem } from './systems/pedestrians';
import { PickupSystem, RESPRAY_PRICE, type PickupInstance } from './systems/pickups';
import { PoliceSystem } from './systems/police';
import { TrafficSystem } from './systems/traffic';
import { setUiBridge, type MinimapBlip, type MinimapState, type UiBridge, type UiSettings } from './ui/uiBridge';
import { generateCity } from './world/cityGen';
import { GridRoadNetwork } from './world/roadNetwork';

export interface GameOptions {
  seed?: number;
  shadows?: boolean;
  pixelRatio?: number;
}

interface SaveData {
  version: number;
  money: number;
  stats: Player['stats'];
  weapons: Player['weapons'];
  currentWeapon: WeaponId;
  completed: [string, number][];
  timeOfDay: number;
  settings: UiSettings;
  playTime: number;
}

const DEFAULT_SETTINGS: UiSettings = { sensitivity: 1, shadows: true, quality: 'high', masterVolume: 0.8, sfxVolume: 1, musicVolume: 0.7, invertY: false, showFps: false };

interface BrokenHydrant {
  x: number;
  z: number;
  until: number;
}

export class Game {
  readonly canvas: HTMLCanvasElement;
  readonly input = new InputManager();
  scene!: SceneSetup;
  world!: WorldData;
  statics!: StaticWorld;
  dynamics!: DynamicWorld;
  worldRenderer!: WorldRenderer;
  effects!: EffectsSystem;
  views!: EntityViews;
  cameraCtl = new CameraController();
  player = new Player();
  traffic!: TrafficSystem;
  peds!: PedestrianSystem;
  combat!: CombatSystem;
  police!: PoliceSystem;
  pickups!: PickupSystem;
  missions!: MissionSystem;
  debug!: GameDebugApi;
  settings: UiSettings = { ...DEFAULT_SETTINGS };

  /** Simulation time in seconds since start (advances only while playing). */
  time = 0;
  timeOfDay = START_TIME_OF_DAY;
  frame = 0;
  playTime = 0;
  private accumulator = 0;
  private lastNow = 0;
  private rafId = 0;
  private freeCam = false;
  private freeCamPos = new THREE.Vector3(-20, 60, -80);
  private freeCamTarget = new THREE.Vector3(0, 0, 0);
  private hudTimer = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private disposed = false;
  private events: GameEvent[] = [];
  private propByCollider = new Map<number, PropRecord>();
  private brokenHydrants: BrokenHydrant[] = [];
  private waypoint: { x: number; z: number } | null = null;
  private route: number[] = [];
  private routeTimer = 0;
  private roads!: GridRoadNetwork;
  private saveTimer = 0;
  private deathTimer = 0;
  private started = false;
  private interactPrompt = '';
  private hitMarker = 0;
  private damageFlash = 0;
  private lastFootstepTime = 0;
  private aimTrace: ShotResult | null = null;
  private aimRay = { ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: 1 };
  private minimapBlips: MinimapBlip[] = [];
  private minimapState: MinimapState = { x: 0, z: 0, yaw: 0, camYaw: 0, inVehicle: false, blips: this.minimapBlips, route: [], waypoint: null, wanted: 0, zoomRadius: 110 };
  private nearbyEngineIds = new Set<number>();
  private sirenIds = new Set<number>();
  private muzzleAnchor = new THREE.Vector3();
  private lastVehicleAudio = 0;
  private wantedForSound = 0;
  /** Rolling averages of CPU time per frame (ms) for the debug API. */
  private simMsAvg = 0;
  private renderMsAvg = 0;

  constructor(canvas: HTMLCanvasElement, private opts: GameOptions = {}) {
    this.canvas = canvas;
  }

  // ------------------------------------------------------------------ boot
  async init(): Promise<void> {
    const setLoading = async (p: number, text: string) => {
      store.set('loading', p);
      store.set('loadingText', text);
      store.commit();
      await new Promise((r) => setTimeout(r, 0));
    };
    this.loadSettings();
    await setLoading(0.05, 'Creating renderer…');
    this.scene = new SceneSetup(this.canvas, { shadows: this.opts.shadows ?? this.settings.shadows, pixelRatio: this.opts.pixelRatio ?? (this.settings.quality === 'low' ? 1 : undefined) });
    await setLoading(0.15, 'Laying out the city…');
    this.world = generateCity(this.opts.seed ?? 1337);
    this.roads = this.world.roads as GridRoadNetwork;
    for (const p of this.world.props) if (p.collider) this.propByCollider.set(p.collider.id, p);
    await setLoading(0.35, 'Pouring concrete…');
    this.statics = new StaticWorld(this.world);
    this.dynamics = new DynamicWorld();
    await setLoading(0.5, 'Raising skyscrapers…');
    this.worldRenderer = new WorldRenderer(this.world);
    this.scene.scene.add(this.worldRenderer.root);
    await setLoading(0.72, 'Hiring pedestrians…');
    this.effects = new EffectsSystem();
    this.scene.scene.add(this.effects.root);
    this.views = new EntityViews(this.scene.scene);
    this.views.createPlayer();
    this.traffic = new TrafficSystem(this.world, this.statics, this.dynamics, {
      onSpawn: (v) => this.views.addVehicle(v),
      onDespawn: (v) => {
        this.views.removeVehicle(v);
        audio.removeEngine(v.id);
        audio.removeSiren(v.id);
        audio.removeSkid(v.id);
        this.effects.removeFire(v.id);
        this.effects.removeSmokeTrail(v.id);
      },
      onDriverFlee: (v) => this.peds.bailOut(v, this.time),
      playerPos: () => ({ x: this.player.x, z: this.player.z, onFoot: !this.player.vehicle }),
    });
    this.traffic.onPropHit = (c, impact) => this.vehiclePropHit(c, impact);
    this.peds = new PedestrianSystem(this.world, this.statics, this.dynamics, {
      onSpawn: (p) => this.views.addPed(p),
      onDespawn: (p) => {
        this.views.removePed(p);
        this.traffic.clearDriver(p);
      },
      playerPos: () => ({ x: this.player.x, z: this.player.z }),
    });
    this.combat = new CombatSystem(this.world, this.statics, this.dynamics, { damageProp: (c, amount, byPlayer) => this.damageProp(c, amount, byPlayer) });
    this.police = new PoliceSystem(this.world, this.statics, this.dynamics, this.traffic, this.peds, this.combat);
    this.pickups = new PickupSystem(this.world, {
      onStateChange: (item) => this.views.setPickup(item),
      notify: (text, kind) => store.notify(text, kind, 3.5, this.time),
    });
    for (const item of this.pickups.items) {
      this.views.setPickup(item);
      this.views.setPickupBaseY(item, this.world.groundHeightAt(item.spawn.x, item.spawn.z));
    }
    this.missions = new MissionSystem(this.world, this.statics, this.dynamics, this.traffic, this.peds, this.combat, {
      player: () => this.player,
      notify: (text, kind) => store.notify(text, kind, 4, this.time),
      bigText: (title, sub, color) => {
        store.bigText(title, sub, 4, this.time, color);
        audio.playUI(title.includes('PASSED') ? 'missionComplete' : title.includes('FAILED') ? 'missionFail' : 'missionStart');
        if (title.includes('PASSED')) this.save();
      },
      setWaypoint: (x, z) => this.setWaypoint(x, z, false),
      clearWaypoint: () => this.clearWaypoint(false),
      setObjective: (pos) => this.views.setObjective(pos, (x, z) => this.world.groundHeightAt(x, z)),
      time: () => this.time,
    });
    this.views.setMissionMarkers(this.missions.markers, (m) => this.missions.isMarkerActive(m, this.time), (x, z) => this.world.groundHeightAt(x, z));
    await setLoading(0.9, 'Turning on the lights…');
    this.scene.setTimeOfDay(this.timeOfDay);
    this.worldRenderer.setNight(this.scene.day.night);
    const sp = this.world.playerSpawn;
    this.player.setPosition(sp.x, sp.z, sp.yaw, this.world.groundHeightAt(sp.x, sp.z));
    this.cameraCtl.yaw = sp.yaw;
    this.cameraCtl.snapBehind(this.player);
    this.loadSave();
    this.input.attach(this.canvas, (locked) => {
      store.set('pointerLocked', locked);
      store.commit();
      if (!locked && store.hud.phase === 'playing' && this.started) this.pause();
    });
    this.input.sensitivity = this.settings.sensitivity;
    window.addEventListener('resize', this.onResize);
    setUiBridge(this.makeBridge());
    this.debug = installDebugApi(this);
    this.applyAudioSettings();
    await setLoading(1, 'Ready');
    // warm-up frames so the first real frame doesn't hitch
    this.scene.camera.position.set(sp.x - 6, 3, sp.z - 8);
    this.scene.camera.lookAt(sp.x, 1, sp.z);
    this.render(0.016);
    store.setPhase('menu');
    this.debug.ready = true;
    this.lastNow = performance.now();
    this.rafId = requestAnimationFrame(this.loop);
  }

  private onResize = (): void => this.scene.resize();

  // ------------------------------------------------------------------ phases
  get phase(): GamePhase {
    return store.hud.phase;
  }

  startGame(): void {
    const ph = store.hud.phase;
    audio.resume();
    if (ph === 'menu') {
      this.started = true;
      store.setPhase('playing');
      this.input.setEnabled(true);
      store.bigText('OPEN CITY', 'Welcome. Try not to die.', 4, this.time, '#f5b700');
      audio.playUI('notify');
    } else if (ph === 'paused' || ph === 'map' || ph === 'shop') {
      store.setPhase('playing');
      this.input.setEnabled(true);
      audio.setRadioAudible(!!this.player.vehicle);
    } else if (ph === 'dead' || ph === 'busted') {
      this.respawn();
    }
  }

  pause(): void {
    if (store.hud.phase !== 'playing') return;
    store.setPhase('paused');
    this.input.setEnabled(false);
    this.input.exitPointerLock();
    audio.setRadioAudible(false);
  }

  toggleMap(): void {
    const ph = store.hud.phase;
    if (ph === 'playing') {
      store.setPhase('map');
      this.input.setEnabled(false);
      this.input.exitPointerLock();
    } else if (ph === 'map') {
      this.startGame();
      this.input.requestPointerLock();
    }
  }

  openShop(): void {
    if (store.hud.phase !== 'playing') return;
    store.setPhase('shop');
    this.input.setEnabled(false);
    this.input.exitPointerLock();
    this.pickups.shopMessage = 'Welcome to Ammu-Nation.';
    store.set('shopMessage', this.pickups.shopMessage);
    store.commit();
    audio.playUI('click');
  }

  respawn(): void {
    const ph = store.hud.phase;
    const busted = ph === 'busted';
    const spot = busted && this.world.policeStations.length ? this.world.policeStations[0] : this.world.hospital;
    if (this.player.vehicle) {
      this.player.vehicle.playerDriving = false;
      this.player.vehicle.role = 'parked';
      this.player.vehicle = null;
    }
    this.player.entering = null;
    this.player.money = Math.max(0, Math.round(this.player.money * (1 - DEATH_MONEY_LOSS_FRAC)));
    if (busted) {
      for (const w of Object.keys(this.player.weapons) as WeaponId[]) if (w !== 'fist') this.player.weapons[w] = { clip: WEAPON_SPECS[w].clipSize, reserve: 0 };
    }
    // find a free spot around the spawn point
    let x = spot.x;
    let z = spot.z;
    for (let r = 0; r < 12; r++) {
      const ang = r * 1.3;
      const tx = spot.x + Math.cos(ang) * r * 0.9;
      const tz = spot.z + Math.sin(ang) * r * 0.9;
      if (this.statics.isFree(tx, tz, 0.6) && !this.world.isRoadAt(tx, tz)) {
        x = tx;
        z = tz;
        break;
      }
    }
    this.player.respawn(x, z, 0);
    this.player.y = this.world.groundHeightAt(x, z);
    this.police.clear();
    this.missions.abort(this.time);
    this.cameraCtl.snapBehind(this.player);
    this.deathTimer = 0;
    store.set('deathMessage', '');
    store.setPhase('playing');
    this.input.setEnabled(true);
    store.notify(busted ? 'Released from custody. Bail paid.' : 'Discharged from hospital.', 'info', 4, this.time);
    this.save();
  }

  newGame(): void {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      /* ignore */
    }
    location.reload();
  }

  // ------------------------------------------------------------------ loop
  private loop = (now: number): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.loop);
    const dtReal = Math.min(0.1, (now - this.lastNow) / 1000);
    this.lastNow = now;
    this.tick(dtReal);
  };

  /** Advance simulation + render once with a real-time delta. */
  tick(dtReal: number, doRender = true): void {
    const input = this.input.poll();
    this.handleGlobalKeys(input);
    const playing = store.hud.phase === 'playing';
    const t0 = performance.now();
    if (playing) {
      this.playTime += dtReal;
      this.accumulator += dtReal;
      let steps = 0;
      while (this.accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
        this.fixedUpdate(FIXED_DT, input, steps === 0);
        this.accumulator -= FIXED_DT;
        steps++;
      }
      if (steps === MAX_SUBSTEPS) this.accumulator = 0;
    }
    const t1 = performance.now();
    this.frame++;
    if (doRender) this.render(dtReal);
    const t2 = performance.now();
    this.simMsAvg += (t1 - t0 - this.simMsAvg) * 0.05;
    this.renderMsAvg += (t2 - t1 - this.renderMsAvg) * 0.05;
    // HUD refresh at ~12 Hz
    this.hudTimer += dtReal;
    this.fpsAcc += dtReal;
    this.fpsFrames++;
    if (this.hudTimer >= 0.08) {
      this.hudTimer = 0;
      store.set('fps', Math.round(this.fpsFrames / Math.max(1e-3, this.fpsAcc)));
      this.fpsAcc = 0;
      this.fpsFrames = 0;
      this.syncHud();
      store.pruneNotifications(this.time);
      store.commit();
    }
    this.saveTimer += dtReal;
    if (this.saveTimer > 30 && playing) {
      this.saveTimer = 0;
      this.save();
    }
  }

  /** Edge-triggered keys that work regardless of substeps. */
  private handleGlobalKeys(input: InputState): void {
    const ph = store.hud.phase;
    if (input.pause) {
      if (ph === 'playing') this.pause();
      else if (ph === 'paused' || ph === 'map' || ph === 'shop') {
        this.startGame();
        this.input.requestPointerLock();
      }
    }
    if (input.toggleMap && (ph === 'playing' || ph === 'map')) this.toggleMap();
    if (ph !== 'playing' || this.player.dead) return;
    if (input.toggleCamera) {
      this.cameraCtl.cycleMode();
      store.set('cameraMode', this.cameraCtl.mode);
    }
    if (input.toggleHeadlights && this.player.vehicle) this.player.vehicle.headlights = !this.player.vehicle.headlights;
    if (input.nextRadio && this.player.vehicle) {
      const n = audio.getRadioStation() + 1;
      audio.setRadioStation(n >= audio.constructor.length && n >= 4 ? -1 : n);
      store.notify(`Radio: ${audio.getRadioStationName()}`, 'info', 2.5, this.time);
    }
    if (input.interact) this.handleInteract();
    if (!this.player.vehicle) {
      if (input.nextWeapon) this.player.cycleWeapon(1);
      if (input.prevWeapon) this.player.cycleWeapon(-1);
      if (input.wheel !== 0) this.player.cycleWeapon(input.wheel > 0 ? 1 : -1);
      if (input.weaponSlot >= 0) this.player.selectSlot(input.weaponSlot);
      if (input.reload && this.player.startReload()) audio.playReload(this.player.currentWeapon);
    } else if (input.weaponSlot >= 0) {
      this.player.selectSlot(input.weaponSlot);
    }
  }

  /** Fixed-step simulation. */
  private fixedUpdate(dt: number, input: InputState, firstStep: boolean): void {
    this.time += dt;
    this.timeOfDay = (this.timeOfDay + dt / DAY_LENGTH_SEC) % 1;
    const events = this.events;
    events.length = 0;

    // Player
    this.player.update(dt, input, this.cameraCtl.yaw, this.world, this.statics, this.dynamics, this.time, events);
    if (input.fire && !this.player.dead && store.hud.phase === 'playing') this.handleFire(events);
    if (!input.fire && this.player.dead === false) {
      /* nothing */
    }
    // Keep the player inside the world
    this.player.x = clamp(this.player.x, -WORLD_HALF - 15, WORLD_HALF + 90);
    this.player.z = clamp(this.player.z, -WORLD_HALF - 15, WORLD_HALF + 15);

    // NPC systems (set vehicle controls before physics)
    this.police.update(dt, this.time, this.player, events);
    this.missions.update(dt, this.time, events);
    this.traffic.setNight(this.scene.day.night);
    this.traffic.update(dt, this.time, events);
    this.peds.update(dt, this.time, events, this.traffic.vehicles);
    this.combat.updateRockets(dt, this.player, events);
    this.pickups.update(dt, this.player, events);

    // Events → heat, alerts, audio, effects
    this.processEvents(events);

    // Death / busted transitions
    if (this.player.dead) {
      this.deathTimer += dt;
      if (store.hud.phase === 'playing' && this.deathTimer > 0.1) {
        store.set('deathMessage', this.deathMessageFor(this.player.deathCause));
        store.setPhase('dead');
        this.input.setEnabled(false);
        this.input.exitPointerLock();
        audio.playUI('wasted');
        audio.setRadioAudible(false);
      }
    } else if (this.police.busted && store.hud.phase === 'playing') {
      store.set('deathMessage', 'The cops caught up with you.');
      store.setPhase('busted');
      this.input.setEnabled(false);
      this.input.exitPointerLock();
      audio.playUI('busted');
      audio.setRadioAudible(false);
      this.player.dead = false;
    }

    // Broken hydrants spray
    for (let i = this.brokenHydrants.length - 1; i >= 0; i--) {
      const h = this.brokenHydrants[i];
      if (this.time > h.until) {
        this.brokenHydrants.splice(i, 1);
        continue;
      }
      if (firstStep) this.effects.spawnWaterSplash(h.x, 0.6, h.z, 1.4);
    }

    // Waypoint routing
    this.routeTimer -= dt;
    if (this.waypoint && this.routeTimer <= 0) {
      this.routeTimer = 1;
      this.computeRoute();
      if (Math.hypot(this.waypoint.x - this.player.x, this.waypoint.z - this.player.z) < 12 && !this.missions.active) {
        store.notify('You have reached your waypoint', 'info', 3, this.time);
        this.clearWaypoint(true);
      }
    }
    this.updateInteractPrompt();
    this.hitMarker = Math.max(0, this.hitMarker - dt);
    this.damageFlash = Math.max(0, this.damageFlash - dt * 2.2);
    this.views.setMissionMarkers(this.missions.markers, (m) => this.missions.isMarkerActive(m, this.time), (x, z) => this.world.groundHeightAt(x, z));
    if (this.player.stats.maxWanted < this.police.stars) this.player.stats.maxWanted = this.police.stars;
    if (this.player.vehicle && Math.abs(this.player.vehicle.speed) > 1) audio.setRadioAudible(true);
  }

  private deathMessageFor(cause: string): string {
    switch (cause) {
      case 'vehicle':
        return 'Run over by traffic.';
      case 'explosion':
        return 'Blown to pieces.';
      case 'drowning':
        return 'You should have learned to swim.';
      case 'shot':
        return 'Shot dead.';
      default:
        return 'Wasted.';
    }
  }

  // ------------------------------------------------------------------ interaction
  private updateInteractPrompt(): void {
    const p = this.player;
    let prompt = '';
    if (!p.dead && !p.entering) {
      if (p.vehicle) {
        if (this.pickups.garageNear(p) >= 0) prompt = `Press F to repair & respray ($${RESPRAY_PRICE})`;
        else prompt = Math.abs(p.vehicle.speed) < 8 ? 'Press F to exit' : '';
      } else if (this.pickups.shopNear(p) >= 0) prompt = 'Press F to enter Ammu-Nation';
      else {
        const v = this.traffic.nearestVehicle(p.x, p.z, VEHICLE_ENTER_RANGE, (veh) => !veh.destroyed);
        if (v) prompt = `Press F to ${v.role === 'traffic' || v.driver ? 'carjack' : 'enter'} the ${v.spec.name}`;
      }
    }
    this.interactPrompt = prompt;
  }

  private handleInteract(): void {
    const p = this.player;
    if (p.dead || p.entering) return;
    if (p.vehicle) {
      if (this.pickups.garageNear(p) >= 0) {
        this.repairVehicle();
        return;
      }
      if (Math.abs(p.vehicle.speed) < 8) {
        const v = p.vehicle;
        if (p.exitVehicle(this.statics, this.events)) {
          audio.playCarDoor();
          audio.removeSkid(v.id);
          audio.setRadioAudible(false);
        }
      }
      return;
    }
    if (this.pickups.shopNear(p) >= 0) {
      this.openShop();
      return;
    }
    const v = this.traffic.nearestVehicle(p.x, p.z, VEHICLE_ENTER_RANGE, (veh) => !veh.destroyed);
    if (!v) return;
    const occupied = v.role === 'traffic' || v.role === 'police' || !!v.driver;
    if (occupied) {
      // carjack: driver bails
      if (v.driver && !v.driver.dead) {
        const d = v.driver;
        const spots = v.exitPositions();
        const s = spots.find((q) => this.statics.isFree(q.x, q.z, 0.45)) ?? spots[1];
        d.setPosition(s.x, s.z, v.yaw);
        d.vehicle = null;
        d.setState(d.kind === 'cop' ? 'chase' : 'flee');
        d.panicX = p.x;
        d.panicZ = p.z;
        v.driver = null;
      } else if (v.role === 'traffic') {
        this.peds.bailOut(v, this.time);
      }
      v.role = 'parked';
      v.controls.throttle = 0;
      v.controls.brake = 0;
      this.events.push({ type: 'carjack', x: v.x, y: v.y, z: v.z, ref: v.id, byPlayer: true });
      p.stats.vehiclesStolen++;
    }
    v.controls.handbrake = false;
    p.beginEnterVehicle(v);
    audio.playCarDoor();
  }

  private repairVehicle(): void {
    const v = this.player.vehicle;
    if (!v) return;
    if (this.player.money < RESPRAY_PRICE) {
      store.notify('Not enough cash for a respray.', 'warning', 3, this.time);
      return;
    }
    this.player.addMoney(-RESPRAY_PRICE);
    v.health = v.maxHealth;
    v.burnTimer = -1;
    v.lastHitByPlayer = false;
    const palette = [0xc0392b, 0x2980b9, 0x27ae60, 0xf1c40f, 0x8e44ad, 0xe67e22, 0x111111, 0xecf0f1];
    v.colorHex = palette[Math.floor(Math.random() * palette.length)];
    this.police.clear();
    this.effects.removeFire(v.id);
    store.notify('Repaired and resprayed. The heat is off.', 'money', 4, this.time);
    audio.playUI('money');
  }

  // ------------------------------------------------------------------ firing
  private handleFire(events: GameEvent[]): void {
    const p = this.player;
    const spec = p.weaponSpec;
    if (p.vehicle) {
      if (!spec.driveBy) return;
    }
    if (p.entering) return;
    if (!p.canFire()) {
      if (spec.clipSize > 0 && p.currentSlot.clip <= 0 && !p.reloading) {
        if (p.startReload()) audio.playReload(spec.id);
        else if (p.fireCooldown <= 0) {
          audio.playEmptyClick();
          p.fireCooldown = 0.3;
        }
      }
      return;
    }
    // Aim through the camera crosshair
    this.cameraCtl.getAimRay(this.scene.camera, this.aimRay);
    const r = this.aimRay;
    const aimTarget = this.combat.trace(r.ox, r.oy, r.oz, r.dx, r.dy, r.dz, Math.max(spec.range, 60), 'player', p);
    let tx = aimTarget.x;
    let ty = aimTarget.y;
    let tz = aimTarget.z;
    if (aimTarget.kind === 'none') {
      tx = r.ox + r.dx * Math.max(spec.range, 60);
      ty = r.oy + r.dy * Math.max(spec.range, 60);
      tz = r.oz + r.dz * Math.max(spec.range, 60);
    }
    // Muzzle position
    const camYaw = this.cameraCtl.yaw;
    const rightX = -Math.cos(camYaw);
    const rightZ = Math.sin(camYaw);
    let mx = p.x + Math.sin(p.yaw) * 0.45 + rightX * -0.25;
    let my = p.y + 1.42;
    let mz = p.z + Math.cos(p.yaw) * 0.45 + rightZ * -0.25;
    if (p.vehicle) {
      const seat = { x: 0, y: 0, z: 0 };
      p.vehicle.seatPosition(seat);
      mx = seat.x + p.vehicle.rightX * -0.9;
      my = seat.y + 0.2;
      mz = seat.z + p.vehicle.rightZ * -0.9;
    }
    let dx = tx - mx;
    let dy = ty - my;
    let dz = tz - mz;
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len;
    dy /= len;
    dz /= len;
    // on foot, face the camera direction when shooting
    if (!p.vehicle) p.yaw = camYaw;

    if (spec.clipSize === 0) {
      p.consumeShot();
      const res = this.combat.melee(p.x, p.y, p.z, p.yaw, spec, 'player', p, this.time, events);
      audio.playMelee(p.x, p.y + 1, p.z);
      if (res.kind === 'ped' || res.kind === 'player') {
        this.hitMarker = 0.2;
        this.effects.spawnHitMarkerPuff(res.x, res.y, res.z);
        audio.playImpact('flesh', 0.8, res.x, res.y, res.z);
        if (res.killed) p.stats.kills++;
      } else if (res.kind === 'vehicle') {
        audio.playImpact('metal', 0.7, res.x, res.y, res.z);
        this.effects.spawnSparks(res.x, res.y, res.z, 6, dx, dz);
      } else if (res.kind === 'static') {
        audio.playImpact('concrete', 0.5, res.x, res.y, res.z);
      }
      return;
    }
    if (!p.consumeShot()) return;
    audio.playGunshot(spec.id, mx, my, mz);
    this.effects.spawnMuzzleFlash(mx, my, mz, dx, dy, dz, spec.id === 'shotgun' || spec.id === 'sniper');
    this.cameraCtl.addShake(spec.id === 'shotgun' ? 0.25 : spec.id === 'sniper' || spec.id === 'rpg' ? 0.35 : 0.06);
    if (spec.id === 'rpg') {
      this.combat.launchRocket(mx, my, mz, dx, dy, dz, spec, true);
      return;
    }
    const spreadMul = p.aiming ? 0.5 : p.vehicle ? 1.6 : 1;
    const results = this.combat.fireHitscan(mx, my, mz, dx, dy, dz, spec, 'player', p, this.time, events, spreadMul);
    for (const res of results) {
      this.effects.spawnTracer(mx, my, mz, res.x, res.y, res.z);
      this.spawnHitEffect(res, dx, dy, dz);
      if (res.kind === 'ped' || res.kind === 'vehicle') this.hitMarker = res.killed ? 0.35 : 0.18;
      if (res.killed) p.stats.kills++;
    }
  }

  private spawnHitEffect(res: ShotResult, dx: number, dy: number, dz: number): void {
    switch (res.kind) {
      case 'ped':
      case 'player':
        this.effects.spawnBlood(res.x, res.y, res.z, dx, dy, dz, res.headshot ? 2 : 1);
        audio.playImpact('flesh', 0.7, res.x, res.y, res.z);
        break;
      case 'vehicle':
        this.effects.spawnImpact('metal', res.x, res.y, res.z, res.nx, res.ny, res.nz);
        audio.playImpact('metal', 0.6, res.x, res.y, res.z);
        break;
      case 'static': {
        const kind = res.collider?.kind === 'tree' ? 'wood' : res.collider?.kind === 'lamp' ? 'metal' : res.ny > 0.5 ? 'ground' : 'concrete';
        this.effects.spawnImpact(kind, res.x, res.y, res.z, res.nx, res.ny, res.nz);
        audio.playImpact(kind === 'wood' ? 'wood' : kind === 'metal' ? 'metal' : 'concrete', 0.5, res.x, res.y, res.z);
        break;
      }
      default:
        break;
    }
  }

  // ------------------------------------------------------------------ props
  private damageProp(c: BoxCollider, amount: number, byPlayer: boolean): boolean {
    const prop = this.propByCollider.get(c.id);
    if (!prop || prop.health === null || prop.destroyed) return false;
    prop.health -= amount;
    if (prop.health > 0) return false;
    this.destroyProp(prop);
    void byPlayer;
    return true;
  }

  private destroyProp(prop: PropRecord): void {
    if (prop.destroyed) return;
    if (prop.collider) this.statics.removeCollider(prop.collider);
    this.worldRenderer.destroyProp(prop);
    const y = prop.y + 0.6;
    switch (prop.kind) {
      case 'hydrant':
        this.brokenHydrants.push({ x: prop.x, z: prop.z, until: this.time + 25 });
        this.effects.spawnWaterSplash(prop.x, y, prop.z, 3);
        audio.playImpact('metal', 1, prop.x, y, prop.z);
        break;
      case 'lamp':
      case 'trafficlight':
      case 'sign':
        this.effects.spawnSparks(prop.x, y + 2, prop.z, 18, 0, 0);
        this.effects.spawnDebris(prop.x, y, prop.z, 8);
        audio.playImpact('metal', 1, prop.x, y, prop.z);
        break;
      case 'bench':
      case 'crate':
      case 'fence':
        this.effects.spawnImpact('wood', prop.x, y, prop.z, 0, 1, 0);
        this.effects.spawnDebris(prop.x, y, prop.z, 10);
        audio.playImpact('wood', 1, prop.x, y, prop.z);
        break;
      default:
        this.effects.spawnDebris(prop.x, y, prop.z, 8);
        audio.playImpact('concrete', 0.8, prop.x, y, prop.z);
        break;
    }
  }

  private vehiclePropHit(c: BoxCollider, impact: number): boolean {
    const prop = this.propByCollider.get(c.id);
    if (!prop || prop.health === null || prop.destroyed) return false;
    if (impact < 2.5) return false;
    return this.damageProp(c, impact * 10, false);
  }

  // ------------------------------------------------------------------ events
  private processEvents(events: GameEvent[]): void {
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      this.police.handleEvent(e, this.time, this.player);
      switch (e.type) {
        case 'shotFired':
          this.peds.raiseAlert(e.x, e.z, 42, this.time, 0.9);
          if (!e.byPlayer) audio.playGunshot(e.ref as WeaponId, e.x, e.y, e.z);
          break;
        case 'pedKilled': {
          this.peds.raiseAlert(e.x, e.z, 26, this.time, 1);
          if (e.byPlayer) this.player.stats.kills += 0; // counted at the shot site
          break;
        }
        case 'pedHit':
          if (!e.byPlayer && e.value && e.value > 0) {
            /* NPC-on-NPC — nothing extra */
          }
          break;
        case 'explosion': {
          const radius = e.value ?? 6;
          this.effects.spawnExplosion(e.x, e.y, e.z, radius);
          audio.playExplosion(e.x, e.y, e.z);
          const d = Math.hypot(this.player.x - e.x, this.player.z - e.z);
          this.cameraCtl.addShake(clamp(1.2 - d / 60, 0, 1.2));
          const props = this.statics.query(e.x - radius, e.z - radius, e.x + radius, e.z + radius).filter((c) => c.kind !== 'building' && c.kind !== 'wall');
          this.combat.applyExplosion(e.x, e.y, e.z, radius, !!e.byPlayer, this.player, this.time, events, e.ref, props.slice());
          this.peds.raiseAlert(e.x, e.z, 80, this.time, 1);
          break;
        }
        case 'vehicleDestroyed':
          break;
        case 'impact': {
          const v = e.value ?? 0;
          if (e.ref === 'wantedUp') {
            audio.playUI('wantedUp');
            break;
          }
          if (v > 2) {
            audio.playCrash(clamp(v / 15, 0.15, 1), e.x, e.y, e.z);
            if (v > 4) this.effects.spawnSparks(e.x, e.y, e.z, Math.min(20, Math.round(v)), 0, 0);
            if (e.byPlayer) this.cameraCtl.addShake(clamp(v / 25, 0, 0.6));
            this.peds.raiseAlert(e.x, e.z, 14, this.time, 0.5);
          }
          break;
        }
        case 'pickup': {
          const kind = String(e.ref);
          audio.playPickup(kind === 'weapon' ? 'weapon' : kind === 'money' ? 'money' : kind === 'armor' ? 'armor' : 'health');
          this.effects.spawnPickupSparkle(e.x, e.y, e.z, kind === 'money' ? 0x4ade80 : kind === 'armor' ? 0x60a5fa : kind === 'health' ? 0xf87171 : 0xfbbf24);
          break;
        }
        case 'playerDamaged':
          this.damageFlash = Math.min(1, this.damageFlash + (e.value ?? 10) / 40);
          if ((e.value ?? 0) > 3) audio.playImpact('body', clamp((e.value ?? 0) / 40, 0.2, 1));
          break;
        case 'playerDied':
          this.cameraCtl.addShake(0.6);
          break;
        case 'carjack':
          break;
        case 'vehicleEntered':
          audio.setRadioAudible(true);
          break;
        case 'vehicleExited':
          audio.setRadioAudible(false);
          break;
        default:
          break;
      }
    }
    if (this.police.stars !== this.wantedForSound) {
      if (this.police.stars === 0 && this.wantedForSound > 0) audio.playUI('wantedClear');
      this.wantedForSound = this.police.stars;
    }
  }

  // ------------------------------------------------------------------ render
  private render(dt: number): void {
    const cam = this.scene.camera;
    const input = this.input.state;
    if (this.freeCam) {
      cam.position.copy(this.freeCamPos);
      cam.lookAt(this.freeCamTarget);
    } else if (this.started || store.hud.phase !== 'boot') {
      const camInput = store.hud.phase === 'playing' ? input : { ...input, lookDX: 0, lookDY: 0 };
      if (this.settings.invertY) camInput.lookDY = -camInput.lookDY;
      this.cameraCtl.update(dt, camInput, this.player, this.statics, cam, this.time);
    }
    const day = this.scene.setTimeOfDay(this.timeOfDay);
    this.worldRenderer.setNight(day.night);
    this.scene.follow(this.player.x, 0, this.player.z);
    this.worldRenderer.update(cam.position.x, cam.position.z, this.time, dt);
    // Aim pitch for the player pose
    const aimPitch = -this.cameraCtl.pitch;
    this.views.update(dt, this.time, this.traffic.vehicles, this.peds.peds, this.player, cam.position, this.cameraCtl.mode, aimPitch, day.night);
    this.updateVehicleFx(dt);
    this.effects.update(dt);
    this.updateAudio(dt);
    this.scene.render();
  }

  private updateVehicleFx(dt: number): void {
    for (const v of this.traffic.vehicles) {
      if (v.destroyed) {
        const since = this.time - v.lastHitTime;
        if (since < 40) this.effects.setFire(v.id, v.x, v.y + 0.6, v.z, since < 25 ? 1 : 0.4);
        else this.effects.removeFire(v.id);
        continue;
      }
      if (v.burnTimer >= 0) this.effects.setFire(v.id, v.x + v.forwardX * v.spec.length * 0.3, v.y + 0.9, v.z + v.forwardZ * v.spec.length * 0.3, 0.6);
      else if (v.damage01 > 0.55) this.effects.setSmokeTrail(v.id, v.x + v.forwardX * v.spec.length * 0.35, v.y + 0.9, v.z + v.forwardZ * v.spec.length * 0.35, (v.damage01 - 0.55) * 2, v.damage01 > 0.8);
      if (v.skid > 0.4 && Math.abs(v.speed) > 4) {
        const bx = v.x - v.forwardX * v.spec.length * 0.35;
        const bz = v.z - v.forwardZ * v.spec.length * 0.35;
        if (Math.random() < v.skid * 0.6) this.effects.spawnDust(bx, v.y + 0.1, bz, 0.8);
      }
    }
    void dt;
  }

  private updateAudio(dt: number): void {
    const cam = this.scene.camera;
    audio.setListener(cam.position.x, cam.position.y, cam.position.z, this.cameraCtl.yaw);
    const p = this.player;
    // Player vehicle engine + skid
    const pv = p.vehicle;
    const active = new Set<number>();
    const sirens = new Set<number>();
    const playing = store.hud.phase === 'playing';
    if (playing) {
      const candidates = this.traffic.vehicles;
      let count = 0;
      for (const v of candidates) {
        if (v.destroyed) continue;
        const d2 = v.distSq(cam.position.x, cam.position.z);
        const isPlayer = v === pv;
        if (!isPlayer && (d2 > 70 * 70 || v.sleeping || count >= 8)) continue;
        if (!isPlayer) count++;
        active.add(v.id);
        const spec = v.spec;
        const speed01 = clamp(Math.abs(v.speed) / spec.maxSpeed, 0, 1);
        const throttle01 = clamp(Math.abs(v.controls.throttle), 0, 1);
        const gear = Math.floor(speed01 * 4.99);
        const rpm01 = clamp(0.15 + ((speed01 * 5 - gear) * 0.6 + throttle01 * 0.25), 0.12, 1);
        audio.updateEngine(v.id, { rpm01, throttle01, speed01, type: v.type, x: v.x, y: v.y, z: v.z, isPlayer });
        if (isPlayer) {
          if (v.skid > 0.3 && Math.abs(v.speed) > 3) audio.updateSkid(v.id, v.skid, v.x, v.y, v.z);
          else audio.removeSkid(v.id);
          if (v.controls.horn && v.hornTimer > 0.29) audio.playHorn(v.type, v.x, v.y, v.z);
        } else if (v.controls.horn && v.hornTimer > 0.29) audio.playHorn(v.type, v.x, v.y, v.z);
        if (v.type === 'police' && v.siren && d2 < 200 * 200) {
          sirens.add(v.id);
          audio.updateSiren(v.id, true, v.x, v.y, v.z);
        }
      }
    }
    for (const id of this.nearbyEngineIds) if (!active.has(id)) audio.removeEngine(id);
    for (const id of this.sirenIds) if (!sirens.has(id)) audio.removeSiren(id);
    this.nearbyEngineIds = active;
    this.sirenIds = sirens;
    // Footsteps
    if (p.footstepEvent && this.time - this.lastFootstepTime > 0.2) {
      this.lastFootstepTime = this.time;
      const d = this.world.districtAt(p.x, p.z);
      const surf = this.world.isRoadAt(p.x, p.z) ? 'concrete' : d === 'beach' ? 'sand' : d === 'park' || d === 'residential' ? 'grass' : 'concrete';
      audio.playFootstep(surf, p.sprinting);
      p.footstepEvent = false;
    }
    audio.update(dt);
    void this.lastVehicleAudio;
  }

  // ------------------------------------------------------------------ HUD
  private syncHud(): void {
    const p = this.player;
    const h = store.hud;
    store.set('health', Math.round(p.health));
    store.set('armor', Math.round(p.armor));
    store.set('money', p.money);
    store.set('wanted', this.police.stars);
    store.set('wantedFlash', this.police.stars > 0 && this.police.outOfSight < 10);
    const spec = p.weaponSpec;
    store.set('weaponId', spec.id);
    store.set('weaponName', spec.name);
    store.set('ammoInClip', p.currentSlot.clip);
    store.set('ammoReserve', p.currentSlot.reserve);
    store.set('clipSize', spec.clipSize);
    store.set('reloading', p.reloading);
    store.set('inVehicle', !!p.vehicle);
    store.set('vehicleName', p.vehicle ? p.vehicle.spec.name : '');
    store.set('speedKmh', p.vehicle ? Math.abs(p.vehicle.speed) * 3.6 : 0);
    store.set('vehicleHealth', p.vehicle ? 1 - p.vehicle.damage01 : 1);
    store.set('headlights', !!p.vehicle && p.vehicle.headlights);
    store.set('timeOfDay', this.timeOfDay);
    store.set('clock', formatClock(this.timeOfDay));
    store.set('district', DISTRICT_NAMES[this.world.districtAt(p.x, p.z)]);
    const m = this.missions.hud();
    const prev = h.mission;
    if (!!m !== !!prev || (m && prev && (m.objective !== prev.objective || m.progress !== prev.progress || Math.floor(m.timeLeft ?? -1) !== Math.floor(prev.timeLeft ?? -1)))) {
      h.mission = m;
      store.invalidate();
    }
    store.set('interactPrompt', this.interactPrompt);
    store.set('crosshair', !p.dead && !p.entering && spec.clipSize > 0 && (!p.vehicle || spec.driveBy));
    store.set('aiming', p.aiming);
    store.set('hitMarker', this.hitMarker);
    store.set('damageFlash', this.damageFlash);
    const st = h.stats;
    if (st.kills !== p.stats.kills || st.vehiclesStolen !== p.stats.vehiclesStolen || st.missionsDone !== p.stats.missionsDone || Math.abs(st.distanceKm - p.stats.distance / 1000) > 0.01 || st.maxWanted !== p.stats.maxWanted) {
      h.stats = { kills: p.stats.kills, vehiclesStolen: p.stats.vehiclesStolen, missionsDone: p.stats.missionsDone, distanceKm: p.stats.distance / 1000, maxWanted: p.stats.maxWanted };
      store.invalidate();
    }
    store.set('radioName', audio.getRadioStationName());
    store.set('waypointDist', this.waypoint ? Math.hypot(this.waypoint.x - p.x, this.waypoint.z - p.z) : -1);
    store.set('cameraMode', this.cameraCtl.mode);
    store.set('shopMessage', this.pickups.shopMessage);
    store.set('paused', store.hud.phase !== 'playing');
  }

  // ------------------------------------------------------------------ waypoints / minimap
  setWaypoint(x: number, z: number, user: boolean): void {
    this.waypoint = { x, z };
    this.routeTimer = 0;
    this.computeRoute();
    if (user) store.notify('Waypoint set', 'info', 2, this.time);
  }

  clearWaypoint(user: boolean): void {
    this.waypoint = null;
    this.route = [];
    void user;
  }

  private computeRoute(): void {
    if (!this.waypoint) {
      this.route = [];
      return;
    }
    const from = this.roads.nearestNode(this.player.x, this.player.z);
    const to = this.roads.nearestNode(this.waypoint.x, this.waypoint.z);
    const nodes = this.roads.route(from.id, to.id);
    const out: number[] = [this.player.x, this.player.z];
    for (const id of nodes) {
      const n = this.roads.nodes[id];
      out.push(n.x, n.z);
    }
    out.push(this.waypoint.x, this.waypoint.z);
    this.route = out;
  }

  private buildMinimap(): MinimapState {
    const p = this.player;
    const s = this.minimapState;
    const blips = this.minimapBlips;
    blips.length = 0;
    s.x = p.x;
    s.z = p.z;
    s.yaw = p.vehicle ? p.vehicle.yaw : p.yaw;
    s.camYaw = this.cameraCtl.yaw;
    s.inVehicle = !!p.vehicle;
    s.route = this.route;
    s.waypoint = this.waypoint;
    s.wanted = this.police.stars;
    s.zoomRadius = p.vehicle ? 190 : 115;
    const R = s.zoomRadius * 1.3;
    const R2 = R * R;
    for (const v of this.traffic.vehicles) {
      if (v === p.vehicle) continue;
      const d2 = v.distSq(p.x, p.z);
      if (v.role === 'police' && !v.destroyed) {
        if (d2 < 400 * 400) blips.push({ x: v.x, z: v.z, kind: 'police', heading: v.yaw });
      } else if (d2 < R2 && !v.destroyed) blips.push({ x: v.x, z: v.z, kind: 'vehicle', heading: v.yaw });
    }
    for (const ped of this.peds.peds) {
      if (ped.dead) continue;
      if (ped.kind === 'cop') blips.push({ x: ped.x, z: ped.z, kind: 'cop' });
      else if (ped.tag === 'target' || ped.tag === 'criminal') blips.push({ x: ped.x, z: ped.z, kind: 'target' });
      else if (ped.tag === 'passenger') blips.push({ x: ped.x, z: ped.z, kind: 'passenger' });
    }
    for (const it of this.pickups.items) {
      if (!it.active) continue;
      const dx = it.spawn.x - p.x;
      const dz = it.spawn.z - p.z;
      if (dx * dx + dz * dz > R2) continue;
      blips.push({ x: it.spawn.x, z: it.spawn.z, kind: 'pickup', color: it.spawn.kind === 'health' ? '#f87171' : it.spawn.kind === 'armor' ? '#60a5fa' : it.spawn.kind === 'money' ? '#4ade80' : '#fbbf24' });
    }
    for (const m of this.missions.markers) if (this.missions.isMarkerActive(m, this.time)) blips.push({ x: m.x, z: m.z, kind: 'mission', label: m.title });
    for (const g of this.world.gunShops) blips.push({ x: g.x, z: g.z, kind: 'gunshop', label: 'Ammu-Nation' });
    blips.push({ x: this.world.hospital.x, z: this.world.hospital.z, kind: 'hospital', label: 'Hospital' });
    for (const poi of this.world.poi) if (poi.icon !== 'hospital' && poi.icon !== 'gun') blips.push({ x: poi.x, z: poi.z, kind: 'poi', label: poi.name });
    const a = this.missions.active;
    if (a) {
      // the objective marker is exposed through the waypoint; add an explicit blip too
      if (this.waypoint) blips.push({ x: this.waypoint.x, z: this.waypoint.z, kind: 'objective' });
    }
    return s;
  }

  // ------------------------------------------------------------------ UI bridge
  private makeBridge(): UiBridge {
    return {
      world: () => this.world,
      minimap: () => this.buildMinimap(),
      start: () => this.startGame(),
      resume: () => this.startGame(),
      pause: () => this.pause(),
      toggleMap: () => this.toggleMap(),
      respawn: () => this.respawn(),
      newGame: () => this.newGame(),
      setWaypoint: (x, z) => this.setWaypoint(x, z, true),
      clearWaypoint: () => this.clearWaypoint(true),
      settings: () => ({ ...this.settings }),
      applySettings: (patch) => this.applySettings(patch),
      radioStations: () => (audio.constructor as unknown as { RADIO_STATIONS: string[] }).RADIO_STATIONS ?? [],
      radioStation: () => audio.getRadioStation(),
      setRadioStation: (i) => {
        audio.resume();
        audio.setRadioStation(i);
        store.set('radioName', audio.getRadioStationName());
        store.commit();
      },
      shopItems: () => this.pickups.shopItems(this.player),
      buyWeapon: (id) => this.shopAction(() => this.pickups.buyWeapon(this.player, id)),
      buyAmmo: (id) => this.shopAction(() => this.pickups.buyAmmo(this.player, id)),
      buyArmor: () => this.shopAction(() => this.pickups.buyArmor(this.player)),
      buyHealth: () => this.shopAction(() => this.pickups.buyHealth(this.player)),
      closeShop: () => {
        this.startGame();
        this.input.requestPointerLock();
        this.save();
      },
      missions: () => this.missions.summaries(),
      requestPointerLock: () => this.input.requestPointerLock(),
      money: () => this.player.money,
      stats: () => ({ kills: this.player.stats.kills, vehiclesStolen: this.player.stats.vehiclesStolen, missionsDone: this.player.stats.missionsDone, distanceKm: this.player.stats.distance / 1000, maxWanted: this.player.stats.maxWanted, deaths: this.player.stats.deaths, moneyEarned: this.player.stats.moneyEarned, playTimeSec: this.playTime }),
      setCameraMode: (mode) => {
        this.cameraCtl.mode = mode;
        store.set('cameraMode', mode);
        store.commit();
      },
    };
  }

  private shopAction(fn: () => boolean): boolean {
    const ok = fn();
    audio.playUI(ok ? 'money' : 'click');
    store.set('shopMessage', this.pickups.shopMessage);
    store.set('money', this.player.money);
    store.commit();
    return ok;
  }

  applySettings(patch: Partial<UiSettings>): void {
    this.settings = { ...this.settings, ...patch };
    this.input.sensitivity = this.settings.sensitivity;
    if (patch.shadows !== undefined) this.scene.setShadows(patch.shadows);
    if (patch.quality !== undefined) {
      const pr = patch.quality === 'low' ? 1 : patch.quality === 'medium' ? Math.min(1.5, window.devicePixelRatio || 1) : Math.min(2, window.devicePixelRatio || 1);
      this.scene.renderer.setPixelRatio(pr);
      this.scene.resize();
      if (patch.quality === 'low') this.scene.setShadows(false);
    }
    this.applyAudioSettings();
    this.saveSettings();
  }

  private applyAudioSettings(): void {
    audio.setMasterVolume(this.settings.masterVolume);
    audio.setSfxVolume(this.settings.sfxVolume);
    audio.setMusicVolume(this.settings.musicVolume);
  }

  // ------------------------------------------------------------------ persistence
  private loadSettings(): void {
    try {
      const raw = localStorage.getItem(SAVE_KEY + ':settings');
      if (raw) this.settings = { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<UiSettings>) };
    } catch {
      /* ignore */
    }
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(SAVE_KEY + ':settings', JSON.stringify(this.settings));
    } catch {
      /* ignore */
    }
  }

  save(): void {
    if (!this.started) return;
    const data: SaveData = {
      version: 1,
      money: this.player.money,
      stats: this.player.stats,
      weapons: this.player.weapons,
      currentWeapon: this.player.currentWeapon,
      completed: Array.from(this.missions.completed.entries()),
      timeOfDay: this.timeOfDay,
      settings: this.settings,
      playTime: this.playTime,
    };
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    } catch {
      /* ignore */
    }
  }

  private loadSave(): void {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return;
      const d = JSON.parse(raw) as SaveData;
      if (d.version !== 1) return;
      this.player.money = d.money;
      this.player.stats = { ...this.player.stats, ...d.stats };
      this.player.weapons = { fist: { clip: 0, reserve: 0 }, ...d.weapons };
      if (this.player.weapons[d.currentWeapon]) this.player.currentWeapon = d.currentWeapon;
      for (const [id, t] of d.completed) this.missions.completed.set(id, t);
      this.timeOfDay = d.timeOfDay ?? this.timeOfDay;
      this.playTime = d.playTime ?? 0;
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------ debug API
  /** Debug: advance n fixed frames; only the last one renders (fast under software GL). */
  stepFrames(n: number): void {
    for (let i = 0; i < n; i++) this.tick(FIXED_DT, i === n - 1);
  }

  measureFrameMs(n: number): number {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) this.tick(FIXED_DT);
    return (performance.now() - t0) / n;
  }

  getDebugState(): unknown {
    const p = this.player;
    const v = p.vehicle;
    let police = 0;
    for (const veh of this.traffic.vehicles) if (veh.role === 'police' && !veh.destroyed) police++;
    for (const ped of this.peds.peds) if (ped.kind === 'cop' && !ped.dead) police++;
    return {
      phase: store.hud.phase,
      frame: this.frame,
      time: this.time,
      timeOfDay: this.timeOfDay,
      camera: this.scene.camera.position.toArray(),
      player: { position: [p.x, p.y, p.z], yaw: p.yaw, health: p.health, armor: p.armor, money: p.money, inVehicle: !!v, weapon: p.currentWeapon, ammo: p.currentSlot.clip + p.currentSlot.reserve, dead: p.dead },
      vehicle: v ? { id: v.id, type: v.type, speedKmh: Math.abs(v.speed) * 3.6, health: v.health } : null,
      wanted: this.police.stars,
      heat: this.police.heat,
      counts: { vehicles: this.traffic.vehicles.length, pedestrians: this.peds.peds.length, police, particles: this.effects.activeCount },
      mission: this.missions.hud() ? { active: true, title: this.missions.hud()!.title, objective: this.missions.hud()!.objective } : { active: false },
      district: DISTRICT_NAMES[this.world.districtAt(p.x, p.z)],
    };
  }

  getRenderStats(): unknown {
    const info = this.scene.renderer.info;
    return { calls: info.render.calls, triangles: info.render.triangles, geometries: info.memory.geometries, textures: info.memory.textures, programs: info.programs?.length ?? 0, simMs: +this.simMsAvg.toFixed(2), renderMs: +this.renderMsAvg.toFixed(2) };
  }

  simulateInput(input: Record<string, unknown>, frames: number): void {
    this.input.simulated = { ...(this.input.simulated ?? {}), ...(input as object) };
    this.stepFrames(frames);
  }

  teleportPlayer(x: number, y: number, z: number): void {
    const p = this.player;
    if (p.vehicle) {
      p.vehicle.setPose(x, z, p.vehicle.yaw, this.world.groundHeightAt(x, z));
      this.dynamics.vehicles.update(p.vehicle.collider);
    }
    p.setPosition(x, z, p.yaw, Math.max(y, this.world.groundHeightAt(x, z)));
    this.cameraCtl.snapBehind(p);
    this.freeCam = false;
  }

  setTimeOfDay(t: number): void {
    this.timeOfDay = ((t % 1) + 1) % 1;
  }

  setDebugCamera(x: number, y: number, z: number, tx: number, ty: number, tz: number): void {
    this.freeCam = true;
    this.freeCamPos.set(x, y, z);
    this.freeCamTarget.set(tx, ty, tz);
  }

  setFreeCamera(on: boolean): void {
    this.freeCam = on;
  }

  debugSpawnVehicle(type?: string): number {
    const t = (type && type in VEHICLE_SPECS ? type : 'sedan') as VehicleType;
    const p = this.player;
    const fx = Math.sin(this.cameraCtl.yaw);
    const fz = Math.cos(this.cameraCtl.yaw);
    for (let d = 5; d < 30; d += 2) {
      const x = p.x + fx * d;
      const z = p.z + fz * d;
      if (this.traffic.isSpawnFree(t, x, z, this.cameraCtl.yaw)) {
        const v = this.traffic.spawnVehicle(t, x, z, this.cameraCtl.yaw, 'parked');
        v.persistent = true;
        return v.id;
      }
    }
    const v = this.traffic.spawnVehicle(t, p.x + fx * 6, p.z + fz * 6, this.cameraCtl.yaw, 'parked');
    v.persistent = true;
    return v.id;
  }

  debugEnterNearestVehicle(): boolean {
    const p = this.player;
    if (p.vehicle) return true;
    const v = this.traffic.nearestVehicle(p.x, p.z, 40, (veh) => !veh.destroyed);
    if (!v) return false;
    // teleport next to it and enter instantly
    const door = v.exitPositions()[0];
    p.setPosition(door.x, door.z, v.yaw, v.y);
    p.vehicle = v;
    v.playerDriving = true;
    v.role = 'player';
    v.persistent = true;
    v.controls.handbrake = false;
    v.sleeping = false;
    this.events.push({ type: 'vehicleEntered', x: p.x, y: p.y, z: p.z, ref: v.id, byPlayer: true });
    return true;
  }

  debugExitVehicle(): void {
    if (this.player.vehicle) this.player.exitVehicle(this.statics, this.events);
  }

  debugGiveWeapon(id: string, ammo?: number): void {
    if (id in WEAPON_SPECS) this.player.giveWeapon(id as WeaponId, ammo);
  }

  debugSelectWeapon(id: string): void {
    if (id in WEAPON_SPECS) this.player.selectWeapon(id as WeaponId);
  }

  debugSetWanted(stars: number): void {
    this.police.setStars(stars, this.time);
  }

  debugStartMission(i: number): boolean {
    const m = this.world.missions[i];
    if (!m) return false;
    this.missions.abort(this.time);
    return this.missions.start(m, this.time);
  }

  debugSetGodMode(on: boolean): void {
    this.player.godMode = on;
  }

  /** Access for tests: nearest pedestrian to the player. */
  debugNearestPed(): Pedestrian | null {
    return this.peds.nearestPed(this.player.x, this.player.z, 200);
  }

  debugVehicles(): Vehicle[] {
    return this.traffic.vehicles;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.onResize);
    this.input.detach();
    setUiBridge(null);
    audio.removeAllContinuous();
    this.views?.dispose();
    this.effects?.dispose();
    this.worldRenderer?.dispose();
    this.scene?.dispose();
  }
}
