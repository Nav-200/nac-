import * as THREE from 'three';
import { mergeParts } from '../world/geometryUtils';
import type { Road } from '../world/road';

export type RaceState = 'idle' | 'countdown' | 'running' | 'finished';

export interface Gate {
  /** Arc length along the loop where this gate sits. */
  distance: number;
  index: number;
  x: number;
  y: number;
  z: number;
  group: THREE.Group;
}

const GATE_COUNT = 12;
const GATE_HALF_WIDTH = 7.4;
const PASS_RADIUS = 13;
const BEST_TIME_KEY = 'nac-racing:best-time:v1';

const buildGateStructure = (color: number): THREE.BufferGeometry =>
  mergeParts([
    { geometry: new THREE.BoxGeometry(0.42, 6.2, 0.42), color, position: [GATE_HALF_WIDTH, 3.1, 0] },
    { geometry: new THREE.BoxGeometry(0.42, 6.2, 0.42), color, position: [-GATE_HALF_WIDTH, 3.1, 0] },
    {
      geometry: new THREE.BoxGeometry(GATE_HALF_WIDTH * 2 + 0.42, 0.7, 0.42),
      color,
      position: [0, 6.5, 0],
    },
  ]);

/**
 * A one-lap checkpoint race around the loop.
 *
 * Gates are spaced by arc length so they land on the road no matter how the
 * spline wanders, and progress is tracked in metres travelled so the standings
 * stay meaningful even if someone cuts across the grass.
 */
export class Race {
  readonly group = new THREE.Group();
  readonly gates: Gate[] = [];
  readonly lapLength: number;
  readonly gateSpacing: number;

  state: RaceState = 'idle';
  currentGate = 0;
  time = 0;
  countdown = 0;
  lastTime: number | null = null;
  bestTime: number | null = null;
  finishPosition = 1;

  private activeStructure: THREE.MeshBasicMaterial;
  private idleStructure: THREE.MeshBasicMaterial;
  private activeCurtain: THREE.MeshBasicMaterial;
  private idleCurtain: THREE.MeshBasicMaterial;
  private structureGeo: THREE.BufferGeometry;
  private curtainGeo: THREE.PlaneGeometry;
  private pulse = 0;

  constructor(private road: Road) {
    this.group.name = 'race-gates';
    this.lapLength = road.totalLength;
    this.gateSpacing = this.lapLength / GATE_COUNT;

    this.activeStructure = new THREE.MeshBasicMaterial({ color: 0x53e0ff });
    this.idleStructure = new THREE.MeshBasicMaterial({ color: 0x2a4a5c });
    this.activeCurtain = new THREE.MeshBasicMaterial({
      color: 0x53e0ff,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.idleCurtain = new THREE.MeshBasicMaterial({
      color: 0x2f6d84,
      transparent: true,
      opacity: 0.05,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.structureGeo = buildGateStructure(0xffffff);
    this.curtainGeo = new THREE.PlaneGeometry(GATE_HALF_WIDTH * 2, 6.2);

    for (let i = 1; i <= GATE_COUNT; i++) {
      // Gate GATE_COUNT lands back on the start line and is the finish.
      const distance = i * this.gateSpacing;
      this.gates.push(this.buildGate(distance));
    }

    this.bestTime = this.loadBestTime();
  }

  private buildGate(distance: number): Gate {
    const index = this.road.indexAtDistance(distance);
    const group = new THREE.Group();
    const x = this.road.px[index];
    const y = this.road.py[index];
    const z = this.road.pz[index];
    group.position.set(x, y, z);
    group.rotation.y = this.road.headingAt(index);

    const structure = new THREE.Mesh(this.structureGeo, this.idleStructure);
    structure.name = 'structure';
    group.add(structure);

    const curtain = new THREE.Mesh(this.curtainGeo, this.idleCurtain);
    curtain.name = 'curtain';
    curtain.position.y = 3.2;
    group.add(curtain);

    this.group.add(group);
    return { distance, index, x, y, z, group };
  }

  get gateCount(): number {
    return this.gates.length;
  }

  /** Where the car lines up before the lights go out. */
  startTransform(out: THREE.Vector3, lateral = 0): number {
    const index = this.road.indexAtDistance(this.lapLength - 26);
    this.road.positionAt(index, out, lateral);
    return this.road.headingAt(index);
  }

  beginCountdown(): void {
    this.state = 'countdown';
    this.countdown = 3.999;
    this.time = 0;
    this.currentGate = 0;
    this.refreshGateVisuals();
  }

  abandon(): void {
    this.state = 'idle';
    this.time = 0;
    this.currentGate = 0;
    this.refreshGateVisuals();
  }

  /** Returns true on the frame a gate is passed. */
  update(dt: number, carX: number, carZ: number, carY: number): boolean {
    this.pulse += dt;
    this.animateActiveGate();

    if (this.state === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.countdown = 0;
        this.state = 'running';
      }
      return false;
    }
    if (this.state !== 'running') return false;

    this.time += dt;

    const gate = this.gates[this.currentGate];
    if (!gate) return false;
    const dx = carX - gate.x;
    const dz = carZ - gate.z;
    const dy = carY - gate.y;
    if (dx * dx + dz * dz < PASS_RADIUS * PASS_RADIUS && Math.abs(dy) < 9) {
      this.currentGate++;
      if (this.currentGate >= this.gates.length) {
        this.finish();
      } else {
        this.refreshGateVisuals();
      }
      return true;
    }
    return false;
  }

  private finish(): void {
    this.state = 'finished';
    this.lastTime = this.time;
    if (this.bestTime === null || this.time < this.bestTime) {
      this.bestTime = this.time;
      this.saveBestTime(this.time);
    }
    this.refreshGateVisuals();
  }

  /** Metres of the lap completed, used for the running order. */
  progressFor(carX: number, carZ: number): number {
    const passed = this.currentGate * this.gateSpacing;
    const gate = this.gates[Math.min(this.currentGate, this.gates.length - 1)];
    if (!gate) return passed;
    const remaining = Math.hypot(carX - gate.x, carZ - gate.z);
    return passed + Math.max(0, this.gateSpacing - remaining);
  }

  /**
   * Only the next gate lights up; the rest stay dim but visible, so the whole
   * route reads as a chain of landmarks from a distance.
   */
  private refreshGateVisuals(): void {
    for (let i = 0; i < this.gates.length; i++) {
      const active = this.state !== 'idle' && i === this.currentGate;
      const g = this.gates[i];
      const structure = g.group.getObjectByName('structure') as THREE.Mesh;
      const curtain = g.group.getObjectByName('curtain') as THREE.Mesh;
      structure.material = active ? this.activeStructure : this.idleStructure;
      curtain.material = active ? this.activeCurtain : this.idleCurtain;
    }
  }

  private animateActiveGate(): void {
    const breathe = 0.5 + Math.sin(this.pulse * 3.4) * 0.5;
    this.activeCurtain.opacity = 0.09 + breathe * 0.16;
  }

  /** Distance to the start gate, for the free-roam "start race" prompt. */
  distanceToStart(carX: number, carZ: number, out: THREE.Vector3): number {
    this.startTransform(out);
    return Math.hypot(carX - out.x, carZ - out.z);
  }

  private loadBestTime(): number | null {
    try {
      const raw = localStorage.getItem(BEST_TIME_KEY);
      if (!raw) return null;
      const value = Number.parseFloat(raw);
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  private saveBestTime(time: number): void {
    try {
      localStorage.setItem(BEST_TIME_KEY, String(time));
    } catch {
      // Private browsing and blocked storage are fine; the time just is not kept.
    }
  }

  dispose(): void {
    this.structureGeo.dispose();
    this.curtainGeo.dispose();
    this.activeStructure.dispose();
    this.idleStructure.dispose();
    this.activeCurtain.dispose();
    this.idleCurtain.dispose();
  }
}

export const formatTime = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds % 1) * 100);
  return `${m}:${s.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`;
};
