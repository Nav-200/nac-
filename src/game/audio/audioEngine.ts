/**
 * Procedural Web Audio engine. Every sound — gunshots, impacts, engines, sirens, UI
 * jingles and four radio stations — is synthesized at runtime from oscillators and one
 * shared white-noise buffer; no asset files are fetched.
 *
 * The AudioContext is created lazily in `resume()` (autoplay policy: call it from the
 * first user gesture). Before that, or when Web Audio is unavailable (headless tests),
 * every method is a cheap no-op.
 *
 * Graph: sfx bus + music bus -> master gain -> compressor -> destination.
 */
import type { VehicleType, WeaponId } from '../core/types';
import { clamp, clamp01, lerp } from '../core/mathUtils';

// ---------- Public parameter types ----------
export type ImpactKind = 'metal' | 'concrete' | 'flesh' | 'glass' | 'wood' | 'body';
export type PickupKind = 'health' | 'armor' | 'money' | 'weapon' | 'ammo';
export type FootstepSurface = 'concrete' | 'grass' | 'sand' | 'metal';
export type UiSoundKind =
  | 'click'
  | 'hover'
  | 'notify'
  | 'money'
  | 'missionStart'
  | 'missionComplete'
  | 'missionFail'
  | 'wantedUp'
  | 'wantedClear'
  | 'wasted'
  | 'busted'
  | 'checkpoint';

export interface EngineParams {
  rpm01: number;
  throttle01: number;
  speed01: number;
  type: VehicleType;
  x: number;
  y: number;
  z: number;
  isPlayer: boolean;
}

// ---------- Tunables ----------
const MAX_VOICES = 48; // budget for concurrently voiced one-shots
const GUNSHOT_MERGE_WINDOW = 0.02; // identical shots closer than this are merged
const RADIO_LOOKAHEAD = 0.2; // seconds of notes scheduled ahead of currentTime
const CONTINUOUS_STALE_SECONDS = 2; // continuous voices not updated for this long are dropped
const MIN_GAIN = 0.0001; // exponential ramps cannot reach zero
const LISTENER_NEAR = 2; // metres of full volume around the listener

const noop = (): void => undefined;

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function findAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const g = globalThis as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

/** Collect a continuous voice's nodes for later disconnection (the panner is optional). */
function voiceNodes(sp: Spatial, ...rest: AudioNode[]): AudioNode[] {
  const nodes: AudioNode[] = [sp.input];
  if (sp.panner) nodes.push(sp.panner);
  nodes.push(...rest);
  return nodes;
}

function midiToFreq(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/** Deterministic hash in [0,1): the radio uses it so every station always plays the same "song". */
function hash01(a: number, b: number, c = 0): number {
  let h = (a | 0) * 374761393 + (b | 0) * 668265263 + (c | 0) * 2246822519;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Attack + exponential decay amplitude envelope. */
function adEnv(p: AudioParam, t0: number, peak: number, attack: number, decay: number): void {
  p.setValueAtTime(MIN_GAIN, t0);
  p.linearRampToValueAtTime(Math.max(peak, MIN_GAIN), t0 + attack);
  p.exponentialRampToValueAtTime(MIN_GAIN, t0 + attack + decay);
}

/** Exponential frequency sweep from -> to over dur seconds. */
function sweep(p: AudioParam, t0: number, from: number, to: number, dur: number): void {
  p.setValueAtTime(Math.max(from, 1), t0);
  p.exponentialRampToValueAtTime(Math.max(to, 1), t0 + dur);
}

/** Soft-clipping transfer curve for the rock station's guitar distortion. */
function makeDistortionCurve(amount: number): Float32Array {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
  }
  return curve;
}

function safeDisconnect(n: AudioNode): void {
  try {
    n.disconnect();
  } catch {
    /* already disconnected */
  }
}

// Node factories: create, configure and connect in one call (sources are returned un-started).
function mkGain(ctx: AudioContext, value: number, dest?: AudioNode | AudioParam): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  if (dest instanceof AudioNode) g.connect(dest);
  else if (dest) g.connect(dest);
  return g;
}

function mkFilter(ctx: AudioContext, type: BiquadFilterType, freq: number, q: number, dest: AudioNode): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  f.connect(dest);
  return f;
}

function mkOsc(ctx: AudioContext, type: OscillatorType, freq: number, dest: AudioNode, detune = 0): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  o.detune.value = detune;
  o.connect(dest);
  return o;
}

function mkNoise(ctx: AudioContext, buffer: AudioBuffer, rate: number, dest: AudioNode): AudioBufferSourceNode {
  const s = ctx.createBufferSource();
  s.buffer = buffer;
  s.loop = true;
  s.playbackRate.value = rate;
  s.connect(dest);
  return s;
}

// ---------- Static tables ----------
const ENGINE_BASE_HZ: Record<VehicleType, number> = {
  compact: 62, sedan: 55, taxi: 55, sports: 80, suv: 48, pickup: 45, van: 42, truck: 30, bus: 27, police: 60,
};

const HORN_HZ: Record<VehicleType, [number, number]> = {
  compact: [420, 520], sedan: [370, 466], taxi: [392, 494], sports: [440, 554], suv: [330, 415],
  pickup: [311, 392], van: [294, 370], truck: [185, 233], bus: [175, 220], police: [349, 440],
};

const GUN_MAX_DIST: Record<WeaponId, number> = {
  fist: 30, bat: 30, pistol: 220, smg: 180, shotgun: 260, rifle: 240, sniper: 420, rpg: 200,
};

const RELOAD_GAP: Record<WeaponId, number> = {
  fist: 0.1, bat: 0.1, pistol: 0.12, smg: 0.14, shotgun: 0.28, rifle: 0.2, sniper: 0.3, rpg: 0.36,
};

interface Chime { notes: number[]; gap: number; dur: number; type: OscillatorType; gain: number }
const PICKUP_CHIMES: Record<PickupKind, Chime> = {
  health: { notes: [72, 76, 79], gap: 0.07, dur: 0.35, type: 'sine', gain: 0.22 },
  armor: { notes: [67, 74], gap: 0.12, dur: 0.45, type: 'triangle', gain: 0.22 },
  money: { notes: [76, 83, 88], gap: 0.045, dur: 0.18, type: 'square', gain: 0.1 },
  weapon: { notes: [69, 81], gap: 0.09, dur: 0.3, type: 'triangle', gain: 0.2 },
  ammo: { notes: [72, 72, 79], gap: 0.06, dur: 0.15, type: 'triangle', gain: 0.18 },
};

interface Motif extends Chime { lowpass?: number; sub?: boolean }
const UI_MOTIFS: Record<UiSoundKind, Motif> = {
  click: { notes: [93], gap: 0, dur: 0.03, type: 'sine', gain: 0.15 },
  hover: { notes: [86], gap: 0, dur: 0.02, type: 'sine', gain: 0.07 },
  notify: { notes: [76, 81], gap: 0.09, dur: 0.25, type: 'sine', gain: 0.2 },
  money: { notes: [76, 83, 88], gap: 0.045, dur: 0.18, type: 'square', gain: 0.1 },
  missionStart: { notes: [60, 67, 72], gap: 0.13, dur: 0.5, type: 'triangle', gain: 0.25 },
  // ascending major arpeggio
  missionComplete: { notes: [72, 76, 79, 84, 88], gap: 0.11, dur: 0.6, type: 'triangle', gain: 0.25 },
  missionFail: { notes: [64, 60, 57], gap: 0.28, dur: 0.7, type: 'sawtooth', gain: 0.18, lowpass: 1200 },
  wantedUp: { notes: [81, 77, 81, 77], gap: 0.1, dur: 0.1, type: 'square', gain: 0.12 },
  wantedClear: { notes: [79, 76, 72], gap: 0.12, dur: 0.45, type: 'sine', gain: 0.2 },
  // descending minor motif with a sub octave underneath
  wasted: { notes: [69, 67, 64, 62, 57], gap: 0.32, dur: 1.2, type: 'sawtooth', gain: 0.2, lowpass: 900, sub: true },
  busted: { notes: [52, 52, 52, 46], gap: 0.22, dur: 0.4, type: 'sawtooth', gain: 0.22, lowpass: 700, sub: true },
  checkpoint: { notes: [79, 84], gap: 0.08, dur: 0.3, type: 'triangle', gain: 0.2 },
};

interface StepCfg { type: BiquadFilterType; freq: number; q: number; dur: number; gain: number }
const FOOTSTEPS: Record<FootstepSurface, StepCfg> = {
  concrete: { type: 'bandpass', freq: 1500, q: 0.8, dur: 0.05, gain: 1 },
  grass: { type: 'lowpass', freq: 900, q: 0.7, dur: 0.08, gain: 0.7 },
  sand: { type: 'lowpass', freq: 600, q: 0.6, dur: 0.11, gain: 0.6 },
  metal: { type: 'bandpass', freq: 2400, q: 2, dur: 0.05, gain: 1 },
};

// Radio song data (MIDI note numbers).
const STATION_BPM = [110, 90, 72, 140];
const NEON_CHORDS: number[][] = [[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]]; // Am F C G
const NEON_ARP = [0, 1, 2, 3, 2, 1, 0, 3];
const BASS_KICK = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0];
const BASS_SCALE = [64, 67, 69, 71, 74, 76, 79]; // E minor pentatonic
const CLASSIC_CHORDS: number[][] = [[60, 64, 67], [59, 62, 67], [57, 60, 64], [57, 60, 65]]; // C G Am F
const CLASSIC_ARP = [0, 1, 2, 3, 2, 1, 0, 1];
const ROCK_RIFF = [40, 40, 43, 45, 40, 40, 38, 45]; // E E G A E E D A, one entry per half bar

// ---------- Internal structures ----------
interface Graph {
  ctx: AudioContext;
  master: GainNode;
  compressor: DynamicsCompressorNode;
  sfx: GainNode;
  music: GainNode;
  /** Radio bus (inside music): faded in/out with vehicle occupancy. */
  radio: GainNode;
  noise: AudioBuffer;
  hasPanner: boolean;
}

/** Distance gain + stereo panner pair feeding a bus. */
interface Spatial {
  input: GainNode;
  panner: StereoPannerNode | null;
}

interface Voice {
  sp: Spatial;
  /** Musical level of the voice (dynamics), separate from the spatial distance gain. */
  level: GainNode;
  nodes: AudioNode[];
  sources: AudioScheduledSourceNode[];
  lastTime: number;
}

interface EngineVoice extends Voice {
  osc1: OscillatorNode;
  osc2: OscillatorNode;
  noise: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  noiseGain: GainNode;
  rpm: number;
}

interface SkidVoice extends Voice {
  bp: BiquadFilterNode;
  noise: AudioBufferSourceNode;
}

interface StationRig {
  /** Per-station output -> radio bus; ramped to zero on a station switch so long notes don't overlap. */
  out: GainNode;
  nodes: AudioNode[];
  sources: AudioScheduledSourceNode[];
  /** Drift Rock: input of the waveshaper chain. */
  distIn: AudioNode | null;
  /** Classic Grand: feedback-delay "hall" send. */
  send: AudioNode | null;
  /** Bass Nation: persistent square lead with portamento. */
  lead: { osc: OscillatorNode; gain: GainNode } | null;
  leadBusyUntil: number;
}

/**
 * A short-lived graph for a one-shot. Every node is tracked so the whole patch is torn
 * down (disconnected) when its longest source ends — no leaks over long sessions.
 */
class Patch {
  private readonly nodes: AudioNode[] = [];
  private lastStop = -1;
  private longest: AudioScheduledSourceNode | null = null;
  private done = false;

  constructor(
    private readonly ctx: AudioContext,
    private readonly noiseBuffer: AudioBuffer,
    readonly out: GainNode,
    tail: AudioNode | null,
    private readonly onDone: () => void,
  ) {
    this.nodes.push(out);
    if (tail) this.nodes.push(tail);
  }

  osc(type: OscillatorType, freq: number, t0: number, t1: number, dest: AudioNode = this.out): OscillatorNode {
    const o = mkOsc(this.ctx, type, freq, dest);
    o.start(t0);
    this.track(o, t1);
    return o;
  }

  /** Looped white noise; a random start offset keeps repeated bursts from sounding identical. */
  noise(t0: number, t1: number, dest: AudioNode = this.out, rate = 1): AudioBufferSourceNode {
    const s = mkNoise(this.ctx, this.noiseBuffer, rate, dest);
    s.start(t0, Math.random() * 0.9);
    this.track(s, t1);
    return s;
  }

  gain(value: number, dest: AudioNode = this.out): GainNode {
    const g = mkGain(this.ctx, value, dest);
    this.nodes.push(g);
    return g;
  }

  filter(type: BiquadFilterType, freq: number, q: number, dest: AudioNode = this.out): BiquadFilterNode {
    const f = mkFilter(this.ctx, type, freq, q, dest);
    this.nodes.push(f);
    return f;
  }

  /** Call once after all sources are scheduled. */
  finish(): void {
    if (!this.longest) {
      this.cleanup();
      return;
    }
    this.longest.onended = () => this.cleanup();
  }

  /** Schedule the stop and remember which source ends last (it triggers the teardown). */
  private track(s: AudioScheduledSourceNode, t1: number): void {
    s.stop(t1);
    this.nodes.push(s);
    if (t1 > this.lastStop) {
      this.lastStop = t1;
      this.longest = s;
    }
  }

  private cleanup(): void {
    if (this.done) return;
    this.done = true;
    for (const n of this.nodes) safeDisconnect(n);
    this.nodes.length = 0;
    this.onDone();
  }
}

// ---------- Engine ----------
export class AudioEngine {
  static readonly RADIO_STATIONS: string[] = ['Neon FM', 'Bass Nation', 'Classic Grand', 'Drift Rock'];

  private g: Graph | null = null;
  /** Set when context creation failed or the API is missing; keeps every call a no-op. */
  private unavailable = false;

  private masterVol = 0.8;
  private sfxVol = 1;
  private musicVol = 0.8;

  // Listener pose. yaw 0 faces +Z; right vector = (-cos yaw, sin yaw).
  private lx = 0;
  private ly = 0;
  private lz = 0;
  private rx = -1;
  private rz = 0;

  private voices = 0;
  private readonly lastShot = new Map<WeaponId, number>();
  private staleTimer = 0;

  private readonly engines = new Map<number, EngineVoice>();
  private readonly sirens = new Map<number, Voice>();
  private readonly skids = new Map<number, SkidVoice>();

  // Radio sequencer state.
  private station = -1;
  private radioAudible = false;
  private radioFadeEnd = 0;
  private rig: StationRig | null = null;
  private radioStep = 0;
  private radioNextTime = -1;

  constructor() {
    // Intentionally empty: the AudioContext is created in resume() on the first user gesture.
  }

  // ----- Lifecycle -----

  resume(): void {
    if (this.unavailable) return;
    if (!this.g) {
      const Ctor = findAudioContextCtor();
      if (!Ctor) {
        this.unavailable = true;
        return;
      }
      try {
        this.g = this.buildGraph(this.createContext(Ctor));
      } catch {
        this.unavailable = true;
        return;
      }
    }
    if (this.g.ctx.state !== 'running') {
      try {
        void this.g.ctx.resume().catch(noop);
      } catch {
        /* ignore */
      }
    }
  }

  get enabled(): boolean {
    return this.g !== null && this.g.ctx.state === 'running';
  }

  dispose(): void {
    const g = this.g;
    if (!g) return;
    this.removeAllContinuous();
    this.teardownRig(g);
    safeDisconnect(g.sfx);
    safeDisconnect(g.music);
    safeDisconnect(g.master);
    safeDisconnect(g.compressor);
    try {
      void g.ctx.close().catch(noop);
    } catch {
      /* ignore */
    }
    this.g = null;
    this.voices = 0;
    this.radioNextTime = -1;
    this.lastShot.clear(); // a fresh context restarts currentTime at 0; stale stamps would merge away the first shots
  }

  /** Prefer the low-latency hint; legacy webkitAudioContext rejects an options argument, so retry bare. */
  private createContext(Ctor: AudioContextCtor): AudioContext {
    try {
      return new Ctor({ latencyHint: 'interactive' });
    } catch {
      return new Ctor();
    }
  }

  private buildGraph(ctx: AudioContext): Graph {
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -12;
    compressor.knee.value = 20;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;
    compressor.connect(ctx.destination);
    const master = mkGain(ctx, this.masterVol, compressor);
    const sfx = mkGain(ctx, this.sfxVol, master);
    const music = mkGain(ctx, this.musicVol, master);
    const radio = mkGain(ctx, this.radioAudible ? 1 : 0, music);

    // One second of white noise, reused by every noise-based sound.
    const noise = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate)), ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    return { ctx, master, compressor, sfx, music, radio, noise, hasPanner: typeof ctx.createStereoPanner === 'function' };
  }

  /** Graph when the context is running, else null (one-shots must not queue up while suspended). */
  private ready(): Graph | null {
    return this.g && this.g.ctx.state === 'running' ? this.g : null;
  }

  // ----- Mix -----

  setMasterVolume(v01: number): void {
    this.masterVol = clamp01(v01);
    if (this.g) this.g.master.gain.setTargetAtTime(this.masterVol, this.g.ctx.currentTime, 0.02);
  }

  setSfxVolume(v01: number): void {
    this.sfxVol = clamp01(v01);
    if (this.g) this.g.sfx.gain.setTargetAtTime(this.sfxVol, this.g.ctx.currentTime, 0.02);
  }

  setMusicVolume(v01: number): void {
    this.musicVol = clamp01(v01);
    if (this.g) this.g.music.gain.setTargetAtTime(this.musicVol, this.g.ctx.currentTime, 0.02);
  }

  setListener(x: number, y: number, z: number, yaw: number): void {
    this.lx = x;
    this.ly = y;
    this.lz = z;
    this.rx = -Math.cos(yaw);
    this.rz = Math.sin(yaw);
  }

  update(dt: number): void {
    const g = this.g;
    if (!g || g.ctx.state !== 'running') return;
    this.staleTimer += dt;
    if (this.staleTimer > 0.5) {
      this.staleTimer = 0;
      this.sweepStale(g.ctx.currentTime);
    }
    this.updateRadio(g);
  }

  // ----- Spatialisation -----

  /** Stereo pan = dot(dirToSource, right); gain = 1 - dist/maxDist (flat inside LISTENER_NEAR). */
  private spatialParams(x: number, y: number, z: number, maxDist: number): { pan: number; gain: number } {
    const dx = x - this.lx;
    const dy = y - this.ly;
    const dz = z - this.lz;
    const horiz = Math.sqrt(dx * dx + dz * dz);
    const dist = Math.sqrt(horiz * horiz + dy * dy);
    const gain = clamp01(1 - Math.max(0, dist - LISTENER_NEAR) / maxDist);
    const pan = horiz > 0.5 ? clamp(((dx * this.rx + dz * this.rz) / horiz) * 0.8, -1, 1) : 0;
    return { pan, gain };
  }

  /**
   * Create a one-shot patch. Positional when x is given (per-sound gain + panner), 2D otherwise.
   * Returns null when inaudible or when the voice budget is exhausted (distant sounds are dropped first).
   */
  private patch(x: number | undefined, y: number | undefined, z: number | undefined, maxDist: number, dest?: AudioNode, budget = true): Patch | null {
    const g = this.g;
    if (!g) return null;
    const ctx = g.ctx;
    const target = dest ?? g.sfx;
    let pan = 0;
    let gain = 1;
    const positional = x !== undefined;
    if (positional) {
      const sp = this.spatialParams(x, y ?? 0, z ?? 0, maxDist);
      pan = sp.pan;
      gain = sp.gain;
      if (gain <= 0.002) return null;
      if (budget && this.voices >= MAX_VOICES && gain < 0.6) return null;
    }
    if (budget && this.voices >= MAX_VOICES + 16) return null;

    const out = ctx.createGain();
    out.gain.value = gain;
    let tail: AudioNode | null = null;
    if (positional && g.hasPanner) {
      const pn = ctx.createStereoPanner();
      pn.pan.value = pan;
      out.connect(pn);
      pn.connect(target);
      tail = pn;
    } else {
      out.connect(target);
    }
    if (budget) this.voices++;
    const onDone = budget ? () => { this.voices = Math.max(0, this.voices - 1); } : noop;
    return new Patch(ctx, g.noise, out, tail, onDone);
  }

  private makeSpatial(g: Graph, dest: AudioNode): Spatial {
    const input = mkGain(g.ctx, 0);
    let panner: StereoPannerNode | null = null;
    if (g.hasPanner) {
      panner = g.ctx.createStereoPanner();
      input.connect(panner);
      panner.connect(dest);
    } else {
      input.connect(dest);
    }
    return { input, panner };
  }

  private placeSpatial(sp: Spatial, x: number, y: number, z: number, maxDist: number, now: number): void {
    const { pan, gain } = this.spatialParams(x, y, z, maxDist);
    sp.input.gain.setTargetAtTime(gain, now, 0.06);
    if (sp.panner) sp.panner.pan.setTargetAtTime(pan, now, 0.06);
  }

  // ----- Synth building blocks -----

  /** Filtered noise burst: the workhorse for cracks, hits, hats and static. */
  private burst(p: Patch, t: number, dur: number, gain: number, type: BiquadFilterType, freq: number, q: number, freqEnd = freq, attack = 0.003, dest: AudioNode = p.out): void {
    const g = p.gain(MIN_GAIN, dest);
    adEnv(g.gain, t, gain, attack, dur);
    const f = p.filter(type, freq, q, g);
    if (freqEnd !== freq) sweep(f.frequency, t, freq, freqEnd, attack + dur);
    p.noise(t, t + attack + dur + 0.05, f);
  }

  /** Enveloped oscillator with optional pitch glide (thumps, kicks, chimes, notes). */
  private tone(p: Patch, t: number, dur: number, gain: number, type: OscillatorType, freq: number, freqEnd = freq, attack = 0.003, dest: AudioNode = p.out): void {
    const g = p.gain(MIN_GAIN, dest);
    adEnv(g.gain, t, gain, attack, dur);
    const o = p.osc(type, freq, t, t + attack + dur + 0.05, g);
    if (freqEnd !== freq) sweep(o.frequency, t, freq, freqEnd, attack + dur);
  }

  /** Drum kick: sine pitch drop plus a tiny click. */
  private kick(p: Patch, t: number, f0: number, f1: number, dur: number, gain: number): void {
    this.tone(p, t, dur, gain, 'sine', f0, f1, 0.002);
    this.burst(p, t, 0.012, gain * 0.35, 'highpass', 1500, 0.7);
  }

  private hat(p: Patch, t: number, dur: number, gain: number): void {
    this.burst(p, t, dur, gain, 'highpass', 7500, 0.8);
  }

  /** Snare: bandpassed noise plus a short pitched body. */
  private snare(p: Patch, t: number, gain: number, body = 190): void {
    this.burst(p, t, 0.17, gain, 'bandpass', 1800, 0.7);
    this.tone(p, t, 0.09, gain * 0.6, 'triangle', body, body * 0.7);
  }

  /** Mechanical click used by reloads / empty chamber / door latches. */
  private click(p: Patch, t: number, pitch: number, gain: number): void {
    this.burst(p, t, 0.02, gain, 'highpass', 2500, 0.7);
    this.tone(p, t, 0.03, gain * 0.5, 'sine', pitch, pitch * 0.8);
  }

  // ----- One-shots -----

  playGunshot(weapon: WeaponId, x?: number, y?: number, z?: number): void {
    const g = this.ready();
    if (!g) return;
    if (weapon === 'fist' || weapon === 'bat') {
      this.playMelee(x, y, z);
      return;
    }
    const t = g.ctx.currentTime;
    if (t - (this.lastShot.get(weapon) ?? -1) < GUNSHOT_MERGE_WINDOW) return;
    this.lastShot.set(weapon, t);
    const p = this.patch(x, y, z, GUN_MAX_DIST[weapon]);
    if (!p) return;
    switch (weapon) {
      case 'pistol':
        this.burst(p, t, 0.07, 0.9, 'bandpass', 2600, 1.2, 1200); // sharp crack
        this.tone(p, t, 0.12, 0.7, 'sine', 170, 50); // low thump
        break;
      case 'smg':
        this.burst(p, t, 0.045, 0.7, 'highpass', 1800, 0.8); // short crack
        this.tone(p, t, 0.06, 0.4, 'sine', 150, 60);
        break;
      case 'shotgun':
        this.burst(p, t, 0.32, 1.2, 'lowpass', 3200, 0.7, 250); // big boom sweeping down
        this.burst(p, t + 0.02, 0.5, 0.35, 'bandpass', 900, 0.6); // noise tail
        this.tone(p, t, 0.28, 1.0, 'sine', 95, 32); // sub punch
        break;
      case 'rifle':
        this.burst(p, t, 0.09, 0.9, 'bandpass', 1300, 0.8, 700); // crack with more mid
        this.tone(p, t, 0.06, 0.3, 'sawtooth', 320, 90); // mid growl
        this.tone(p, t, 0.1, 0.6, 'sine', 160, 55);
        break;
      case 'sniper':
        this.burst(p, t, 0.16, 1.3, 'bandpass', 1500, 0.6, 500); // long loud crack
        this.tone(p, t, 0.3, 0.9, 'sine', 130, 30);
        // echo slaps: each repeat quieter and duller
        for (let i = 1; i <= 3; i++) this.burst(p, t + 0.16 * i, 0.12, 0.35 / i, 'lowpass', 1800 / i, 0.7);
        break;
      case 'rpg': {
        // launch whoosh: rising band of noise over a low rumble
        const wg = p.gain(MIN_GAIN);
        wg.gain.setValueAtTime(MIN_GAIN, t);
        wg.gain.linearRampToValueAtTime(0.9, t + 0.08);
        wg.gain.exponentialRampToValueAtTime(MIN_GAIN, t + 0.6);
        const f = p.filter('bandpass', 350, 1.5, wg);
        sweep(f.frequency, t, 350, 2400, 0.5);
        p.noise(t, t + 0.65, f);
        this.tone(p, t, 0.4, 0.6, 'sine', 80, 45);
        break;
      }
    }
    p.finish();
  }

  playMelee(x?: number, y?: number, z?: number): void {
    const g = this.ready();
    if (!g) return;
    const p = this.patch(x, y, z, 30);
    if (!p) return;
    // Swing whoosh: rising bandpassed noise with a soft attack.
    this.burst(p, g.ctx.currentTime, 0.1, 0.35, 'bandpass', 500, 1.2, 1600, 0.05);
    p.finish();
  }

  playImpact(kind: ImpactKind, intensity01: number, x?: number, y?: number, z?: number): void {
    const g = this.ready();
    if (!g) return;
    const p = this.patch(x, y, z, 70);
    if (!p) return;
    const t = g.ctx.currentTime;
    const k = clamp01(intensity01);
    const v = 0.3 + 0.7 * k;
    switch (kind) {
      case 'metal': {
        // Inharmonic partials make the clang; a random detune keeps repeated hits varied.
        const d = 0.9 + Math.random() * 0.2;
        this.tone(p, t, 0.25 + 0.2 * k, 0.35 * v, 'triangle', 640 * d);
        this.tone(p, t, 0.18 + 0.15 * k, 0.25 * v, 'sine', 1380 * d);
        this.tone(p, t, 0.12, 0.18 * v, 'sine', 2210 * d);
        this.burst(p, t, 0.05, 0.5 * v, 'highpass', 2500, 0.7);
        break;
      }
      case 'concrete':
        this.burst(p, t, 0.06, 0.6 * v, 'lowpass', 1400, 0.7);
        this.tone(p, t, 0.08, 0.4 * v, 'sine', 130, 60);
        break;
      case 'flesh':
        this.burst(p, t, 0.08, 0.7 * v, 'lowpass', 500, 0.8); // wet smack
        this.tone(p, t, 0.1, 0.5 * v, 'sine', 110, 50);
        break;
      case 'glass':
        this.burst(p, t, 0.1, 0.6 * v, 'highpass', 4000, 0.7);
        for (let i = 0; i < 4; i++) {
          // sparkle of short high sines
          this.tone(p, t + i * 0.012, 0.1 + Math.random() * 0.1, 0.12 * v, 'sine', 2500 + Math.random() * 4000);
        }
        break;
      case 'wood':
        this.burst(p, t, 0.08, 0.6 * v, 'bandpass', 700, 2);
        this.tone(p, t, 0.07, 0.3 * v, 'triangle', 220, 130);
        break;
      case 'body':
        this.tone(p, t, 0.22, 0.8 * v, 'sine', 90, 38); // heavy thud
        this.burst(p, t, 0.15, 0.6 * v, 'lowpass', 350, 0.8);
        break;
    }
    p.finish();
  }

  playExplosion(x?: number, y?: number, z?: number): void {
    const g = this.ready();
    if (!g) return;
    const p = this.patch(x, y, z, 600);
    if (!p) return;
    const t = g.ctx.currentTime;
    // Main blast: broadband noise with a lowpass sweeping down over ~1.2 s.
    const bg = p.gain(MIN_GAIN);
    bg.gain.setValueAtTime(MIN_GAIN, t);
    bg.gain.linearRampToValueAtTime(1.6, t + 0.01);
    bg.gain.exponentialRampToValueAtTime(MIN_GAIN, t + 1.5);
    const lp = p.filter('lowpass', 6000, 0.5, bg);
    sweep(lp.frequency, t, 6000, 120, 1.2);
    p.noise(t, t + 1.55, lp);
    // Sub-bass drop.
    this.tone(p, t, 0.9, 1.2, 'sine', 110, 28, 0.005);
    // Crackle tail: sparse high ticks.
    for (let i = 0; i < 9; i++) {
      const tt = t + 0.15 + Math.random() * 1.2;
      this.burst(p, tt, 0.02 + Math.random() * 0.03, 0.15 + Math.random() * 0.15, 'highpass', 2000 + Math.random() * 2000, 0.7);
    }
    p.finish();
  }

  playPickup(kind: PickupKind): void {
    const g = this.ready();
    if (!g) return;
    const p = this.patch(undefined, undefined, undefined, 0);
    if (!p) return;
    const t = g.ctx.currentTime;
    const c = PICKUP_CHIMES[kind];
    c.notes.forEach((note, i) => this.tone(p, t + i * c.gap, c.dur, c.gain, c.type, midiToFreq(note), undefined, 0.006));
    if (kind === 'weapon' || kind === 'ammo') this.click(p, t, 1400, 0.25); // metallic rack
    p.finish();
  }

  playReload(weapon: WeaponId): void {
    const g = this.ready();
    if (!g) return;
    const p = this.patch(undefined, undefined, undefined, 0);
    if (!p) return;
    const t = g.ctx.currentTime;
    const heavy = weapon === 'shotgun' || weapon === 'rpg' || weapon === 'sniper';
    const pitch = heavy ? 700 : 1400;
    this.click(p, t, pitch, 0.3); // magazine out
    this.click(p, t + RELOAD_GAP[weapon], pitch * 1.25, 0.35); // magazine in
    p.finish();
  }

  playEmptyClick(): void {
    const g = this.ready();
    if (!g) return;
    const p = this.patch(undefined, undefined, undefined, 0);
    if (!p) return;
    const t = g.ctx.currentTime;
    this.burst(p, t, 0.015, 0.25, 'highpass', 3000, 0.7);
    this.tone(p, t, 0.02, 0.08, 'square', 900);
    p.finish();
  }

  playFootstep(surface: FootstepSurface, running: boolean): void {
    const g = this.ready();
    if (!g) return;
    const p = this.patch(undefined, undefined, undefined, 0);
    if (!p) return;
    const t = g.ctx.currentTime;
    const c = FOOTSTEPS[surface];
    const gain = (running ? 0.22 : 0.13) * c.gain;
    this.burst(p, t, c.dur * (running ? 0.8 : 1), gain, c.type, c.freq * (0.9 + Math.random() * 0.2), c.q);
    if (surface === 'metal') this.tone(p, t, 0.08, gain * 0.4, 'triangle', 800 + Math.random() * 200); // grating ring
    p.finish();
  }

  playUI(kind: UiSoundKind): void {
    const g = this.ready();
    if (!g) return;
    const p = this.patch(undefined, undefined, undefined, 0);
    if (!p) return;
    const t = g.ctx.currentTime;
    const m = UI_MOTIFS[kind];
    const dest = m.lowpass ? p.filter('lowpass', m.lowpass, 0.9) : p.out;
    m.notes.forEach((note, i) => {
      const tn = t + i * m.gap;
      const dur = i === m.notes.length - 1 ? m.dur * 1.6 : m.dur; // let the last note ring
      this.tone(p, tn, dur, m.gain, m.type, midiToFreq(note), undefined, 0.008, dest);
      if (m.sub) this.tone(p, tn, dur, m.gain * 0.6, 'triangle', midiToFreq(note - 12), undefined, 0.01, dest);
    });
    p.finish();
  }

  playHorn(vehicle: VehicleType, x?: number, y?: number, z?: number): void {
    const g = this.ready();
    if (!g) return;
    const p = this.patch(x, y, z, 160);
    if (!p) return;
    const t = g.ctx.currentTime;
    const [f1, f2] = HORN_HZ[vehicle];
    const heavy = vehicle === 'truck' || vehicle === 'bus';
    const dur = heavy ? 0.7 : 0.5;
    // Two-tone horn: a pair of harsh oscillators, lowpassed, with a fast trapezoid envelope.
    const lp = p.filter('lowpass', heavy ? 900 : 1600, 1);
    const hg = p.gain(MIN_GAIN, lp);
    hg.gain.setValueAtTime(MIN_GAIN, t);
    hg.gain.linearRampToValueAtTime(0.35, t + 0.02);
    hg.gain.setValueAtTime(0.35, t + dur - 0.05);
    hg.gain.linearRampToValueAtTime(MIN_GAIN, t + dur);
    const type: OscillatorType = heavy ? 'sawtooth' : 'square';
    p.osc(type, f1, t, t + dur + 0.02, hg);
    p.osc(type, f2, t, t + dur + 0.02, hg);
    p.finish();
  }

  playCarDoor(): void {
    const g = this.ready();
    if (!g) return;
    const p = this.patch(undefined, undefined, undefined, 0);
    if (!p) return;
    const t = g.ctx.currentTime;
    this.tone(p, t, 0.1, 0.5, 'sine', 140, 60); // thunk
    this.burst(p, t, 0.06, 0.5, 'lowpass', 600, 0.8);
    this.click(p, t + 0.03, 1800, 0.12); // latch
    p.finish();
  }

  playSkidOnce(intensity01: number, x?: number, y?: number, z?: number): void {
    const g = this.ready();
    if (!g) return;
    const k = clamp01(intensity01);
    if (k <= 0.02) return;
    const p = this.patch(x, y, z, 90);
    if (!p) return;
    const t = g.ctx.currentTime;
    const dur = 0.25 + 0.2 * k;
    // Tyre screech: narrow bandpassed noise, a second higher band for the squeal.
    this.burst(p, t, dur, 0.4 * Math.pow(k, 1.2), 'bandpass', lerp(900, 1600, k), 3, lerp(1000, 1400, k), 0.02);
    this.burst(p, t, dur * 0.8, 0.15 * k, 'bandpass', 3200, 5, 3200, 0.02);
    p.finish();
  }

  playCrash(intensity01: number, x?: number, y?: number, z?: number): void {
    const g = this.ready();
    if (!g) return;
    const k = clamp01(intensity01);
    const p = this.patch(x, y, z, 120 + 120 * k);
    if (!p) return;
    const t = g.ctx.currentTime;
    // Metal crunch: noise whose brightness and loudness scale with intensity, plus a sub thud.
    this.burst(p, t, 0.2 + 0.25 * k, 0.5 + 0.8 * k, 'lowpass', lerp(700, 4500, k), 0.7, 300);
    this.tone(p, t, 0.25, 0.7 * k + 0.1, 'sine', 90, 30);
    // Ringing panels.
    for (let i = 0; i < 3; i++) {
      const f = (400 + Math.random() * 1400) * (1 + 0.3 * k);
      this.tone(p, t + Math.random() * 0.05, 0.15 + Math.random() * 0.3 * k, 0.12 * (0.3 + k), 'triangle', f);
    }
    // Secondary tumble.
    if (k > 0.4) this.burst(p, t + 0.12, 0.2, 0.3 * k, 'lowpass', 1200, 0.8, 250);
    p.finish();
  }

  // ----- Continuous voices -----

  updateEngine(id: number, params: EngineParams): void {
    const g = this.ready();
    if (!g) return;
    const now = g.ctx.currentTime;
    let v = this.engines.get(id);
    if (!v) {
      v = this.createEngine(g, now);
      this.engines.set(id, v);
    }
    const dt = clamp(now - v.lastTime, 0, 0.1);
    v.lastTime = now;
    // Pitch follows rpm with a slight lag (flywheel feel).
    v.rpm += (clamp01(params.rpm01) - v.rpm) * (1 - Math.exp(-7 * dt));
    const thr = clamp01(params.throttle01);
    const spd = clamp01(params.speed01);
    const f = ENGINE_BASE_HZ[params.type] * lerp(0.9, 3.8, v.rpm);
    v.osc1.frequency.setTargetAtTime(f, now, 0.02);
    v.osc2.frequency.setTargetAtTime(f * 0.503, now, 0.02); // sub octave, slightly detuned
    // Throttle opens the filter and raises the level; rpm brightens it further.
    v.filter.frequency.setTargetAtTime(lerp(320, 1600, thr) + v.rpm * 1400 + spd * 300, now, 0.04);
    v.noiseGain.gain.setTargetAtTime(0.03 + thr * 0.09 + v.rpm * 0.03, now, 0.05);
    v.noise.playbackRate.setTargetAtTime(0.35 + v.rpm * 0.8, now, 0.05);
    const level = (0.16 + 0.45 * thr + 0.4 * v.rpm) * (params.isPlayer ? 0.28 : 0.2);
    v.level.gain.setTargetAtTime(level, now, 0.05);
    if (params.isPlayer) {
      // Player engine: always audible, centred.
      v.sp.input.gain.setTargetAtTime(1, now, 0.06);
      if (v.sp.panner) v.sp.panner.pan.setTargetAtTime(0, now, 0.06);
    } else {
      this.placeSpatial(v.sp, params.x, params.y, params.z, 80, now);
    }
  }

  private createEngine(g: Graph, now: number): EngineVoice {
    const ctx = g.ctx;
    const sp = this.makeSpatial(g, g.sfx);
    const level = mkGain(ctx, 0, sp.input);
    // Two detuned oscillators (saw + square sub) through a lowpass = engine body.
    const filter = mkFilter(ctx, 'lowpass', 600, 1.2, level);
    const osc1 = mkOsc(ctx, 'sawtooth', 60, filter, -6);
    const osc2 = mkOsc(ctx, 'square', 30, filter, 6);
    // Exhaust: slow, bandpassed noise.
    const noiseGain = mkGain(ctx, 0, level);
    const noiseFilter = mkFilter(ctx, 'bandpass', 500, 0.8, noiseGain);
    const noise = mkNoise(ctx, g.noise, 0.4, noiseFilter);
    osc1.start(now);
    osc2.start(now);
    noise.start(now, Math.random() * 0.9);
    return {
      sp, level, osc1, osc2, noise, filter, noiseGain, rpm: 0.15, lastTime: now,
      nodes: voiceNodes(sp, level, filter, osc1, osc2, noiseFilter, noiseGain, noise),
      sources: [osc1, osc2, noise],
    };
  }

  removeEngine(id: number): void {
    const v = this.engines.get(id);
    if (!v) return;
    this.engines.delete(id);
    this.fadeOutVoice(v);
  }

  updateSiren(id: number, on: boolean, x: number, y: number, z: number): void {
    const g = this.ready();
    if (!g) return;
    let v = this.sirens.get(id);
    if (!v) {
      if (!on) return;
      v = this.createSiren(g, g.ctx.currentTime);
      this.sirens.set(id, v);
    }
    const now = g.ctx.currentTime;
    if (on) v.lastTime = now; // a silenced siren stops refreshing, so the stale sweep reclaims its nodes
    v.level.gain.setTargetAtTime(on ? 0.5 : 0, now, 0.08);
    this.placeSpatial(v.sp, x, y, z, 260, now);
  }

  private createSiren(g: Graph, now: number): Voice {
    const ctx = g.ctx;
    const sp = this.makeSpatial(g, g.sfx);
    const level = mkGain(ctx, 0, sp.input);
    // Two-tone wail: a sawtooth whose pitch is switched between ~700 and ~950 Hz by a square LFO.
    const lp = mkFilter(ctx, 'lowpass', 2200, 1, level);
    const osc = mkOsc(ctx, 'sawtooth', 825, lp);
    const lfoDepth = mkGain(ctx, 125, osc.frequency);
    const lfo = mkOsc(ctx, 'square', 1.1, lfoDepth);
    osc.start(now);
    lfo.start(now);
    return {
      sp, level, lastTime: now,
      nodes: voiceNodes(sp, level, lp, osc, lfo, lfoDepth),
      sources: [osc, lfo],
    };
  }

  removeSiren(id: number): void {
    const v = this.sirens.get(id);
    if (!v) return;
    this.sirens.delete(id);
    this.fadeOutVoice(v);
  }

  updateSkid(id: number, intensity01: number, x: number, y: number, z: number): void {
    const g = this.ready();
    if (!g) return;
    const k = clamp01(intensity01);
    let v = this.skids.get(id);
    if (!v) {
      if (k <= 0.02) return;
      v = this.createSkid(g, g.ctx.currentTime);
      this.skids.set(id, v);
    }
    const now = g.ctx.currentTime;
    if (k > 0.02) v.lastTime = now; // an idle skid stops refreshing and is swept after CONTINUOUS_STALE_SECONDS
    v.level.gain.setTargetAtTime(Math.pow(k, 1.4) * 0.45, now, 0.05);
    v.bp.frequency.setTargetAtTime(lerp(950, 1700, k), now, 0.08);
    v.noise.playbackRate.setTargetAtTime(0.9 + 0.3 * k, now, 0.08);
    this.placeSpatial(v.sp, x, y, z, 90, now);
  }

  private createSkid(g: Graph, now: number): SkidVoice {
    const ctx = g.ctx;
    const sp = this.makeSpatial(g, g.sfx);
    const level = mkGain(ctx, 0, sp.input);
    // Screech: looped noise through a resonant bandpass, with a quieter high squeal band.
    const bp = mkFilter(ctx, 'bandpass', 1300, 3, level);
    const squeal = mkGain(ctx, 0.35, level);
    const bp2 = mkFilter(ctx, 'bandpass', 3100, 6, squeal);
    const noise = mkNoise(ctx, g.noise, 1, bp);
    noise.connect(bp2);
    noise.start(now, Math.random() * 0.9);
    return {
      sp, level, bp, noise, lastTime: now,
      nodes: voiceNodes(sp, level, bp, bp2, squeal, noise),
      sources: [noise],
    };
  }

  removeSkid(id: number): void {
    const v = this.skids.get(id);
    if (!v) return;
    this.skids.delete(id);
    this.fadeOutVoice(v);
  }

  removeAllContinuous(): void {
    for (const v of this.engines.values()) this.fadeOutVoice(v);
    for (const v of this.sirens.values()) this.fadeOutVoice(v);
    for (const v of this.skids.values()) this.fadeOutVoice(v);
    this.engines.clear();
    this.sirens.clear();
    this.skids.clear();
  }

  /** Quick fade, then stop every source and disconnect the voice's nodes when the last one ends. */
  private fadeOutVoice(v: Voice): void {
    const g = this.g;
    const cleanup = (): void => {
      for (const n of v.nodes) safeDisconnect(n);
    };
    if (!g) {
      cleanup();
      return;
    }
    const t = g.ctx.currentTime;
    v.level.gain.cancelScheduledValues(t);
    v.level.gain.setTargetAtTime(0, t, 0.08);
    const stopAt = t + 0.5;
    let last: AudioScheduledSourceNode | null = null;
    for (const s of v.sources) {
      try {
        s.stop(stopAt);
        last = s;
      } catch {
        /* already stopped */
      }
    }
    if (last) last.onended = cleanup;
    else cleanup();
  }

  /** Drop continuous voices whose owner stopped updating them (e.g. a despawned vehicle). */
  private sweepStale(now: number): void {
    for (const [id, v] of this.engines) if (now - v.lastTime > CONTINUOUS_STALE_SECONDS) this.removeEngine(id);
    for (const [id, v] of this.sirens) if (now - v.lastTime > CONTINUOUS_STALE_SECONDS) this.removeSiren(id);
    for (const [id, v] of this.skids) if (now - v.lastTime > CONTINUOUS_STALE_SECONDS) this.removeSkid(id);
  }

  // ----- Radio -----

  setRadioStation(index: number): void {
    const idx = Number.isFinite(index) ? Math.floor(index) : -1;
    const next = idx >= 0 && idx < AudioEngine.RADIO_STATIONS.length ? idx : -1;
    if (next === this.station) return;
    this.station = next;
    const g = this.g;
    if (!g) return; // remembered; the rig is built lazily in update() once audio is up
    this.teardownRig(g);
    this.playStatic(g);
    if (next >= 0) {
      this.rig = this.buildRig(g, next);
      this.radioStep = 0;
      this.radioNextTime = -1;
    }
  }

  getRadioStation(): number {
    return this.station;
  }

  getRadioStationName(): string {
    return this.station >= 0 ? AudioEngine.RADIO_STATIONS[this.station] : 'Off';
  }

  setRadioAudible(v: boolean): void {
    if (v === this.radioAudible) return;
    this.radioAudible = v;
    const g = this.g;
    if (!g) return;
    const t = g.ctx.currentTime;
    g.radio.gain.setTargetAtTime(v ? 1 : 0, t, 0.25);
    this.radioFadeEnd = t + 1.2;
  }

  /** Brief tuning static on a station switch (routed through the radio bus so it obeys audibility). */
  private playStatic(g: Graph): void {
    const p = this.patch(undefined, undefined, undefined, 0, g.radio, false);
    if (!p) return;
    const t = g.ctx.currentTime;
    this.burst(p, t, 0.22, 0.3, 'bandpass', 1500, 0.5, 900, 0.01);
    this.burst(p, t + 0.05, 0.05, 0.2, 'highpass', 3000, 0.7);
    p.finish();
  }

  private buildRig(g: Graph, station: number): StationRig {
    const ctx = g.ctx;
    const out = mkGain(ctx, 1, g.radio);
    const rig: StationRig = { out, nodes: [out], sources: [], distIn: null, send: null, lead: null, leadBusyUntil: 0 };
    if (station === 1) {
      // Persistent square lead so notes can glide (portamento) into each other.
      const lp = mkFilter(ctx, 'lowpass', 1600, 1, out);
      const gain = mkGain(ctx, 0, lp);
      const osc = mkOsc(ctx, 'square', midiToFreq(BASS_SCALE[0]), gain);
      osc.start(ctx.currentTime);
      rig.lead = { osc, gain };
      rig.nodes.push(lp, gain, osc);
      rig.sources.push(osc);
    } else if (station === 2) {
      // Feedback delay standing in for a concert-hall tail: send -> delay -> lowpass -> (out, back into delay).
      const delay = ctx.createDelay(1);
      delay.delayTime.value = 0.31;
      const send = mkGain(ctx, 0.45, delay);
      const lp = mkFilter(ctx, 'lowpass', 2200, 1, out);
      const fb = mkGain(ctx, 0.38, delay);
      delay.connect(lp);
      lp.connect(fb);
      rig.send = send;
      rig.nodes.push(send, delay, fb, lp);
    } else if (station === 3) {
      // Guitar amp: pre-gain -> waveshaper -> lowpass -> post-gain.
      const post = mkGain(ctx, 0.32, out);
      const lp = mkFilter(ctx, 'lowpass', 2600, 0.7, post);
      const shaper = ctx.createWaveShaper();
      shaper.curve = makeDistortionCurve(40);
      shaper.oversample = '2x';
      shaper.connect(lp);
      const distIn = mkGain(ctx, 1.8, shaper);
      rig.distIn = distIn;
      rig.nodes.push(distIn, shaper, lp, post);
    }
    return rig;
  }

  private teardownRig(g: Graph): void {
    const rig = this.rig;
    this.rig = null;
    if (!rig) return;
    const ctx = g.ctx;
    const t = ctx.currentTime;
    rig.out.gain.setTargetAtTime(0, t, 0.02);
    for (const s of rig.sources) {
      try {
        s.stop(t + 0.3);
      } catch {
        /* already stopped */
      }
    }
    // A silent sentinel oscillator ends once the fade is over; its onended tears the rig down on the
    // audio clock (a wall-clock timer could fire while a suspended context has not faded yet).
    const silent = mkGain(ctx, 0, rig.out);
    const sentinel = mkOsc(ctx, 'sine', 1, silent);
    const nodes = [...rig.nodes, silent, sentinel];
    sentinel.onended = () => {
      for (const n of nodes) safeDisconnect(n);
    };
    sentinel.start(t);
    sentinel.stop(t + 0.35);
  }

  private updateRadio(g: Graph): void {
    if (this.station < 0) return;
    if (!this.rig) this.rig = this.buildRig(g, this.station);
    const now = g.ctx.currentTime;
    if (!this.radioAudible && now > this.radioFadeEnd) {
      // Faded out: pause the sequencer rather than scheduling silent notes.
      this.radioNextTime = -1;
      return;
    }
    const sd = 60 / STATION_BPM[this.station] / 4; // one 16th step
    if (this.radioNextTime < now - 0.05) {
      // (Re)sync after a pause or a frozen tab, starting on a bar boundary.
      this.radioStep = Math.ceil(this.radioStep / 16) * 16;
      this.radioNextTime = now + 0.03;
    }
    while (this.radioNextTime < now + RADIO_LOOKAHEAD) {
      this.scheduleStep(this.rig, this.station, this.radioStep, this.radioNextTime, sd);
      this.radioStep++;
      this.radioNextTime += sd;
    }
  }

  private scheduleStep(rig: StationRig, station: number, step: number, t: number, sd: number): void {
    const p = this.patch(undefined, undefined, undefined, 0, rig.out, false);
    if (!p) return;
    switch (station) {
      case 0: this.stepNeon(p, step, t, sd); break;
      case 1: this.stepBass(p, rig, step, t, sd); break;
      case 2: this.stepClassic(p, rig, step, t, sd); break;
      default: this.stepRock(p, rig, step, t); break;
    }
    p.finish();
  }

  /** Neon FM — synthwave, 110 BPM: pumping pad, A-minor arpeggio, four-on-the-floor. */
  private stepNeon(p: Patch, step: number, t: number, sd: number): void {
    const bar = Math.floor(step / 16);
    const i = step % 16;
    const beat = sd * 4;
    const chord = NEON_CHORDS[bar % 4];
    if (i === 0) {
      // Pad: detuned saw pairs through a lowpass; gain dips on every beat and swells back (sidechain feel).
      const padGain = p.gain(MIN_GAIN);
      const lp = p.filter('lowpass', 1100, 0.8, padGain);
      const end = t + beat * 4 + 0.15;
      for (const n of chord) {
        const f = midiToFreq(n);
        p.osc('sawtooth', f, t, end, lp).detune.value = -9;
        p.osc('sawtooth', f, t, end, lp).detune.value = 9;
      }
      for (let b = 0; b < 4; b++) {
        const tb = t + b * beat;
        padGain.gain.setValueAtTime(0.012, tb);
        padGain.gain.linearRampToValueAtTime(0.055, tb + beat * 0.6);
      }
      padGain.gain.setValueAtTime(0.055, t + 4 * beat - 0.05);
      padGain.gain.linearRampToValueAtTime(MIN_GAIN, t + 4 * beat + 0.1);
    }
    if (i % 4 === 0) this.kick(p, t, 150, 45, 0.28, 0.75);
    if (i % 4 === 2) this.hat(p, t, 0.05, 0.16);
    else if (i % 2 === 1) this.hat(p, t, 0.025, 0.06);
    // Bass: root two octaves down on 8ths.
    if (i % 2 === 0) this.tone(p, t, 0.16, 0.22, 'sawtooth', midiToFreq(chord[0] - 24), undefined, 0.005, p.filter('lowpass', 260, 1));
    // Arpeggio: 16ths walking the chord tones; the hash throws in octave jumps.
    const tones = [chord[0], chord[1], chord[2], chord[0] + 12];
    const n = tones[NEON_ARP[i % 8]] + 12 + (hash01(0, bar, i) < 0.2 ? 12 : 0);
    const arpLp = p.filter('lowpass', 2600, 2);
    sweep(arpLp.frequency, t, 2600, 500, 0.15);
    this.tone(p, t, 0.18, 0.12, 'square', midiToFreq(n), undefined, 0.003, arpLp);
  }

  /** Bass Nation — hip-hop, 90 BPM: 808 kick, swung hats, sparse pentatonic lead. */
  private stepBass(p: Patch, rig: StationRig, step: number, t: number, sd: number): void {
    const bar = Math.floor(step / 16);
    const i = step % 16;
    if (i % 2 === 1) t += sd * 0.3; // swing: every off-16th lands late
    // 808: sine dropping 165 -> 40 Hz with a long tail.
    if (BASS_KICK[i] === 1 || (i === 13 && hash01(1, bar, 99) < 0.35)) {
      this.tone(p, t, 0.55, 0.95, 'sine', 165, 40, 0.002);
      this.burst(p, t, 0.01, 0.3, 'highpass', 1200, 0.7);
    }
    if (i === 4 || i === 12) this.snare(p, t, 0.45);
    if (hash01(1, bar, i + 200) > 0.18) this.hat(p, t, i % 4 === 0 ? 0.04 : 0.025, i % 2 === 0 ? 0.13 : 0.07);
    if (i === 14 && bar % 2 === 1) this.hat(p, t, 0.18, 0.12); // open hat
    // Lead: glide to a new pentatonic note now and then; notes never overlap.
    if (rig.lead && i % 2 === 0 && t >= rig.leadBusyUntil && hash01(1, bar, i + 300) < 0.22) {
      const note = BASS_SCALE[Math.floor(hash01(1, bar, i + 400) * BASS_SCALE.length)];
      const len = sd * (2 + 2 * Math.floor(hash01(1, bar, i + 500) * 3)); // 2, 4 or 6 steps
      const { osc, gain } = rig.lead;
      osc.frequency.setTargetAtTime(midiToFreq(note), t, 0.045); // portamento
      gain.gain.cancelScheduledValues(t);
      gain.gain.setTargetAtTime(0.11, t, 0.01);
      gain.gain.setTargetAtTime(0, t + len - 0.06, 0.04);
      rig.leadBusyUntil = t + len;
    }
  }

  /** Classic Grand — 72 BPM: arpeggiated I–V–vi–IV in C with long releases through a delay "hall". */
  private stepClassic(p: Patch, rig: StationRig, step: number, t: number, sd: number): void {
    const bar = Math.floor(step / 16);
    const i = step % 16;
    const chord = CLASSIC_CHORDS[bar % 4];
    const bus = p.gain(1);
    if (rig.send) bus.connect(rig.send);
    if (i % 2 === 0) {
      const tones = [chord[0], chord[1], chord[2], chord[0] + 12];
      const n = tones[CLASSIC_ARP[i / 2]] + (hash01(2, bar, i) < 0.15 ? 12 : 0);
      this.tone(p, t, 1.4, 0.2, 'triangle', midiToFreq(n), undefined, 0.012, bus);
    }
    if (i === 0) this.tone(p, t, 2.4, 0.26, 'triangle', midiToFreq(chord[0] - 24), undefined, 0.02, bus); // bass
    if (i === 8 && hash01(2, bar, 77) < 0.6) {
      // Occasional melody note an octave above, on beat 3.
      const n = chord[Math.floor(hash01(2, bar, 78) * 3)] + 12;
      this.tone(p, t + sd * 0.1, 1.1, 0.13, 'sine', midiToFreq(n), undefined, 0.03, bus);
    }
  }

  /** Drift Rock — 140 BPM: distorted power chords on an E riff, driving 8ths, fills every 4th bar. */
  private stepRock(p: Patch, rig: StationRig, step: number, t: number): void {
    const bar = Math.floor(step / 16);
    const i = step % 16;
    const root = ROCK_RIFF[(bar * 2 + Math.floor(i / 8)) % ROCK_RIFF.length];
    const fill = bar % 4 === 3 && i >= 12;
    const amp = rig.distIn ?? p.out;
    if (i % 2 === 0) {
      // Power chord (root, fifth, octave) into the amp; palm-muted except on the downbeat or by chance.
      const open = i % 8 === 0 || hash01(3, bar, i) < 0.25;
      const cg = p.gain(MIN_GAIN, amp);
      adEnv(cg.gain, t, open ? 0.5 : 0.4, 0.004, open ? 0.42 : 0.16);
      for (const semis of [0, 7, 12]) {
        p.osc('sawtooth', midiToFreq(root + semis), t, t + 0.5, cg).detune.value = semis === 0 ? -4 : 4;
      }
    }
    if (!fill) {
      if (i === 0 || i === 2 || i === 8 || i === 10) this.kick(p, t, 170, 50, 0.22, 0.8);
      if (i === 4 || i === 12) this.snare(p, t, 0.55, 200);
      if (i % 2 === 0) this.hat(p, t, 0.04, 0.12);
    } else {
      // 16th-note snare roll rising into the next bar.
      this.snare(p, t, 0.35 + (i - 12) * 0.08, 200 + (i - 12) * 12);
      if (i === 12 || i === 14) this.kick(p, t, 170, 50, 0.22, 0.7);
    }
    if (i === 0 && bar % 4 === 0) this.burst(p, t, 0.7, 0.18, 'highpass', 5000, 0.5); // crash wash
  }
}

/** Shared singleton. */
export const audio = new AudioEngine();
