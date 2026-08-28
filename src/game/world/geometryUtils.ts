import * as THREE from 'three';

export interface PartSpec {
  geometry: THREE.BufferGeometry;
  color: number;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
}

/**
 * Merges a handful of primitives into one vertex-coloured geometry.
 *
 * three's BufferGeometryUtils lives in the untyped addons bundle, and all we
 * need is this: bake a transform and a flat colour into each part, then
 * concatenate. Everything is converted to non-indexed first so the parts can be
 * appended without remapping indices; these are tiny props, so the extra
 * vertices cost nothing next to the simplicity.
 */
export const mergeParts = (parts: PartSpec[]): THREE.BufferGeometry => {
  const matrix = new THREE.Matrix4();
  const euler = new THREE.Euler();
  const quat = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();

  const baked: Array<{ geo: THREE.BufferGeometry; color: THREE.Color }> = [];
  let vertexCount = 0;

  for (const part of parts) {
    const geo = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry.clone();
    if (part.geometry.index) part.geometry.dispose();

    const [px, py, pz] = part.position ?? [0, 0, 0];
    const [rx, ry, rz] = part.rotation ?? [0, 0, 0];
    const [sx, sy, sz] = part.scale ?? [1, 1, 1];
    pos.set(px, py, pz);
    euler.set(rx, ry, rz);
    quat.setFromEuler(euler);
    scl.set(sx, sy, sz);
    matrix.compose(pos, quat, scl);
    geo.applyMatrix4(matrix);

    baked.push({ geo, color: new THREE.Color(part.color) });
    vertexCount += geo.getAttribute('position').count;
  }

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);

  let offset = 0;
  for (const { geo, color } of baked) {
    const p = geo.getAttribute('position') as THREE.BufferAttribute;
    let nAttr = geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
    if (!nAttr) {
      geo.computeVertexNormals();
      nAttr = geo.getAttribute('normal') as THREE.BufferAttribute;
    }
    const count = p.count;
    positions.set(p.array as Float32Array, offset * 3);
    normals.set(nAttr.array as Float32Array, offset * 3);
    for (let i = 0; i < count; i++) {
      const o = (offset + i) * 3;
      colors[o] = color.r;
      colors[o + 1] = color.g;
      colors[o + 2] = color.b;
    }
    offset += count;
    geo.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  merged.computeBoundingSphere();
  return merged;
};
