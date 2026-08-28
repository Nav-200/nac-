import * as THREE from 'three';
import { makeRng, smoothstep, TAU } from '../engine/math';
import { MAP_HALF } from './heightfield';
import { makeRoadHit, type Road } from './road';
import type { Terrain } from './terrain';

const REGIONS = 3;

/**
 * Tufts of grass hugging the road corridor: two crossed quads per tuft,
 * instanced and bucketed by region like the rest of the scenery. They only
 * exist where the player actually looks — within ~26 m of the tarmac — which
 * keeps the triangle bill tiny for how much life they add at speed.
 */
export class Grass {
  readonly group = new THREE.Group();
  private geometry: THREE.BufferGeometry;
  private material: THREE.MeshLambertMaterial;

  constructor(road: Road, terrain: Terrain, waterLevel: number | null) {
    this.group.name = 'grass';

    // Crossed quads, vertex-coloured darker at the root.
    const positions = new Float32Array([
      // Quad A (facing Z)
      -0.5, 0, 0, 0.5, 0, 0, 0.5, 0.55, 0, -0.5, 0.55, 0,
      // Quad B (facing X)
      0, 0, -0.5, 0, 0, 0.5, 0, 0.55, 0.5, 0, 0.55, -0.5,
    ]);
    const colors = new Float32Array(8 * 3);
    for (let v = 0; v < 8; v++) {
      const top = positions[v * 3 + 1] > 0.1;
      colors[v * 3] = top ? 0.55 : 0.3;
      colors[v * 3 + 1] = top ? 0.68 : 0.45;
      colors[v * 3 + 2] = top ? 0.3 : 0.2;
    }
    const indices = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.geometry.computeVertexNormals();

    this.material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
    });

    const rng = makeRng(777001);
    const hit = makeRoadHit();
    const buckets: Array<Array<{ x: number; y: number; z: number; rot: number; s: number }>> = [];
    for (let i = 0; i < REGIONS * REGIONS; i++) buckets.push([]);
    const span = (MAP_HALF * 2) / REGIONS;

    // Walk the road and scatter tufts in a band beside it.
    const stride = 3;
    for (let i = 0; i < road.count; i += stride) {
      for (let t = 0; t < 3; t++) {
        const side = rng() < 0.5 ? 1 : -1;
        const off = (road.halfWidth + road.shoulder + 1.5 + rng() * 18) * side;
        const x = road.px[i] + road.nx[i] * off + (rng() - 0.5) * 4;
        const z = road.pz[i] + road.nz[i] * off + (rng() - 0.5) * 4;
        road.query(x, z, hit);
        if (hit.dist < road.halfWidth + road.shoulder + 0.6) continue;
        // Thin out with distance from the tarmac.
        if (rng() > smoothstep(28, 6, hit.dist)) continue;
        const y = terrain.heightAt(x, z);
        if (waterLevel !== null && y < waterLevel + 0.4) continue;
        const rx = Math.min(REGIONS - 1, Math.max(0, Math.floor((x + MAP_HALF) / span)));
        const rz = Math.min(REGIONS - 1, Math.max(0, Math.floor((z + MAP_HALF) / span)));
        buckets[rz * REGIONS + rx].push({ x, y, z, rot: rng() * TAU, s: 0.7 + rng() * 0.9 });
      }
    }

    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const axis = new THREE.Vector3(0, 1, 0);
    for (const bucket of buckets) {
      if (bucket.length === 0) continue;
      const mesh = new THREE.InstancedMesh(this.geometry, this.material, bucket.length);
      for (let k = 0; k < bucket.length; k++) {
        const p = bucket[k];
        pos.set(p.x, p.y, p.z);
        quat.setFromAxisAngle(axis, p.rot);
        scl.setScalar(p.s);
        matrix.compose(pos, quat, scl);
        mesh.setMatrixAt(k, matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
    }
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
