import * as THREE from 'three';
import { loadBestTime, saveBestTime } from '../settings';
import { mergeParts } from '../world/geometryUtils';
import type { Road } from '../world/road';

export type RaceState = 'idle' | 'countdown' | 'running' | 'finished';

/** A way to race the one road loop. */
export interface RaceEvent {
  id: string;
  name: string;
  blurb: string;
  gateCount: number;
  /** Portion of the loop covered; 1 is a full lap. */
  span: number;
  /** 1 = with the sample order, -1 = against it. */
  direction: 1 | -1;
}

export const EVENTS: RaceEvent[] = [
  {
    id: 'circuit',
    name: 'Grand Circuit',
    blurb: 'One full lap of the valley loop.',
    gateCount: 12,
    span: 1,
    direction: 1,
  },
  {
    id: 'sprint',
    name: 'Valley Sprint',
    blurb: 'Half the loop, flat out, point to point.',
    gateCount: 6,
    span: 0.5,
    direction: 1,
  },
  {
    id: 'reverse',
    name: 'Reverse Circuit',
    blurb: 'The full lap, run the wrong way round.',
    gateCount: 12,
    span: 1,
    direction: -1,
  },
];

export const eventById = (id: string): RaceEvent =>
  EVENTS.find((e) => e.id === id) ?? EVENTS[0];

interface Gate {
  /** Arc distance along the loop where this gate sits, normalized to [0, L). */
  arc: number;
  index: number;
  x: number;
  y: number;
  z: number;
  group: THREE.Group;
}

const MAX_GATES = 12;
const GATE_HALF_WIDTH = 7.4;
const PASS_RADIUS = 13;
/** How far before the first-gate line the grid forms up. */
const START_SETBACK = 26;

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
 * A checkpoint race over the loop, reconfigurable between events.
 *
 * The full set of gate groups is built once and added to the scene once; an
 * event repositions the ones it needs and hides the rest, so switching events
 * allocates nothing and never touches the scene graph's membership.
 */
export class Race {
  readonly group = new THREE.Group();
  readonly lapLength: number;

  /** Flat [x, z] pairs of the active gates, mutated in place for the minimap. */
  readonly gatePositions = new Float32Array(MAX_GATES * 2);

  event: RaceEvent = EVENTS[0];
  raceDistance: number;
  gateSpacing: number;

  state: RaceState = 'idle';
  currentGate = 0;
  /** Player's arc position on the last update, for line-crossing detection. */
  private lastArc = 0;
  time = 0;
  countdown = 0;
  lastTime: number | null = null;
  bestTime: number | null = null;
  finishPosition = 1;

  private gates: Gate[] = [];
  private activeStructure: THREE.MeshBasicMaterial;
  private idleStructure: THREE.MeshBasicMaterial;
  private activeCurtain: THREE.MeshBasicMaterial;
  private idleCurtain: THREE.MeshBasicMaterial;
  private structureGeo: THREE.BufferGeometry;
  private curtainGeo: THREE.PlaneGeometry;
  private pulse = 0;
  /** Session cache of bests, so sandboxed builds without storage still show
   * the times set this session. */
  private bests = new Map<string, number | null>();

  constructor(private road: Road) {
    this.group.name = 'race-gates';
    this.lapLength = road.totalLength;
    this.raceDistance = this.lapLength;
    this.gateSpacing = this.lapLength / MAX_GATES;

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

    for (let i = 0; i < MAX_GATES; i++) {
      const group = new THREE.Group();
      const structure = new THREE.Mesh(this.structureGeo, this.idleStructure);
      structure.name = 'structure';
      group.add(structure);
      const curtain = new THREE.Mesh(this.curtainGeo, this.idleCurtain);
      curtain.name = 'curtain';
      curtain.position.y = 3.2;
      group.add(curtain);
      this.group.add(group);
      this.gates.push({ arc: 0, index: 0, x: 0, y: 0, z: 0, group });
    }

    this.configure(EVENTS[0]);
  }

  configure(event: RaceEvent): void {
    this.event = event;
    this.raceDistance = event.span * this.lapLength;
    this.gateSpacing = this.raceDistance / event.gateCount;

    for (let i = 0; i < MAX_GATES; i++) {
      const gate = this.gates[i];
      const active = i < event.gateCount;
      gate.group.visible = active;
      if (!active) {
        this.gatePositions[i * 2] = 0;
        this.gatePositions[i * 2 + 1] = 0;
        continue;
      }
      const distance = event.direction * (i + 1) * this.gateSpacing;
      const index = this.road.indexAtDistance(distance);
      gate.arc = ((distance % this.lapLength) + this.lapLength) % this.lapLength;
      gate.index = index;
      gate.x = this.road.px[index];
      gate.y = this.road.py[index];
      gate.z = this.road.pz[index];
      gate.group.position.set(gate.x, gate.y, gate.z);
      gate.group.rotation.y = this.road.headingAt(index);
      this.gatePositions[i * 2] = gate.x;
      this.gatePositions[i * 2 + 1] = gate.z;
    }

    this.bestTime = this.bestFor(event.id);
    this.lastTime = null;
    this.state = 'idle';
    this.currentGate = 0;
    this.time = 0;
    this.refreshGateVisuals();
  }

  get gateCount(): number {
    return this.event.gateCount;
  }

  get direction(): 1 | -1 {
    return this.event.direction;
  }

  /** Arc distance of the grid slot, `START_SETBACK` before the line. */
  get startDistance(): number {
    return -this.event.direction * START_SETBACK;
  }

  /** Where the car lines up before the lights go out. Returns the heading. */
  startTransform(out: THREE.Vector3, lateral = 0): number {
    const index = this.road.indexAtDistance(this.startDistance);
    this.road.positionAt(index, out, lateral);
    const heading = this.road.headingAt(index);
    return this.event.direction === 1 ? heading : heading + Math.PI;
  }

  beginCountdown(): void {
    this.state = 'countdown';
    this.countdown = 3.999;
    this.time = 0;
    this.currentGate = 0;
    this.lastArc = ((this.startDistance % this.lapLength) + this.lapLength) % this.lapLength;
    this.refreshGateVisuals();
  }

  abandon(): void {
    this.state = 'idle';
    this.time = 0;
    this.currentGate = 0;
    this.refreshGateVisuals();
  }

  /**
   * Returns true on the frame a gate is passed.
   *
   * Two ways to take a gate: drive through it (proximity), or cross its line —
   * the player's arc position sweeping past the gate's arc while reasonably
   * close to the road. The second is what makes a wide, lurid drift through a
   * corner still count, the way checkpoint racers are expected to behave.
   */
  update(
    dt: number,
    carX: number,
    carZ: number,
    carY: number,
    carArc: number,
    roadDist: number,
  ): boolean {
    this.pulse += dt;
    this.animateActiveGate();

    if (this.state === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.countdown = 0;
        this.state = 'running';
      }
      this.lastArc = carArc;
      return false;
    }
    if (this.state !== 'running') {
      this.lastArc = carArc;
      return false;
    }

    this.time += dt;

    const gate = this.gates[this.currentGate];
    if (!gate || this.currentGate >= this.event.gateCount) return false;

    const dx = carX - gate.x;
    const dz = carZ - gate.z;
    const dy = carY - gate.y;
    const throughGate = dx * dx + dz * dz < PASS_RADIUS * PASS_RADIUS && Math.abs(dy) < 9;

    // Line crossing, measured along the event's direction of travel.
    const L = this.lapLength;
    const wrap = (v: number) => ((v % L) + L) % L;
    const dir = this.event.direction;
    const advanced = wrap(dir * (carArc - this.lastArc));
    const toGate = wrap(dir * (gate.arc - this.lastArc));
    // The 60m cap keeps a respawn teleport from sweeping through gates.
    const crossedLine =
      advanced > 0 && advanced < 60 && toGate > 0 && toGate <= advanced && roadDist < 20;

    this.lastArc = carArc;

    if (throughGate || crossedLine) {
      this.currentGate++;
      if (this.currentGate >= this.event.gateCount) {
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
      this.bests.set(this.event.id, this.time);
      saveBestTime(this.event.id, this.time);
    }
    this.refreshGateVisuals();
  }

  /** Metres of the event completed, used for the running order. */
  progressFor(carX: number, carZ: number): number {
    const passed = this.currentGate * this.gateSpacing;
    const gate = this.gates[Math.min(this.currentGate, this.event.gateCount - 1)];
    if (!gate || this.currentGate >= this.event.gateCount) return passed;
    const remaining = Math.hypot(carX - gate.x, carZ - gate.z);
    return passed + Math.max(0, this.gateSpacing - remaining);
  }

  /**
   * Only the next gate lights up; the rest stay dim but visible, so the whole
   * route reads as a chain of landmarks from a distance.
   */
  private refreshGateVisuals(): void {
    for (let i = 0; i < this.event.gateCount; i++) {
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

  /** Best time for any event: session memory first, then storage. */
  bestFor(eventId: string): number | null {
    const cached = this.bests.get(eventId);
    if (cached !== undefined && cached !== null) return cached;
    const stored = loadBestTime(eventId);
    this.bests.set(eventId, stored);
    return stored;
  }

  /** Distance to the start slot, for the free-roam "start race" prompt. */
  distanceToStart(carX: number, carZ: number, out: THREE.Vector3): number {
    this.startTransform(out);
    return Math.hypot(carX - out.x, carZ - out.z);
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
