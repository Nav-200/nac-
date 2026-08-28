import * as THREE from 'three';
import { wrapAngle } from '../engine/math';
import { mergeParts } from './geometryUtils';
import type { Road } from './road';
import type { Terrain } from './terrain';

export interface ColliderItem {
  x: number;
  z: number;
  r: number;
  hard: boolean;
}

/** One red/white chevron board, coloured in halves via vertex colours. */
const buildChevronBoard = (): THREE.BufferGeometry =>
  mergeParts([
    { geometry: new THREE.BoxGeometry(0.9, 0.85, 0.14), color: 0xd8362a, position: [-0.45, 0.62, 0] },
    { geometry: new THREE.BoxGeometry(0.9, 0.85, 0.14), color: 0xf2efe4, position: [0.45, 0.62, 0] },
    { geometry: new THREE.BoxGeometry(0.1, 0.5, 0.1), color: 0x40403c, position: [-0.6, 0.12, 0] },
    { geometry: new THREE.BoxGeometry(0.1, 0.5, 0.1), color: 0x40403c, position: [0.6, 0.12, 0] },
  ]);

const bannerTexture = (): THREE.Texture => {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 96;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#101722';
  ctx.fillRect(0, 0, 512, 96);
  // Checker strip along the bottom edge.
  for (let i = 0; i < 32; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#e8e6da' : '#15181d';
    ctx.fillRect(i * 16, 78, 16, 18);
  }
  ctx.font = 'bold 52px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#53e0ff';
  ctx.fillText('HORIZON RUSH', 256, 40);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 2;
  return tex;
};

/**
 * The furniture that makes the loop read as a race track: chevron boards on
 * the outside of the sharpest corners and a start/finish arch. Everything
 * solid reports its collider circles so the scenery grid can absorb them.
 */
export class Trackside {
  readonly group = new THREE.Group();
  readonly colliders: ColliderItem[] = [];
  private disposables: Array<{ dispose(): void }> = [];

  constructor(road: Road, terrain: Terrain) {
    this.group.name = 'trackside';
    this.buildChevrons(road, terrain);
    this.buildArch(road);
  }

  private buildChevrons(road: Road, terrain: Terrain): void {
    // Find corner apexes: local maxima of curvature above a threshold, then
    // fan a handful of boards along the outside of each.
    const n = road.count;
    const spacingSamples = 2; // boards every ~8 m of arc
    const placements: Array<{ x: number; z: number; y: number; yaw: number }> = [];

    let i = 0;
    while (i < n) {
      const curv = road.curvatureAt(i, 8);
      if (curv > 0.012) {
        // Which side is the outside? The heading turns toward the inside.
        const turn = wrapAngle(road.headingAt((i + 8) % n) - road.headingAt(i));
        const outside = turn > 0 ? -1 : 1;
        const span = 7; // boards across ~7 samples (28 m) of the corner
        for (let k = -span; k <= span; k += spacingSamples) {
          const idx = (((i + k) % n) + n) % n;
          if (road.curvatureAt(idx, 8) < 0.009) continue;
          const off = (road.halfWidth + road.shoulder + 1.1) * outside;
          const x = road.px[idx] + road.nx[idx] * off;
          const z = road.pz[idx] + road.nz[idx] * off;
          placements.push({
            x,
            z,
            y: Math.min(road.py[idx], terrain.heightAt(x, z)),
            yaw: road.headingAt(idx),
          });
        }
        i += span + 6; // skip past this corner
      } else {
        i += 3;
      }
    }

    if (placements.length === 0) return;
    const geo = buildChevronBoard();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.disposables.push(geo, mat);
    const mesh = new THREE.InstancedMesh(geo, mat, placements.length);
    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3(1, 1, 1);
    const axis = new THREE.Vector3(0, 1, 0);
    for (let k = 0; k < placements.length; k++) {
      const p = placements[k];
      pos.set(p.x, p.y, p.z);
      quat.setFromAxisAngle(axis, p.yaw);
      matrix.compose(pos, quat, scl);
      mesh.setMatrixAt(k, matrix);
      this.colliders.push({ x: p.x, z: p.z, r: 0.85, hard: true });
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
  }

  private buildArch(road: Road): void {
    const idx = road.indexAtDistance(0);
    const heading = road.headingAt(idx);
    const halfSpan = road.halfWidth + road.shoulder + 0.6;

    const arch = new THREE.Group();
    arch.position.set(road.px[idx], road.py[idx], road.pz[idx]);
    arch.rotation.y = heading;

    const pillarGeo = new THREE.BoxGeometry(0.7, 8.4, 0.7);
    const pillarMat = new THREE.MeshLambertMaterial({ color: 0x1b222d });
    this.disposables.push(pillarGeo, pillarMat);
    for (const side of [-1, 1]) {
      const pillar = new THREE.Mesh(pillarGeo, pillarMat);
      pillar.position.set(side * halfSpan, 4.2, 0);
      arch.add(pillar);
      // World-space collider for each pillar.
      const wx = arch.position.x + Math.cos(heading) * side * halfSpan;
      const wz = arch.position.z - Math.sin(heading) * side * halfSpan;
      this.colliders.push({ x: wx, z: wz, r: 0.8, hard: true });
    }

    const tex = bannerTexture();
    const bannerGeo = new THREE.PlaneGeometry(halfSpan * 2 + 0.7, 1.7);
    const bannerMat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
    this.disposables.push(bannerGeo, bannerMat, tex);
    const banner = new THREE.Mesh(bannerGeo, bannerMat);
    banner.position.y = 7.6;
    arch.add(banner);

    this.group.add(arch);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
