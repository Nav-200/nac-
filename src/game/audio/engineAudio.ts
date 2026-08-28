import { clamp01, lerp } from '../engine/math';

const MUTE_KEY = 'nac-racing:muted:v1';

/**
 * All game audio is synthesised — there are no sound files to download.
 *
 * The engine is a small stack of detuned saws whose pitch follows RPM through a
 * resonant lowpass; tyre squeal and wind are filtered noise driven by slip and
 * speed. The context can only be created from a user gesture, so `resume` is
 * wired to the Start button.
 */
export class EngineAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;

  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private oscillators: OscillatorNode[] = [];

  private noiseSource: AudioBufferSourceNode | null = null;
  private squealFilter: BiquadFilterNode | null = null;
  private squealGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;

  private started = false;
  muted = false;

  constructor() {
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      this.muted = false;
    }
  }

  /** Must be called from a user gesture. Safe to call repeatedly. */
  async resume(): Promise<void> {
    if (!this.started) {
      this.build();
      this.started = true;
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        // Autoplay policy refused; the game is perfectly playable in silence.
      }
    }
  }

  private build(): void {
    type WithWebkit = typeof globalThis & { webkitAudioContext?: typeof AudioContext };
    const Ctor = window.AudioContext ?? (globalThis as WithWebkit).webkitAudioContext;
    if (!Ctor) return;

    let ctx: AudioContext;
    try {
      ctx = new Ctor();
    } catch {
      return;
    }
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.55;
    this.master.connect(ctx.destination);

    // --- Engine ---
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 900;
    this.engineFilter.Q.value = 5.5;

    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;

    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.master);

    // Detuned partials: an octave down for weight, the fifth above for the
    // rasp, and a slightly sharp unison so it never sounds like a test tone.
    const layers: Array<{ type: OscillatorType; ratio: number; gain: number }> = [
      { type: 'sawtooth', ratio: 0.5, gain: 0.55 },
      { type: 'sawtooth', ratio: 1.0, gain: 0.42 },
      { type: 'square', ratio: 1.005, gain: 0.16 },
      { type: 'sawtooth', ratio: 1.503, gain: 0.13 },
    ];
    for (const layer of layers) {
      const osc = ctx.createOscillator();
      osc.type = layer.type;
      osc.frequency.value = 60 * layer.ratio;
      const g = ctx.createGain();
      g.gain.value = layer.gain;
      osc.connect(g);
      g.connect(this.engineFilter);
      osc.start();
      this.oscillators.push(osc);
    }

    // --- Noise bed, shared by squeal and wind ---
    const noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;
    this.noiseSource = noise;

    this.squealFilter = ctx.createBiquadFilter();
    this.squealFilter.type = 'bandpass';
    this.squealFilter.frequency.value = 1500;
    this.squealFilter.Q.value = 9;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    noise.connect(this.squealFilter);
    this.squealFilter.connect(this.squealGain);
    this.squealGain.connect(this.master);

    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 620;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    noise.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.master);

    noise.start();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    try {
      localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
    } catch {
      // Storage is optional.
    }
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.55, this.ctx.currentTime, 0.05);
    }
  }

  /** Called every frame with the current car state. */
  update(
    rpm01: number,
    throttle: number,
    speed: number,
    slip: number,
    offRoad: boolean,
    grounded: boolean,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.engineFilter || !this.engineGain) return;
    const now = ctx.currentTime;
    const smooth = 0.04;

    // Four-stroke firing frequency for a V8-ish note.
    const baseHz = lerp(38, 205, clamp01(rpm01));
    for (let i = 0; i < this.oscillators.length; i++) {
      const ratios = [0.5, 1, 1.005, 1.503];
      this.oscillators[i].frequency.setTargetAtTime(baseHz * ratios[i], now, smooth);
    }

    // Opening the throttle opens the filter: that is most of what makes an
    // engine sound like it is under load rather than just spinning.
    const load = clamp01(throttle * 0.75 + rpm01 * 0.45);
    this.engineFilter.frequency.setTargetAtTime(
      lerp(420, 3200, load),
      now,
      smooth,
    );
    const engineLevel = grounded ? lerp(0.1, 0.34, load) : lerp(0.16, 0.3, load);
    this.engineGain.gain.setTargetAtTime(engineLevel, now, smooth);

    if (this.squealGain && this.squealFilter) {
      const slipAmount = clamp01((Math.abs(slip) - 0.13) / 0.45);
      const level = grounded && speed > 7 ? slipAmount * (offRoad ? 0.05 : 0.16) : 0;
      this.squealGain.gain.setTargetAtTime(level, now, 0.06);
      this.squealFilter.frequency.setTargetAtTime(
        lerp(1150, 2100, clamp01(speed / 60)),
        now,
        0.1,
      );
    }

    if (this.windGain && this.windFilter) {
      const level = clamp01(speed / 80) ** 2 * 0.14;
      this.windGain.gain.setTargetAtTime(level, now, 0.1);
      this.windFilter.frequency.setTargetAtTime(lerp(300, 1100, clamp01(speed / 80)), now, 0.1);
    }
  }

  /** Short blip used for countdown ticks, gate passes and the finish. */
  blip(frequency: number, duration = 0.16, gain = 0.25): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = frequency;
    const now = ctx.currentTime;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(gain, now + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(g);
    g.connect(this.master);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  /** Silences the engine without tearing the graph down (pause menu). */
  setIdle(): void {
    if (!this.ctx || !this.engineGain) return;
    this.engineGain.gain.setTargetAtTime(0.05, this.ctx.currentTime, 0.08);
    this.squealGain?.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
    this.windGain?.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
  }

  dispose(): void {
    for (const osc of this.oscillators) {
      try {
        osc.stop();
      } catch {
        // Already stopped.
      }
    }
    this.oscillators = [];
    try {
      this.noiseSource?.stop();
    } catch {
      // Already stopped.
    }
    this.noiseSource = null;
    this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.started = false;
  }
}
