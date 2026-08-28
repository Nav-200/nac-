import * as THREE from 'three';
import { QUALITY, type QualitySettings, type QualityTier } from '../types';
import { clamp } from './math';

export interface EngineHooks {
  /** Deterministic simulation step. Always called with FIXED_DT. */
  fixedUpdate(dt: number): void;
  /**
   * Per-frame work: camera, interpolation, effects.
   * `alpha` is the 0..1 blend between the previous and current fixed states.
   */
  frameUpdate(dt: number, alpha: number): void;
}

/** Physics runs at a fixed 120Hz so handling is identical on any display. */
export const FIXED_DT = 1 / 120;
const MAX_FRAME_DT = 0.1;

/**
 * Owns the renderer, scene, camera and the main loop.
 *
 * Deliberately dumb about gameplay: `Game` supplies the hooks. The only policy
 * living here is the frame pacing and the adaptive resolution controller, both
 * of which exist to keep the game smooth on phones.
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;

  quality: QualitySettings;

  private hooks: EngineHooks | null = null;
  private rafId = 0;
  private running = false;
  private lastTime = 0;
  private accumulator = 0;

  // Adaptive resolution state.
  private resolutionScale = 1;
  private targetScale = 1;
  private frameTimeAvg = 16.7;
  private slowStreak = 0;
  private fastStreak = 0;
  private basePixelRatio = 1;

  // Rolling fps estimate for the HUD.
  fps = 60;

  /** Fired once if sustained slowness suggests dropping to the low tier. */
  onQualityDrop: ((tier: QualityTier) => void) | null = null;
  private qualityDropped = false;
  private heavyStreak = 0;

  constructor(canvas: HTMLCanvasElement, tier: QualityTier = 'high') {
    this.canvas = canvas;
    this.quality = QUALITY[tier];

    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // Antialiasing is nearly free visually at high DPR, so only pay for it
      // when the screen is not dense enough to hide the jaggies on its own.
      antialias: dpr < 1.5,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.renderer.setClearColor(0x8fc6e8, 1);
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      64,
      1,
      0.35,
      this.quality.drawDistance,
    );

    this.applyPixelRatio();
    this.resize();

    window.addEventListener('resize', this.handleResize, { passive: true });
    window.addEventListener('orientationchange', this.handleResize, { passive: true });
    document.addEventListener('visibilitychange', this.handleVisibility);
  }

  setHooks(hooks: EngineHooks): void {
    this.hooks = hooks;
  }

  setQuality(tier: QualityTier): void {
    this.quality = QUALITY[tier];
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.camera.far = this.quality.drawDistance;
    this.camera.updateProjectionMatrix();
    this.applyPixelRatio();
    this.resize();
  }

  private applyPixelRatio(): void {
    const dpr = window.devicePixelRatio || 1;
    this.basePixelRatio = Math.min(dpr, this.quality.maxPixelRatio);
  }

  private handleResize = (): void => {
    this.resize();
  };

  private handleVisibility = (): void => {
    if (document.hidden) {
      this.pauseLoop();
    } else if (this.running) {
      // Reset the clock so the hidden interval does not arrive as one huge dt.
      this.lastTime = performance.now();
      this.accumulator = 0;
      this.scheduleFrame();
    }
  };

  resize(): void {
    const parent = this.canvas.parentElement;
    const width = Math.max(1, parent ? parent.clientWidth : window.innerWidth);
    const height = Math.max(1, parent ? parent.clientHeight : window.innerHeight);

    this.renderer.setPixelRatio(this.basePixelRatio * this.resolutionScale);
    this.renderer.setSize(width, height, false);
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';

    this.camera.aspect = width / height;
    // A slightly wider field of view on landscape phones keeps the sense of speed
    // without stretching the car.
    this.camera.updateProjectionMatrix();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.scheduleFrame();
  }

  stop(): void {
    this.running = false;
    this.pauseLoop();
  }

  private pauseLoop(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  private scheduleFrame(): void {
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(this.tick);
  }

  private tick = (now: number): void => {
    this.rafId = 0;
    if (!this.running) return;
    this.scheduleFrame();

    const rawDt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    // Clamp so a stall cannot teleport the car through the world.
    const dt = clamp(rawDt, 0, MAX_FRAME_DT);

    this.updateAdaptiveResolution(rawDt * 1000);

    const hooks = this.hooks;
    if (hooks) {
      this.accumulator += dt;
      // MAX_FRAME_DT worth of steps, so a slow frame is caught up in full and
      // the simulation never silently runs behind real time.
      const maxSteps = Math.ceil(MAX_FRAME_DT / FIXED_DT);
      let steps = 0;
      while (this.accumulator >= FIXED_DT && steps < maxSteps) {
        hooks.fixedUpdate(FIXED_DT);
        this.accumulator -= FIXED_DT;
        steps++;
      }
      if (steps === maxSteps) this.accumulator = 0;

      const alpha = this.accumulator / FIXED_DT;
      hooks.frameUpdate(dt, alpha);
    }

    this.renderer.render(this.scene, this.camera);
  };

  /**
   * Nudges the render resolution to hold the frame budget. Uses separate
   * streak counters (rather than a single average) so the scale only moves
   * after a trend, never on a one-off hitch.
   */
  private updateAdaptiveResolution(frameMs: number): void {
    if (frameMs <= 0 || frameMs > 200) return;
    this.frameTimeAvg += (frameMs - this.frameTimeAvg) * 0.1;
    this.fps = 1000 / this.frameTimeAvg;

    if (this.frameTimeAvg > 20.5) {
      this.slowStreak++;
      this.fastStreak = 0;
    } else if (this.frameTimeAvg < 13.5) {
      this.fastStreak++;
      this.slowStreak = 0;
    } else {
      this.slowStreak = 0;
      this.fastStreak = 0;
    }

    const min = this.quality.minResolutionScale;
    if (this.slowStreak > 45) {
      this.targetScale = clamp(this.targetScale - 0.1, min, 1);
      this.slowStreak = 0;
    } else if (this.fastStreak > 180) {
      this.targetScale = clamp(this.targetScale + 0.05, min, 1);
      this.fastStreak = 0;
    }

    if (Math.abs(this.targetScale - this.resolutionScale) > 0.001) {
      this.resolutionScale = this.targetScale;
      this.resize();
    }

    // If we are pinned at the minimum scale and still slow, the fill rate is
    // not the problem: ask the game to shed geometry and effects instead.
    if (!this.qualityDropped && this.resolutionScale <= min + 0.001 && this.frameTimeAvg > 22) {
      this.heavyStreak++;
      if (this.heavyStreak > 120) {
        this.qualityDropped = true;
        this.onQualityDrop?.('low');
      }
    } else {
      this.heavyStreak = 0;
    }
  }

  getResolutionScale(): number {
    return this.resolutionScale;
  }

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('orientationchange', this.handleResize);
    document.removeEventListener('visibilitychange', this.handleVisibility);

    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = (mesh as THREE.Mesh).material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) (mat as THREE.Material).dispose();
    });
    this.scene.clear();
    this.renderer.dispose();
  }
}
