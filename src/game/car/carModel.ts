import * as THREE from 'three';
import { clamp01, lerp } from '../engine/math';
import type { CarSpec } from '../types';
import { mergeParts } from '../world/geometryUtils';

const GLASS = 0x18202b;
const TYRE = 0x1a1a1d;
const RIM = 0xc9ccd2;

/** Soft radial blob used as a contact shadow when real shadows are off. */
const makeBlobTexture = (): THREE.Texture => {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.28)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
};

let blobTexture: THREE.Texture | null = null;

/** A soft cone of light on the ground, used as headlight spill after dark. */
const makeBeamTexture = (): THREE.Texture => {
  const w = 64;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    // 0 at the bumper, 1 at the far end of the throw.
    const t = y / (h - 1);
    const halfWidth = 0.12 + t * 0.44;
    const reach = Math.max(0, 1 - t) * (1 - Math.pow(Math.max(0, t - 0.15), 1.6));
    for (let x = 0; x < w; x++) {
      const u = Math.abs(x / (w - 1) - 0.5);
      const across = Math.max(0, 1 - Math.pow(u / halfWidth, 2));
      const a = Math.round(255 * across * reach * 0.85);
      const o = (y * w + x) * 4;
      image.data[o] = 255;
      image.data[o + 1] = 244;
      image.data[o + 2] = 214;
      image.data[o + 3] = a;
    }
  }
  ctx.putImageData(image, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
};

let beamTexture: THREE.Texture | null = null;

const buildBody = (paint: number, accent: number): THREE.BufferGeometry =>
  mergeParts([
    // Main hull and the wedge that gives it a nose.
    { geometry: new THREE.BoxGeometry(1.84, 0.5, 3.5), color: paint, position: [0, 0.62, -0.1] },
    { geometry: new THREE.BoxGeometry(1.62, 0.34, 1.3), color: paint, position: [0, 0.6, 1.75], rotation: [-0.1, 0, 0] },
    { geometry: new THREE.BoxGeometry(1.7, 0.3, 1.0), color: paint, position: [0, 0.66, -1.85] },
    // Sills and splitters in the accent colour tie the silhouette together.
    { geometry: new THREE.BoxGeometry(1.92, 0.22, 3.9), color: accent, position: [0, 0.38, 0] },
    { geometry: new THREE.BoxGeometry(1.82, 0.07, 0.5), color: accent, position: [0, 0.32, 2.14] },
    { geometry: new THREE.BoxGeometry(1.76, 0.07, 0.4), color: accent, position: [0, 0.34, -2.16] },
    // Greenhouse.
    { geometry: new THREE.BoxGeometry(1.5, 0.42, 1.75), color: GLASS, position: [0, 1.02, -0.32] },
    { geometry: new THREE.BoxGeometry(1.34, 0.12, 1.35), color: paint, position: [0, 1.26, -0.5] },
    // Rear wing.
    { geometry: new THREE.BoxGeometry(1.66, 0.06, 0.34), color: accent, position: [0, 1.14, -1.95] },
    { geometry: new THREE.BoxGeometry(0.08, 0.26, 0.2), color: accent, position: [0.62, 1.0, -1.95] },
    { geometry: new THREE.BoxGeometry(0.08, 0.26, 0.2), color: accent, position: [-0.62, 1.0, -1.95] },
    // Mirrors.
    { geometry: new THREE.BoxGeometry(0.26, 0.09, 0.12), color: accent, position: [0.92, 0.98, 0.5] },
    { geometry: new THREE.BoxGeometry(0.26, 0.09, 0.12), color: accent, position: [-0.92, 0.98, 0.5] },
  ]);

const buildWheel = (): THREE.BufferGeometry => {
  const geo = mergeParts([
    { geometry: new THREE.CylinderGeometry(0.35, 0.35, 0.26, 10), color: TYRE },
    { geometry: new THREE.CylinderGeometry(0.21, 0.21, 0.28, 8), color: RIM },
  ]);
  // Lay the cylinder on its side so its axis runs along X.
  geo.rotateZ(Math.PI / 2);
  return geo;
};

/**
 * A procedurally built low-poly car. Used for the player and every opponent, so
 * it is deliberately cheap: one merged body mesh, four wheels, two light strips.
 */
export class CarModel {
  readonly group = new THREE.Group();
  readonly bodyGroup = new THREE.Group();

  private wheelPivots: THREE.Object3D[] = [];
  private wheelMeshes: THREE.Mesh[] = [];
  private tailMaterial: THREE.MeshBasicMaterial;
  private headMaterial: THREE.MeshBasicMaterial;
  private bodyMesh: THREE.Mesh;
  private bodyMaterial: THREE.MeshLambertMaterial;
  private shadowBlob: THREE.Mesh;
  private lightPool: THREE.Mesh;
  private owned: THREE.BufferGeometry[] = [];

  constructor(spec: CarSpec, castShadow = true) {
    this.group.name = `car-${spec.id}`;

    const bodyGeo = buildBody(spec.color, spec.accentColor);
    this.owned.push(bodyGeo);
    this.bodyMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.bodyMesh = new THREE.Mesh(bodyGeo, this.bodyMaterial);
    this.bodyMesh.castShadow = castShadow;
    this.bodyGroup.add(this.bodyMesh);

    // Lights get their own unlit materials so they can glow independently of
    // the scene lighting.
    this.headMaterial = new THREE.MeshBasicMaterial({ color: 0xfff2d0 });
    this.tailMaterial = new THREE.MeshBasicMaterial({ color: 0x521015 });

    const headGeo = new THREE.BoxGeometry(0.44, 0.14, 0.08);
    const tailGeo = new THREE.BoxGeometry(0.5, 0.12, 0.08);
    this.owned.push(headGeo, tailGeo);
    for (const side of [-1, 1]) {
      const head = new THREE.Mesh(headGeo, this.headMaterial);
      head.position.set(side * 0.6, 0.66, 2.28);
      this.bodyGroup.add(head);
      const tail = new THREE.Mesh(tailGeo, this.tailMaterial);
      tail.position.set(side * 0.58, 0.72, -2.34);
      this.bodyGroup.add(tail);
    }

    const wheelGeo = buildWheel();
    this.owned.push(wheelGeo);
    const wheelMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const positions: Array<[number, number, number]> = [
      [0.86, 0.36, 1.36],
      [-0.86, 0.36, 1.36],
      [0.88, 0.36, -1.34],
      [-0.88, 0.36, -1.34],
    ];
    for (const [x, y, z] of positions) {
      const pivot = new THREE.Object3D();
      pivot.position.set(x, y, z);
      const mesh = new THREE.Mesh(wheelGeo, wheelMat);
      mesh.castShadow = castShadow;
      pivot.add(mesh);
      this.bodyGroup.add(pivot);
      this.wheelPivots.push(pivot);
      this.wheelMeshes.push(mesh);
    }

    this.group.add(this.bodyGroup);

    if (!blobTexture) blobTexture = makeBlobTexture();
    this.shadowBlob = new THREE.Mesh(
      new THREE.PlaneGeometry(4.6, 5.6),
      new THREE.MeshBasicMaterial({
        map: blobTexture,
        transparent: true,
        depthWrite: false,
        opacity: 0.75,
      }),
    );
    this.shadowBlob.rotation.x = -Math.PI / 2;
    this.shadowBlob.position.y = 0.06;
    this.shadowBlob.renderOrder = 2;
    this.group.add(this.shadowBlob);

    if (!beamTexture) beamTexture = makeBeamTexture();
    this.lightPool = new THREE.Mesh(
      new THREE.PlaneGeometry(11, 26),
      new THREE.MeshBasicMaterial({
        map: beamTexture,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0.7,
      }),
    );
    this.lightPool.rotation.x = -Math.PI / 2;
    // The texture runs bumper-to-throw along its own +Y, which lands on world
    // -Z once the plane is laid flat; spin it so the beam points forward.
    this.lightPool.rotation.z = Math.PI;
    this.lightPool.position.set(0, 0.05, 14);
    this.lightPool.renderOrder = 4;
    this.lightPool.visible = false;
    this.group.add(this.lightPool);
  }

  /** Front wheels turn, all four spin, body leans. */
  updateVisuals(
    steerAngle: number,
    wheelSpin: number,
    pitch: number,
    roll: number,
    brake01: number,
    headlightsOn: boolean,
    groundHeight: number,
  ): void {
    this.wheelPivots[0].rotation.y = steerAngle;
    this.wheelPivots[1].rotation.y = steerAngle;
    for (const mesh of this.wheelMeshes) mesh.rotation.x = wheelSpin;

    this.bodyGroup.rotation.x = pitch;
    this.bodyGroup.rotation.z = roll;

    const t = clamp01(brake01);
    this.tailMaterial.color.setRGB(lerp(0.32, 1, t), lerp(0.06, 0.12, t), lerp(0.08, 0.12, t));
    this.headMaterial.color.setRGB(
      headlightsOn ? 1 : 0.55,
      headlightsOn ? 0.95 : 0.52,
      headlightsOn ? 0.82 : 0.45,
    );

    // The blob rides on the ground even when the car is airborne, and fades out
    // with altitude so a jump reads properly.
    const altitude = Math.max(0, this.group.position.y - groundHeight);
    this.shadowBlob.position.y = groundHeight - this.group.position.y + 0.06;
    const mat = this.shadowBlob.material as THREE.MeshBasicMaterial;
    mat.opacity = 0.75 * clamp01(1 - altitude / 6);
    this.shadowBlob.rotation.z = -this.group.rotation.y;

    this.lightPool.visible = headlightsOn;
    if (headlightsOn) {
      this.lightPool.position.y = groundHeight - this.group.position.y + 0.05;
    }
  }

  setShadowBlobVisible(visible: boolean): void {
    this.shadowBlob.visible = visible;
  }

  dispose(): void {
    for (const g of this.owned) g.dispose();
    this.bodyMaterial.dispose();
    this.headMaterial.dispose();
    this.tailMaterial.dispose();
    this.shadowBlob.geometry.dispose();
    (this.shadowBlob.material as THREE.Material).dispose();
    this.lightPool.geometry.dispose();
    (this.lightPool.material as THREE.Material).dispose();
  }
}
