/**
 * Keyboard + mouse input with pointer lock. Exposes an action-based snapshot the
 * simulation reads once per frame, plus a `simulate` override used by headless tests.
 */
export interface InputState {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  sprint: boolean;
  jump: boolean;
  handbrake: boolean;
  fire: boolean;
  aim: boolean;
  reload: boolean;
  interact: boolean; // enter/exit vehicle, pickup, mission trigger (edge-triggered)
  horn: boolean;
  nextWeapon: boolean; // edge
  prevWeapon: boolean; // edge
  weaponSlot: number; // -1 or 0..8 (edge)
  toggleMap: boolean; // edge
  pause: boolean; // edge
  toggleCamera: boolean; // edge
  toggleHeadlights: boolean; // edge
  nextRadio: boolean; // edge
  lookDX: number; // mouse delta this frame (pixels)
  lookDY: number;
  wheel: number; // wheel delta this frame
}

const KEY_BINDINGS: Record<string, keyof InputState | `slot${number}`> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  Space: 'jump',
  KeyF: 'interact',
  KeyE: 'interact',
  KeyR: 'reload',
  KeyH: 'horn',
  KeyM: 'toggleMap',
  Escape: 'pause',
  KeyP: 'pause',
  KeyV: 'toggleCamera',
  KeyL: 'toggleHeadlights',
  KeyN: 'nextRadio',
  KeyQ: 'prevWeapon',
  Tab: 'nextWeapon',
  Digit1: 'slot0',
  Digit2: 'slot1',
  Digit3: 'slot2',
  Digit4: 'slot3',
  Digit5: 'slot4',
  Digit6: 'slot5',
  Digit7: 'slot6',
};

function emptyState(): InputState {
  return {
    forward: false,
    back: false,
    left: false,
    right: false,
    sprint: false,
    jump: false,
    handbrake: false,
    fire: false,
    aim: false,
    reload: false,
    interact: false,
    horn: false,
    nextWeapon: false,
    prevWeapon: false,
    weaponSlot: -1,
    toggleMap: false,
    pause: false,
    toggleCamera: false,
    toggleHeadlights: false,
    nextRadio: false,
    lookDX: 0,
    lookDY: 0,
    wheel: 0,
  };
}

export class InputManager {
  /** Snapshot consumed by the simulation this frame. */
  readonly state: InputState = emptyState();
  /** Whether the pointer is currently locked to the canvas. */
  pointerLocked = false;
  /** Mouse sensitivity multiplier. */
  sensitivity = 1;
  /** Set true by tests to bypass DOM events. */
  simulated: Partial<InputState> | null = null;
  /** True when the browser refused pointer lock (iframe without permission): fall back to free mouse look. */
  lockFailed = false;

  private held = new Set<string>();
  private edges: Partial<InputState> = {};
  private accDX = 0;
  private accDY = 0;
  private accWheel = 0;
  private mouseDown = new Set<number>();
  private canvas: HTMLElement | null = null;
  private enabled = true;
  private onLockChange: ((locked: boolean) => void) | null = null;

  attach(canvas: HTMLElement, onLockChange?: (locked: boolean) => void): void {
    this.canvas = canvas;
    this.onLockChange = onLockChange ?? null;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.canvas?.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    this.canvas?.removeEventListener('wheel', this.onWheel);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
  }

  /** Disable gameplay input (menus open). Edge events are still cleared each frame. */
  setEnabled(v: boolean): void {
    this.enabled = v;
    if (!v) {
      this.held.clear();
      this.mouseDown.clear();
    }
  }

  requestPointerLock(): void {
    if (!this.canvas || this.pointerLocked) return;
    try {
      const p = (this.canvas as HTMLCanvasElement).requestPointerLock?.();
      if (p && typeof (p as Promise<void>).catch === 'function') {
        (p as Promise<void>).catch(() => {
          this.lockFailed = true;
        });
      }
      // If the lock never arrives (blocked iframe), fall back to free-look after a moment.
      window.setTimeout(() => {
        if (!this.pointerLocked) this.lockFailed = true;
      }, 700);
    } catch {
      this.lockFailed = true;
    }
  }

  exitPointerLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** Build the per-frame snapshot. Call exactly once per simulation frame. */
  poll(): InputState {
    const s = this.state;
    if (this.simulated) {
      // Test mode: copy simulated values, keep edges one-frame.
      Object.assign(s, emptyState(), this.simulated);
      for (const k of ['interact', 'nextWeapon', 'prevWeapon', 'toggleMap', 'pause', 'toggleCamera', 'toggleHeadlights', 'nextRadio', 'jump'] as const) {
        if (this.simulated[k]) {
          (this.simulated as Record<string, unknown>)[k] = false;
        }
      }
      if (this.simulated.weaponSlot !== undefined && this.simulated.weaponSlot >= 0) this.simulated.weaponSlot = -1;
      return s;
    }
    const held = this.enabled ? this.held : new Set<string>();
    const has = (code: string) => held.has(code);
    s.forward = has('KeyW') || has('ArrowUp');
    s.back = has('KeyS') || has('ArrowDown');
    s.left = has('KeyA') || has('ArrowLeft');
    s.right = has('KeyD') || has('ArrowRight');
    s.sprint = has('ShiftLeft') || has('ShiftRight');
    s.handbrake = has('Space');
    s.reload = has('KeyR');
    s.horn = has('KeyH');
    s.fire = this.enabled && this.mouseDown.has(0);
    s.aim = this.enabled && this.mouseDown.has(2);
    s.jump = !!this.edges.jump;
    s.interact = !!this.edges.interact;
    s.nextWeapon = !!this.edges.nextWeapon;
    s.prevWeapon = !!this.edges.prevWeapon;
    s.weaponSlot = this.edges.weaponSlot ?? -1;
    s.toggleMap = !!this.edges.toggleMap;
    s.pause = !!this.edges.pause;
    s.toggleCamera = !!this.edges.toggleCamera;
    s.toggleHeadlights = !!this.edges.toggleHeadlights;
    s.nextRadio = !!this.edges.nextRadio;
    s.lookDX = this.accDX * this.sensitivity;
    s.lookDY = this.accDY * this.sensitivity;
    s.wheel = this.accWheel;
    this.edges = {};
    this.accDX = 0;
    this.accDY = 0;
    this.accWheel = 0;
    return s;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const b = KEY_BINDINGS[e.code];
    if (!b) return;
    if (e.code !== 'Escape') e.preventDefault();
    if (e.repeat) return;
    this.held.add(e.code);
    // Pause must always work even when gameplay input is disabled (to close menus).
    if (b === 'pause') {
      this.edges.pause = true;
      return;
    }
    if (!this.enabled) return;
    if (typeof b === 'string' && b.startsWith('slot')) {
      this.edges.weaponSlot = parseInt(b.slice(4), 10);
      return;
    }
    switch (b) {
      case 'jump':
        this.edges.jump = true;
        break;
      case 'interact':
        this.edges.interact = true;
        break;
      case 'nextWeapon':
        this.edges.nextWeapon = true;
        break;
      case 'prevWeapon':
        this.edges.prevWeapon = true;
        break;
      case 'toggleMap':
        this.edges.toggleMap = true;
        break;
      case 'toggleCamera':
        this.edges.toggleCamera = true;
        break;
      case 'toggleHeadlights':
        this.edges.toggleHeadlights = true;
        break;
      case 'nextRadio':
        this.edges.nextRadio = true;
        break;
      default:
        break;
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
  };

  private onBlur = (): void => {
    this.held.clear();
    this.mouseDown.clear();
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (!this.enabled) return;
    e.preventDefault();
    if (!this.pointerLocked && !this.lockFailed) {
      this.requestPointerLock();
      return; // first click only captures the pointer
    }
    this.mouseDown.add(e.button);
  };

  private onMouseUp = (e: MouseEvent): void => {
    this.mouseDown.delete(e.button);
  };

  private onMouseMove = (e: MouseEvent): void => {
    if ((!this.pointerLocked && !this.lockFailed) || !this.enabled) return;
    this.accDX += e.movementX;
    this.accDY += e.movementY;
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    if (!this.enabled) return;
    this.accWheel += Math.sign(e.deltaY);
  };

  private onPointerLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.canvas;
    if (this.pointerLocked) this.lockFailed = false;
    else this.mouseDown.clear();
    this.onLockChange?.(this.pointerLocked);
  };
}
