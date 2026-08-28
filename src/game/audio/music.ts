/**
 * A minimal synthwave loop: four-chord pad, eighth-note bass arp, offbeat
 * hats. Everything is scheduled a bar ahead against the AudioContext clock, so
 * frame hitches never make the music stutter. Nodes are short-lived and
 * bounded (~6 per beat), which WebAudio handles without breaking a sweat.
 */

const BPM = 96;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;

/** Chord roots as semitone offsets from A2 (110 Hz): Am, F, C, G. */
const PROGRESSION: number[][] = [
  [0, 3, 7],
  [-4, 0, 5],
  [3, 7, 12],
  [-2, 2, 7],
];

const semitone = (base: number, st: number): number => base * Math.pow(2, st / 12);

export class MusicLoop {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private timer = 0;
  private nextBarTime = 0;
  private barIndex = 0;
  private running = false;

  /** `destination` is the game's master gain, so mute silences music too. */
  attach(ctx: AudioContext, destination: AudioNode): void {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.16;
    this.out.connect(destination);
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running || !this.ctx || !this.out) return;
    this.running = true;
    this.nextBarTime = this.ctx.currentTime + 0.1;
    this.barIndex = 0;
    // Look ahead twice a second; schedule any bar starting within 1.2s.
    this.timer = window.setInterval(() => this.pump(), 480);
    this.pump();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    window.clearInterval(this.timer);
  }

  private pump(): void {
    const ctx = this.ctx;
    if (!ctx || !this.running) return;
    while (this.nextBarTime < ctx.currentTime + 1.2) {
      // A stall (backgrounded tab) can leave the grid behind the clock; jump
      // forward rather than burst-scheduling a pile of stale bars.
      if (this.nextBarTime < ctx.currentTime - 0.05) {
        this.nextBarTime = ctx.currentTime + 0.05;
      }
      this.scheduleBar(this.nextBarTime, this.barIndex);
      this.nextBarTime += BAR;
      this.barIndex++;
    }
  }

  private scheduleBar(t0: number, bar: number): void {
    const chord = PROGRESSION[bar % PROGRESSION.length];
    this.pad(t0, chord);
    for (let eighth = 0; eighth < 8; eighth++) {
      const t = t0 + eighth * (BEAT / 2);
      // Root-fifth-octave bass pattern.
      const st = chord[0] + [0, 12, 7, 12, 0, 12, 7, 12][eighth];
      this.bass(t, semitone(55, st));
      if (eighth % 2 === 1) this.hat(t);
    }
  }

  private pad(t: number, chord: number[]): void {
    const ctx = this.ctx!;
    const out = this.out!;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    filter.connect(out);
    for (const st of chord) {
      for (const detune of [-6, 6]) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = semitone(220, st);
        osc.detune.value = detune;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.045, t + 0.4);
        g.gain.setValueAtTime(0.045, t + BAR - 0.5);
        g.gain.linearRampToValueAtTime(0.0001, t + BAR);
        osc.connect(g);
        g.connect(filter);
        osc.start(t);
        osc.stop(t + BAR + 0.05);
      }
    }
  }

  private bass(t: number, freq: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + BEAT * 0.45);
    osc.connect(g);
    g.connect(this.out!);
    osc.start(t);
    osc.stop(t + BEAT * 0.5);
  }

  private hat(t: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 6200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.018, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    osc.connect(g);
    g.connect(this.out!);
    osc.start(t);
    osc.stop(t + 0.07);
  }

  dispose(): void {
    this.stop();
    this.out?.disconnect();
    this.ctx = null;
    this.out = null;
  }
}
