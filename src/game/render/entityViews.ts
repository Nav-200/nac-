/**
 * Binds simulation entities (vehicles, pedestrians, player, pickups, mission markers) to
 * their three.js models and syncs transforms/animation every rendered frame.
 */
import * as THREE from 'three';
import type { Pedestrian } from '../entities/pedestrian';
import type { Player } from '../entities/player';
import type { Vehicle } from '../entities/vehicle';
import type { MissionSpawn, WeaponId } from '../core/types';
import type { PickupInstance } from '../systems/pickups';
import { buildCheckpointModel, buildMissionMarker, buildPedModel, buildPickupModel, buildVehicleModel, buildWeaponModel, type PedModel, type PedPose, type VehicleModel } from './models';

interface VehicleView {
  model: VehicleModel;
  lastColor: number;
}

interface PedView {
  model: PedModel;
  weaponId: WeaponId | null;
  weaponObj: THREE.Object3D | null;
  ragdollApplied: boolean;
}

const pose: PedPose = { walkPhase: 0, moveSpeed01: 0, aiming: false, aimPitch: 0 };

export class EntityViews {
  readonly root = new THREE.Group();
  private vehicles = new Map<number, VehicleView>();
  private peds = new Map<number, PedView>();
  private playerView: PedView | null = null;
  private pickups = new Map<number, THREE.Object3D>();
  private missionMarkers = new Map<string, THREE.Object3D>();
  private objective: THREE.Object3D | null = null;
  private objectiveKind: 'checkpoint' | 'marker' | 'target' | null = null;
  private headlights: THREE.SpotLight[] = [];
  private headlightVehicle: Vehicle | null = null;
  private tmpV = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    scene.add(this.root);
    for (let i = 0; i < 2; i++) {
      const s = new THREE.SpotLight(0xfff1d0, 0, 60, 0.55, 0.5, 1.2);
      s.castShadow = false;
      s.visible = false;
      this.root.add(s);
      this.root.add(s.target);
      this.headlights.push(s);
    }
  }

  // ------------------------------------------------------------------ vehicles
  addVehicle(v: Vehicle): void {
    if (this.vehicles.has(v.id)) return;
    const model = buildVehicleModel(v.type, v.colorHex);
    model.root.rotation.order = 'YXZ';
    this.root.add(model.root);
    this.vehicles.set(v.id, { model, lastColor: v.colorHex });
    this.syncVehicle(v, this.vehicles.get(v.id)!, 0);
  }

  removeVehicle(v: Vehicle): void {
    const view = this.vehicles.get(v.id);
    if (!view) return;
    this.root.remove(view.model.root);
    view.model.dispose();
    this.vehicles.delete(v.id);
    if (this.headlightVehicle === v) this.headlightVehicle = null;
  }

  private syncVehicle(v: Vehicle, view: VehicleView, time: number): void {
    const m = view.model;
    m.root.position.set(v.x, v.y, v.z);
    m.root.rotation.set(v.pitch, v.yaw, v.roll);
    for (const w of m.wheels) {
      if (w.steer) w.pivot.rotation.y = -v.steerAngle;
      w.mesh.rotation.x = v.wheelSpin;
    }
    if (view.lastColor !== v.colorHex) {
      view.lastColor = v.colorHex;
      m.setColor(v.colorHex);
    }
    m.setHeadlights(v.headlights && !v.destroyed);
    m.setBrakeLights(v.brakeLights && !v.destroyed);
    m.setReverseLights(v.reverseLights && !v.destroyed);
    m.setDamage(v.destroyed ? 1 : v.damage01);
    if (v.type === 'police') m.setSiren(v.siren && !v.destroyed ? time : null);
  }

  // ------------------------------------------------------------------ pedestrians
  addPed(p: Pedestrian): void {
    if (this.peds.has(p.id)) return;
    const model = buildPedModel({ skin: p.appearance.skin, shirt: p.appearance.shirt, pants: p.appearance.pants, hair: p.appearance.hair, kind: p.kind === 'cop' ? 'cop' : 'civilian' });
    this.root.add(model.root);
    this.peds.set(p.id, { model, weaponId: null, weaponObj: null, ragdollApplied: false });
  }

  removePed(p: Pedestrian): void {
    const view = this.peds.get(p.id);
    if (!view) return;
    this.root.remove(view.model.root);
    view.model.dispose();
    this.peds.delete(p.id);
  }

  private syncWeapon(view: PedView, id: WeaponId | null): void {
    if (view.weaponId === id) return;
    if (view.weaponObj) {
      view.model.handR.remove(view.weaponObj);
      view.weaponObj = null;
    }
    view.weaponId = id;
    if (id && id !== 'fist') {
      const obj = buildWeaponModel(id);
      view.model.handR.add(obj);
      view.weaponObj = obj;
    }
  }

  private syncPed(p: Pedestrian, view: PedView, camX: number, camZ: number): void {
    const m = view.model;
    if (p.state === 'inVehicle') {
      m.root.visible = false;
      return;
    }
    m.root.visible = true;
    m.root.position.set(p.x, p.y, p.z);
    m.root.rotation.y = p.yaw;
    const d2 = (p.x - camX) ** 2 + (p.z - camZ) ** 2;
    if (p.dead) {
      if (!view.ragdollApplied) {
        view.ragdollApplied = true;
        m.setRagdoll(true);
        this.syncWeapon(view, null);
      }
      return;
    }
    if (d2 > 160 * 160) return; // skip animation far away
    this.syncWeapon(view, p.aiming || p.kind === 'cop' || p.kind === 'criminal' || p.kind === 'target' ? p.weapon : null);
    pose.walkPhase = p.walkPhase;
    pose.moveSpeed01 = p.moveSpeed01;
    pose.aiming = p.aiming;
    pose.aimPitch = p.aimPitch;
    pose.crouch = p.state === 'cower';
    pose.inVehicle = false;
    pose.punchT = p.punchT >= 0 ? p.punchT : undefined;
    pose.hit = p.hitFlash;
    pose.jumpT = undefined;
    m.setPose(pose);
  }

  // ------------------------------------------------------------------ player
  createPlayer(): void {
    if (this.playerView) return;
    const model = buildPedModel({ skin: '#e0ac7e', shirt: '#2f8f4e', pants: '#2b3a67', hair: '#1a1a1a', kind: 'player' });
    this.root.add(model.root);
    this.playerView = { model, weaponId: null, weaponObj: null, ragdollApplied: false };
  }

  private syncPlayer(player: Player, camMode: 'near' | 'far' | 'first', aimPitch: number): void {
    const view = this.playerView;
    if (!view) return;
    const m = view.model;
    m.root.visible = camMode !== 'first';
    if (player.dead) {
      m.root.position.set(player.x, player.y, player.z);
      m.root.rotation.y = player.yaw;
      if (!view.ragdollApplied) {
        view.ragdollApplied = true;
        m.setRagdoll(true);
      }
      return;
    }
    if (view.ragdollApplied) {
      view.ragdollApplied = false;
      m.setRagdoll(false);
    }
    this.syncWeapon(view, player.currentWeapon);
    if (player.vehicle) {
      const v = player.vehicle;
      // seat the player: feet on the floor of the cabin
      const sx = 0.38;
      const sz = v.spec.length * 0.08;
      m.root.position.set(v.x - v.rightX * sx + v.forwardX * sz, v.y + v.spec.cabinHeight * 0.15, v.z - v.rightZ * sx + v.forwardZ * sz);
      m.root.rotation.y = v.yaw;
      pose.walkPhase = 0;
      pose.moveSpeed01 = 0;
      pose.aiming = false;
      pose.aimPitch = 0;
      pose.inVehicle = true;
      pose.punchT = undefined;
      pose.hit = 0;
      pose.crouch = false;
      pose.jumpT = undefined;
      m.setPose(pose);
      return;
    }
    m.root.position.set(player.x, player.y, player.z);
    m.root.rotation.y = player.yaw;
    pose.walkPhase = player.walkPhase;
    pose.moveSpeed01 = player.moveSpeed01;
    pose.aiming = player.aiming;
    pose.aimPitch = aimPitch;
    pose.inVehicle = false;
    pose.punchT = player.punchT >= 0 ? player.punchT : undefined;
    pose.hit = player.hitFlash;
    pose.crouch = false;
    pose.jumpT = player.onGround ? undefined : 0.5;
    m.setPose(pose);
  }

  // ------------------------------------------------------------------ pickups / markers
  setPickup(item: PickupInstance): void {
    let obj: THREE.Object3D | undefined = this.pickups.get(item.spawn.id);
    if (!obj) {
      const created: THREE.Object3D = buildPickupModel(item.spawn.kind, item.spawn.weaponId);
      created.position.set(item.spawn.x, 0, item.spawn.z);
      this.root.add(created);
      this.pickups.set(item.spawn.id, created);
      obj = created;
    }
    obj.visible = item.active;
  }

  setPickupBaseY(item: PickupInstance, y: number): void {
    const obj = this.pickups.get(item.spawn.id);
    if (obj) obj.position.y = y;
  }

  setMissionMarkers(markers: MissionSpawn[], isActive: (m: MissionSpawn) => boolean, groundY: (x: number, z: number) => number): void {
    for (const m of markers) {
      let obj: THREE.Object3D | undefined = this.missionMarkers.get(m.id);
      if (!obj) {
        const created: THREE.Object3D = buildMissionMarker(0xf5b700);
        created.position.set(m.x, groundY(m.x, m.z), m.z);
        this.root.add(created);
        this.missionMarkers.set(m.id, created);
        obj = created;
      }
      obj.visible = isActive(m);
    }
  }

  setObjective(pos: { x: number; z: number; kind: 'checkpoint' | 'marker' | 'target' } | null, groundY: (x: number, z: number) => number): void {
    if (!pos) {
      if (this.objective) this.objective.visible = false;
      return;
    }
    if (!this.objective || this.objectiveKind !== pos.kind) {
      if (this.objective) {
        this.root.remove(this.objective);
        this.objective.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.geometry) mesh.geometry.dispose();
        });
      }
      const created: THREE.Object3D = pos.kind === 'checkpoint' ? buildCheckpointModel(0xffd23f) : pos.kind === 'target' ? buildMissionMarker(0xe5484d) : buildMissionMarker(0x4cc9f0);
      this.objective = created;
      this.objectiveKind = pos.kind;
      this.root.add(created);
    }
    const obj: THREE.Object3D = this.objective;
    obj.visible = true;
    obj.position.set(pos.x, groundY(pos.x, pos.z), pos.z);
  }

  // ------------------------------------------------------------------ per frame
  update(dt: number, time: number, vehicles: Vehicle[], peds: Pedestrian[], player: Player, camPos: THREE.Vector3, camMode: 'near' | 'far' | 'first', aimPitch: number, night: number): void {
    for (const v of vehicles) {
      const view = this.vehicles.get(v.id);
      if (!view) continue;
      const d2 = (v.x - camPos.x) ** 2 + (v.z - camPos.z) ** 2;
      view.model.root.visible = d2 < 420 * 420;
      if (view.model.root.visible) this.syncVehicle(v, view, time);
    }
    for (const p of peds) {
      const view = this.peds.get(p.id);
      if (!view) continue;
      const d2 = (p.x - camPos.x) ** 2 + (p.z - camPos.z) ** 2;
      if (d2 > 260 * 260) {
        view.model.root.visible = false;
        continue;
      }
      this.syncPed(p, view, camPos.x, camPos.z);
    }
    this.syncPlayer(player, camMode, aimPitch);

    // Player headlights (spotlights) at night
    const pv = player.vehicle;
    const wantLights = !!pv && pv.headlights && night > 0.3 && !pv.destroyed;
    if (pv !== this.headlightVehicle) this.headlightVehicle = pv;
    for (let i = 0; i < 2; i++) {
      const s = this.headlights[i];
      s.visible = wantLights;
      if (!wantLights || !pv) continue;
      const view = this.vehicles.get(pv.id);
      const anchor = view?.model.headlightAnchors[i];
      if (anchor) {
        anchor.getWorldPosition(s.position);
        this.tmpV.set(0, -0.12, 1).applyQuaternion(pv ? view!.model.root.quaternion : new THREE.Quaternion());
        s.target.position.copy(s.position).addScaledVector(this.tmpV, 20);
      } else {
        const side = i === 0 ? 1 : -1;
        s.position.set(pv.x + pv.forwardX * pv.spec.length * 0.45 + pv.rightX * side * pv.spec.width * 0.35, pv.y + 0.7, pv.z + pv.forwardZ * pv.spec.length * 0.45 + pv.rightZ * side * pv.spec.width * 0.35);
        s.target.position.set(s.position.x + pv.forwardX * 20, pv.y + 0.2, s.position.z + pv.forwardZ * 20);
      }
      s.intensity = 260 * night;
      s.target.updateMatrixWorld();
    }

    // Pickups bob & spin
    const t = time;
    for (const obj of this.pickups.values()) {
      if (!obj.visible) continue;
      const d2 = (obj.position.x - camPos.x) ** 2 + (obj.position.z - camPos.z) ** 2;
      if (d2 > 150 * 150) continue;
      obj.rotation.y = t * 1.6;
      obj.children.forEach((c, i) => {
        if (i === 0) c.position.y = Math.sin(t * 2 + obj.position.x) * 0.12;
      });
    }
    for (const obj of this.missionMarkers.values()) {
      if (!obj.visible) continue;
      obj.rotation.y = t * 0.8;
    }
    if (this.objective && this.objective.visible) this.objective.rotation.y = t * 0.6;
    void dt;
  }

  dispose(): void {
    for (const v of this.vehicles.values()) v.model.dispose();
    for (const p of this.peds.values()) p.model.dispose();
    this.playerView?.model.dispose();
    this.vehicles.clear();
    this.peds.clear();
    this.root.parent?.remove(this.root);
  }
}
