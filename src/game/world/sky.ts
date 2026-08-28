import * as THREE from 'three';
import type { QualitySettings } from '../types';

export type TimeOfDay = 'dawn' | 'golden' | 'noon' | 'dusk' | 'night';

interface SkyPreset {
  /** Sun elevation and compass angle, in radians. */
  elevation: number;
  azimuth: number;
  zenith: number;
  horizon: number;
  sunColor: number;
  sunIntensity: number;
  ambientSky: number;
  ambientGround: number;
  ambientIntensity: number;
  fogColor: number;
  exposure: number;
  clouds: number;
  stars: number;
}

const PRESETS: Record<TimeOfDay, SkyPreset> = {
  dawn: {
    elevation: 0.16,
    azimuth: -1.1,
    zenith: 0x2f5f9e,
    horizon: 0xf0a878,
    sunColor: 0xffcfa0,
    sunIntensity: 1.9,
    ambientSky: 0x8fb2df,
    ambientGround: 0x6a5a44,
    ambientIntensity: 0.75,
    fogColor: 0xe6b394,
    exposure: 1.0,
    clouds: 0.34,
    stars: 0.15,
  },
  golden: {
    elevation: 0.26,
    azimuth: -0.7,
    zenith: 0x2b6bb5,
    horizon: 0xffc98a,
    sunColor: 0xffd7a3,
    sunIntensity: 2.5,
    ambientSky: 0x9dc2ea,
    ambientGround: 0x7a6a4a,
    ambientIntensity: 0.8,
    fogColor: 0xf3c79a,
    exposure: 1.08,
    clouds: 0.3,
    stars: 0,
  },
  noon: {
    elevation: 1.1,
    azimuth: -0.4,
    zenith: 0x1f63c4,
    horizon: 0xbcd9f2,
    sunColor: 0xfff6e6,
    sunIntensity: 3.0,
    ambientSky: 0xb6d5f2,
    ambientGround: 0x7d7a5e,
    ambientIntensity: 0.95,
    fogColor: 0xc6dcf0,
    exposure: 1.0,
    clouds: 0.46,
    stars: 0,
  },
  dusk: {
    elevation: 0.07,
    azimuth: 2.3,
    zenith: 0x1d2f66,
    horizon: 0xff8a5c,
    sunColor: 0xff9d63,
    sunIntensity: 1.7,
    ambientSky: 0x6e7fbe,
    ambientGround: 0x5a4636,
    ambientIntensity: 0.7,
    fogColor: 0xdb8763,
    exposure: 1.12,
    clouds: 0.26,
    stars: 0.35,
  },
  night: {
    elevation: 0.55,
    azimuth: 1.4,
    zenith: 0x060b1c,
    horizon: 0x1b2542,
    sunColor: 0x9fb7e8,
    sunIntensity: 0.55,
    ambientSky: 0x2a3a63,
    ambientGround: 0x14161f,
    ambientIntensity: 0.42,
    fogColor: 0x131a2e,
    exposure: 1.25,
    clouds: 0.16,
    stars: 1,
  },
};

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  // Force the dome onto the far plane so it never clips the world.
  gl_Position.z = gl_Position.w;
}
`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uClouds;
uniform float uStars;
uniform float uTime;
varying vec3 vDir;

float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

void main() {
  vec3 dir = normalize(vDir);
  float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
  // Bias the gradient downward so most of the visible sky is the deep colour
  // and the warm band stays tight to the horizon.
  float t = pow(clamp((h - 0.5) * 2.0, 0.0, 1.0), 0.55);
  vec3 col = mix(uHorizon, uZenith, t);

  float sun = max(dot(dir, normalize(uSunDir)), 0.0);
  col += uSunColor * pow(sun, 220.0) * 2.4;        // disc
  col += uSunColor * pow(sun, 8.0) * 0.32;         // bloom
  col += uSunColor * pow(sun, 2.0) * 0.06;         // wide haze

  // Clouds: three octaves of value noise on the sky plane, drifting slowly.
  // Faded out at the horizon so they read as overhead cover, not a wall.
  if (uClouds > 0.001 && dir.y > 0.02) {
    vec2 p = dir.xz / (dir.y + 0.24);
    p = p * 1.7 + vec2(uTime * 0.008, uTime * 0.0045);
    float n = vnoise(p) * 0.55 + vnoise(p * 2.13 + 7.3) * 0.3 + vnoise(p * 4.31 + 2.1) * 0.15;
    float cover = smoothstep(1.0 - uClouds - 0.18, 1.0 - uClouds + 0.22, n);
    float horizonFade = smoothstep(0.02, 0.24, dir.y);
    vec3 cloudCol = mix(uHorizon, vec3(1.0), 0.55) * (0.72 + 0.28 * n);
    col = mix(col, cloudCol, cover * horizonFade * 0.85);
  }

  // Stars: sparse hash points, only meaningful after dark.
  if (uStars > 0.001 && dir.y > 0.0) {
    vec2 sp = dir.xz / (dir.y + 0.35) * 38.0;
    vec2 cell = floor(sp);
    float star = hash21(cell);
    if (star > 0.982) {
      vec2 centre = cell + vec2(hash21(cell + 1.7), hash21(cell + 3.1));
      float d = length(sp - centre);
      float tw = 0.75 + 0.25 * sin(uTime * (1.5 + star * 3.0) + star * 40.0);
      col += vec3(0.9, 0.95, 1.0) * uStars * tw * smoothstep(0.16, 0.0, d) * dir.y;
    }
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * Sky dome, sun, fog and ambient light. All four are driven from one preset so
 * the lighting always agrees with what the sky is doing.
 */
export class Sky {
  readonly dome: THREE.Mesh;
  readonly sun: THREE.DirectionalLight;
  readonly ambient: THREE.HemisphereLight;
  readonly sunDirection = new THREE.Vector3();

  private uniforms: {
    uZenith: { value: THREE.Color };
    uHorizon: { value: THREE.Color };
    uSunColor: { value: THREE.Color };
    uSunDir: { value: THREE.Vector3 };
    uClouds: { value: number };
    uStars: { value: number };
    uTime: { value: number };
  };
  private material: THREE.ShaderMaterial;
  private preset: SkyPreset = PRESETS.golden;
  private shadowRadius = 60;

  constructor(
    private scene: THREE.Scene,
    private renderer: THREE.WebGLRenderer,
    quality: QualitySettings,
  ) {
    this.uniforms = {
      uZenith: { value: new THREE.Color(0x2b6bb5) },
      uHorizon: { value: new THREE.Color(0xffc98a) },
      uSunColor: { value: new THREE.Color(0xffd7a3) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uClouds: { value: 0.3 },
      uStars: { value: 0 },
      uTime: { value: 0 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });

    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), this.material);
    this.dome.frustumCulled = false;
    // After the opaque world: the dome sits on the far plane with depth test
    // on, so every fragment covered by terrain is rejected before the cloud
    // noise runs. On a fill-rate-bound phone that overdraw is real money.
    this.dome.renderOrder = 500;
    scene.add(this.dome);

    this.sun = new THREE.DirectionalLight(0xffd7a3, 2.5);
    this.sun.castShadow = quality.shadows;
    this.configureShadow(quality);
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.ambient = new THREE.HemisphereLight(0x9dc2ea, 0x7a6a4a, 0.8);
    scene.add(this.ambient);

    scene.fog = new THREE.Fog(0xf3c79a, 60, quality.drawDistance * 0.97);

    this.setTimeOfDay('golden');
  }

  configureShadow(quality: QualitySettings): void {
    this.sun.castShadow = quality.shadows;
    const cam = this.sun.shadow.camera;
    const r = this.shadowRadius;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 1;
    cam.far = 400;
    cam.updateProjectionMatrix();
    this.sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    this.sun.shadow.bias = -0.0012;
    this.sun.shadow.normalBias = 0.6;
  }

  setTimeOfDay(time: TimeOfDay): void {
    const p = PRESETS[time];
    this.preset = p;

    this.sunDirection
      .set(
        Math.cos(p.elevation) * Math.sin(p.azimuth),
        Math.sin(p.elevation),
        Math.cos(p.elevation) * Math.cos(p.azimuth),
      )
      .normalize();

    this.uniforms.uZenith.value.setHex(p.zenith);
    this.uniforms.uHorizon.value.setHex(p.horizon);
    this.uniforms.uSunColor.value.setHex(p.sunColor);
    this.uniforms.uSunDir.value.copy(this.sunDirection);
    this.uniforms.uClouds.value = p.clouds;
    this.uniforms.uStars.value = p.stars;

    this.sun.color.setHex(p.sunColor);
    this.sun.intensity = p.sunIntensity;

    this.ambient.color.setHex(p.ambientSky);
    this.ambient.groundColor.setHex(p.ambientGround);
    this.ambient.intensity = p.ambientIntensity;

    const fog = this.scene.fog as THREE.Fog;
    fog.color.setHex(p.fogColor);
    this.renderer.setClearColor(p.fogColor, 1);
    this.renderer.toneMappingExposure = p.exposure;
  }

  get isNight(): boolean {
    return this.preset === PRESETS.night;
  }

  setDrawDistance(distance: number): void {
    const fog = this.scene.fog as THREE.Fog;
    fog.near = distance * 0.14;
    fog.far = distance * 0.97;
  }

  /**
   * Keeps the dome centred on the camera and drags the shadow frustum along
   * with the car, so a small shadow map still covers what you can see.
   */
  update(dt: number, cameraPos: THREE.Vector3, focus: THREE.Vector3): void {
    this.uniforms.uTime.value += dt;
    this.dome.position.copy(cameraPos);
    this.dome.scale.setScalar(1);

    this.sun.target.position.copy(focus);
    this.sun.position
      .copy(this.sunDirection)
      .multiplyScalar(180)
      .add(focus);
    this.sun.target.updateMatrixWorld();
  }

  dispose(): void {
    this.dome.geometry.dispose();
    this.material.dispose();
  }
}
