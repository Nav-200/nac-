import * as THREE from 'three';
import { baseTerrainHeight, MAP_HALF } from './heightfield';
import { makeRoadHit, type Road } from './road';

export interface LakeSite {
  x: number;
  z: number;
  radius: number;
  /** World-space height of the water surface. */
  level: number;
}

/**
 * Finds a hollow in the raw terrain far enough from the road to hold a lake.
 * Returns null when the map's noise happens not to offer one — the game simply
 * ships without a lake in that case rather than flooding the road.
 */
export const findLakeSite = (road: Road): LakeSite | null => {
  const hit = makeRoadHit();
  let best: { x: number; z: number; h: number } | null = null;
  const step = 48;
  for (let z = -MAP_HALF * 0.7; z <= MAP_HALF * 0.7; z += step) {
    for (let x = -MAP_HALF * 0.7; x <= MAP_HALF * 0.7; x += step) {
      road.query(x, z, hit);
      if (hit.dist < 120) continue;
      const h = baseTerrainHeight(x, z);
      if (!best || h < best.h) best = { x, z, h };
    }
  }
  if (!best) return null;
  // The basin is carved below the natural low point, so this always works.
  return { x: best.x, z: best.z, radius: 62, level: best.h - 2.2 };
};

const WATER_VERT = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec3 p = position;
  vec4 world = modelMatrix * vec4(p, 1.0);
  // Two crossing low-frequency swells; enough motion to catch the eye.
  world.y += sin(world.x * 0.18 + uTime * 1.1) * 0.05
           + cos(world.z * 0.22 + uTime * 0.8) * 0.05;
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const WATER_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uSunDir;
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  // Moving interference bands play the part of ripples.
  float ripple = sin(vWorld.x * 1.3 + uTime * 1.6) * sin(vWorld.z * 1.1 - uTime * 1.2);
  vec3 col = mix(uShallow, uDeep, clamp(1.0 - r + ripple * 0.08, 0.0, 1.0));
  // A stripe of sun glitter.
  float glint = pow(max(ripple, 0.0), 6.0) * max(uSunDir.y, 0.0);
  col += vec3(1.0, 0.95, 0.8) * glint * 0.35;
  float alpha = mix(0.88, 0.55, smoothstep(0.75, 1.0, r));
  gl_FragColor = vec4(col, alpha);
}
`;

/** The lake surface: one alpha-blended disc with an animated ripple shader. */
export class Water {
  readonly mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;

  constructor(site: LakeSite) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uDeep: { value: new THREE.Color(0x14425e) },
        uShallow: { value: new THREE.Color(0x2f7d8c) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      },
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.CircleGeometry(site.radius, 40), this.material);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.set(site.x, site.level, site.z);
    this.mesh.renderOrder = 2;
  }

  update(dt: number, sunDirection: THREE.Vector3): void {
    this.material.uniforms.uTime.value += dt;
    (this.material.uniforms.uSunDir.value as THREE.Vector3).copy(sunDirection);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
