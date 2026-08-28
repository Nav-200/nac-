import { clamp, moveToward } from './math';

/**
 * Aggregates every control source (touch overlay, keyboard, device tilt) into a
 * single state object the vehicle reads. Touch handlers write the *target*
 * values; `update` ramps the actual values toward them so a binary button press
 * still produces analog-feeling steering.
 */
export class Input {
  /** Smoothed steering, -1 (left) .. 1 (right). */
  steer = 0;
  throttle = 0;
  brake = 0;
  handbrake = false;
  nitro = false;
  /** When on, the throttle is held for the player unless they brake. */
  autoThrottle = false;

  // Touch-owned button state, kept apart from the merged outputs above so a
  // keyboard press can never latch through the feedback of its own output.
  private touchHandbrake = false;
  private touchNitro = false;

  private steerTarget = 0;
  private throttleTarget = 0;
  private brakeTarget = 0;

  /** Set by the tilt listener when tilt steering is enabled. */
  private tiltSteer = 0;
  private tiltEnabled = false;
  private tiltZero = 0;
  private tiltCalibrated = false;

  private keys = new Set<string>();
  private cameraPressed = false;
  private resetPressed = false;

  /** How fast steering winds on and springs back, in units per second. */
  private static readonly STEER_ON = 3.4;
  private static readonly STEER_OFF = 6.5;

  attach(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.releaseAll);
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.releaseAll);
    this.disableTilt();
    this.releaseAll();
  }

  // --- Touch overlay API ---------------------------------------------------

  setSteerInput(v: number): void {
    this.steerTarget = clamp(v, -1, 1);
  }

  setThrottleInput(v: number): void {
    this.throttleTarget = clamp(v, 0, 1);
  }

  setBrakeInput(v: number): void {
    this.brakeTarget = clamp(v, 0, 1);
  }

  setHandbrakeInput(down: boolean): void {
    this.touchHandbrake = down;
  }

  setNitroInput(down: boolean): void {
    this.touchNitro = down;
  }

  pressCamera(): void {
    this.cameraPressed = true;
  }

  pressReset(): void {
    this.resetPressed = true;
  }

  /** One-shot reads; returns true at most once per press. */
  consumeCamera(): boolean {
    const v = this.cameraPressed;
    this.cameraPressed = false;
    return v;
  }

  consumeReset(): boolean {
    const v = this.resetPressed;
    this.resetPressed = false;
    return v;
  }

  releaseAll = (): void => {
    this.keys.clear();
    this.steerTarget = 0;
    this.throttleTarget = 0;
    this.brakeTarget = 0;
    this.handbrake = false;
    this.nitro = false;
    this.touchHandbrake = false;
    this.touchNitro = false;
  };

  // --- Tilt ----------------------------------------------------------------

  async enableTilt(): Promise<boolean> {
    type PermissionCapable = { requestPermission?: () => Promise<string> };
    const DOE = (window as unknown as { DeviceOrientationEvent?: PermissionCapable })
      .DeviceOrientationEvent;
    if (!DOE) return false;
    if (typeof DOE.requestPermission === 'function') {
      try {
        const res = await DOE.requestPermission();
        if (res !== 'granted') return false;
      } catch {
        return false;
      }
    }
    this.tiltCalibrated = false;
    this.tiltEnabled = true;
    window.addEventListener('deviceorientation', this.onOrientation);
    return true;
  }

  disableTilt(): void {
    if (!this.tiltEnabled) return;
    this.tiltEnabled = false;
    this.tiltSteer = 0;
    window.removeEventListener('deviceorientation', this.onOrientation);
  }

  get isTiltEnabled(): boolean {
    return this.tiltEnabled;
  }

  private onOrientation = (e: DeviceOrientationEvent): void => {
    // In landscape the device's gamma axis is the one the player rolls.
    const raw = e.gamma ?? 0;
    if (!this.tiltCalibrated) {
      this.tiltZero = raw;
      this.tiltCalibrated = true;
    }
    const delta = raw - this.tiltZero;
    // 28 degrees of roll for full lock: enough travel to be precise, little
    // enough that you are not waving the phone around.
    this.tiltSteer = clamp(delta / 28, -1, 1);
  };

  // --- Keyboard ------------------------------------------------------------

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    this.keys.add(e.code);
    if (e.code === 'KeyC') this.pressCamera();
    if (e.code === 'KeyR') this.pressReset();
    if (
      e.code === 'Space' ||
      e.code === 'ArrowUp' ||
      e.code === 'ArrowDown' ||
      e.code === 'ArrowLeft' ||
      e.code === 'ArrowRight'
    ) {
      e.preventDefault();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private keyAxis(): {
    steer: number;
    throttle: number;
    brake: number;
    hb: boolean;
    nitro: boolean;
  } {
    const k = this.keys;
    const left = k.has('ArrowLeft') || k.has('KeyA') ? 1 : 0;
    const right = k.has('ArrowRight') || k.has('KeyD') ? 1 : 0;
    const up = k.has('ArrowUp') || k.has('KeyW') ? 1 : 0;
    const down = k.has('ArrowDown') || k.has('KeyS') ? 1 : 0;
    return {
      steer: right - left,
      throttle: up,
      brake: down,
      hb: k.has('Space'),
      nitro: k.has('ShiftLeft') || k.has('ShiftRight'),
    };
  }

  update(dt: number): void {
    const kb = this.keyAxis();

    let steerTarget = this.steerTarget;
    if (kb.steer !== 0) steerTarget = kb.steer;
    else if (this.tiltEnabled && Math.abs(this.tiltSteer) > 0.06) steerTarget = this.tiltSteer;

    let throttleTarget = Math.max(this.throttleTarget, kb.throttle);
    const brakeTarget = Math.max(this.brakeTarget, kb.brake);
    const handbrake = this.touchHandbrake || kb.hb;
    const nitro = this.touchNitro || kb.nitro;

    // Auto-throttle: full gas unless the player is braking. Standard mobile
    // racer accessibility — it frees the right thumb for brake and nitro.
    if (this.autoThrottle && brakeTarget < 0.05) throttleTarget = 1;

    // Springing back to centre faster than winding on is what makes a two-button
    // steering scheme feel like a wheel rather than a switch.
    const towardCentre = Math.abs(steerTarget) < Math.abs(this.steer) ||
      Math.sign(steerTarget) !== Math.sign(this.steer);
    const rate = towardCentre ? Input.STEER_OFF : Input.STEER_ON;
    this.steer = moveToward(this.steer, steerTarget, rate * dt);

    this.throttle = moveToward(this.throttle, throttleTarget, 5 * dt);
    this.brake = moveToward(this.brake, brakeTarget, 8 * dt);
    this.handbrake = handbrake;
    this.nitro = nitro;
  }
}
