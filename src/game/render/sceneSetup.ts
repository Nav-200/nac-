/**
 * Renderer, camera, lights, sky dome, stars, fog and the day/night mapping.
 */
import * as THREE from 'three';
import { CAM_FAR, CAM_FOV, CAM_NEAR, FOG_FAR_DAY, FOG_FAR_NIGHT, FOG_NEAR_DAY, FOG_NEAR_NIGHT, SHADOW_MAP_SIZE, SHADOW_RADIUS } from '../core/constants';
import { clamp01, lerp, smoothstep } from '../core/mathUtils';
import { Rng } from '../core/rng';

const SKY_VERT = `
varying vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const SKY_FRAG = `
uniform vec3 topColor;
uniform vec3 horizonColor;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform float sunSize;
uniform float night;
varying vec3 vWorldPos;
void main() {
  vec3 dir = normalize(vWorldPos - cameraPosition);
  float h = clamp(dir.y, -0.1, 1.0);
  float t = pow(1.0 - clamp(h, 0.0, 1.0), 2.2);
  vec3 col = mix(topColor, horizonColor, t);
  float sd = max(dot(dir, sunDir), 0.0);
  float disc = smoothstep(1.0 - sunSize, 1.0 - sunSize * 0.35, sd);
  float glow = pow(sd, 18.0) * 0.55 + pow(sd, 4.0) * 0.12;
  col += sunColor * (disc * 1.6 + glow) * (1.0 - night * 0.7);
  // below the horizon fade to the ground haze colour
  col = mix(col, horizonColor * 0.85, smoothstep(0.0, -0.1, dir.y));
  gl_FragColor = vec4(col, 1.0);
}`;

export interface DayState {
  night: number; // 0 day .. 1 night
  sunDir: THREE.Vector3;
  sunset: number; // 0..1 warmth
}

export class SceneSetup {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly ambient: THREE.AmbientLight;
  readonly sky: THREE.Mesh;
  readonly stars: THREE.Points;
  private skyMat: THREE.ShaderMaterial;
  private starsMat: THREE.PointsMaterial;
  private fog: THREE.Fog;
  readonly day: DayState = { night: 0, sunDir: new THREE.Vector3(0, 1, 0), sunset: 0 };
  private shadowsEnabled = true;
  private tmpColorA = new THREE.Color();
  private tmpColorB = new THREE.Color();
  private tmpColorC = new THREE.Color();

  constructor(public readonly canvas: HTMLCanvasElement, opts: { shadows?: boolean; pixelRatio?: number } = {}) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', stencil: false });
    this.renderer.setPixelRatio(Math.min(opts.pixelRatio ?? window.devicePixelRatio ?? 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.shadowsEnabled = opts.shadows ?? true;
    this.renderer.shadowMap.enabled = this.shadowsEnabled;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.camera = new THREE.PerspectiveCamera(CAM_FOV, 1, CAM_NEAR, CAM_FAR);
    this.camera.position.set(0, 30, -60);
    this.camera.lookAt(0, 0, 0);

    this.fog = new THREE.Fog(0xcfe3f7, FOG_NEAR_DAY, FOG_FAR_DAY);
    this.scene.fog = this.fog;

    this.sun = new THREE.DirectionalLight(0xffffff, 2.4);
    this.sun.castShadow = this.shadowsEnabled;
    this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 900;
    this.sun.shadow.camera.left = -SHADOW_RADIUS;
    this.sun.shadow.camera.right = SHADOW_RADIUS;
    this.sun.shadow.camera.top = SHADOW_RADIUS;
    this.sun.shadow.camera.bottom = -SHADOW_RADIUS;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x6d6a5a, 0.7);
    this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0x223355, 0.0);
    this.scene.add(this.ambient);

    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: {
        topColor: { value: new THREE.Color(0x3d7fd1) },
        horizonColor: { value: new THREE.Color(0xcfe3f7) },
        sunDir: { value: new THREE.Vector3(0, 1, 0) },
        sunColor: { value: new THREE.Color(0xfff3d0) },
        sunSize: { value: 0.012 },
        night: { value: 0 },
      },
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(CAM_FAR * 0.95, 32, 16), this.skyMat);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    // Stars
    const rng = new Rng(99);
    const n = 1400;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = rng.next();
      const v = rng.next();
      const theta = u * Math.PI * 2;
      const phi = Math.acos(1 - v) * 0.5; // upper hemisphere biased to zenith
      const r = CAM_FAR * 0.9;
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.cos(phi) * 0.95 + 20;
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.starsMat = new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false });
    this.stars = new THREE.Points(starGeo, this.starsMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -9;
    this.scene.add(this.stars);

    this.resize();
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setShadows(on: boolean): void {
    if (on === this.shadowsEnabled) return;
    this.shadowsEnabled = on;
    this.renderer.shadowMap.enabled = on;
    this.sun.castShadow = on;
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.material) {
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) mat.needsUpdate = true;
      }
    });
  }

  /**
   * Apply a time of day (0 = midnight, 0.5 = noon). Sun rises at 06:00, sets at 18:00.
   */
  setTimeOfDay(t01: number): DayState {
    const a = (t01 - 0.25) * Math.PI * 2; // 0 at sunrise, π at sunset
    const elev = Math.sin(a); // -1..1
    const dayness = smoothstep(-0.08, 0.18, elev);
    const night = 1 - dayness;
    const sunset = clamp01(1 - Math.abs(elev) * 3.2) * dayness; // warm near the horizon
    // Sun direction: arcs east → west; at night we light with a dim moon from the opposite side.
    const az = Math.cos(a);
    const sunDir = this.day.sunDir;
    if (elev > -0.05) sunDir.set(az * 0.7, Math.max(0.06, elev), 0.5 * (1 - Math.abs(az)) + 0.15).normalize();
    else sunDir.set(-az * 0.5, 0.55, -0.4).normalize();
    this.day.night = night;
    this.day.sunset = sunset;

    // Light colours
    const sunDay = this.tmpColorA.setHex(0xfff2dc).lerp(this.tmpColorB.setHex(0xff9a4a), sunset);
    const moon = this.tmpColorC.setHex(0x7f93c8);
    this.sun.color.copy(sunDay).lerp(moon, night);
    this.sun.intensity = lerp(0.7, 2.6, dayness) * (1 - sunset * 0.3);
    this.sun.position.copy(sunDir).multiplyScalar(320).add(this.sun.target.position);
    this.hemi.intensity = lerp(0.42, 0.75, dayness);
    this.hemi.color.setHex(0xbfd8ff).lerp(this.tmpColorB.setHex(0x34456e), night);
    this.hemi.groundColor.setHex(0x6d6a5a).lerp(this.tmpColorB.setHex(0x1a1c26), night);
    this.ambient.intensity = night * 0.55;

    // Sky
    const top = this.tmpColorA.setHex(0x3d7fd1).lerp(this.tmpColorB.setHex(0x1b3f8a), sunset * 0.6).lerp(this.tmpColorC.setHex(0x050a1c), night);
    (this.skyMat.uniforms.topColor.value as THREE.Color).copy(top);
    const horizon = this.tmpColorA.setHex(0xcfe3f7).lerp(this.tmpColorB.setHex(0xffa860), sunset).lerp(this.tmpColorC.setHex(0x101a30), night);
    (this.skyMat.uniforms.horizonColor.value as THREE.Color).copy(horizon);
    (this.skyMat.uniforms.sunDir.value as THREE.Vector3).copy(sunDir);
    (this.skyMat.uniforms.sunColor.value as THREE.Color).setHex(0xfff3d0).lerp(this.tmpColorB.setHex(0xff8a3a), sunset).multiplyScalar(elev > -0.05 ? 1 : 0.25);
    this.skyMat.uniforms.night.value = night;
    this.starsMat.opacity = night * 0.9;

    // Fog (matches horizon)
    this.fog.color.copy(horizon);
    this.fog.near = lerp(FOG_NEAR_DAY, FOG_NEAR_NIGHT, night);
    this.fog.far = lerp(FOG_FAR_DAY, FOG_FAR_NIGHT, night);
    this.renderer.toneMappingExposure = lerp(1.05, 1.0, night);
    return this.day;
  }

  /** Keep the shadow frustum, sky dome and stars centred on the player. */
  follow(x: number, y: number, z: number): void {
    this.sun.target.position.set(x, y, z);
    this.sun.position.copy(this.day.sunDir).multiplyScalar(320).add(this.sun.target.position);
    this.sun.target.updateMatrixWorld();
    this.sky.position.set(x, 0, z);
    this.stars.position.set(x, 0, z);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.renderer.dispose();
  }
}
