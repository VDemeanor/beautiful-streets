/**
 * Sound for the film, made on the spot with the Web Audio API rather than
 * played from recordings: footsteps, a chime for each gem, the cable car's
 * bell, a gull now and then, a low wash of city air, and a short flourish at
 * the finish.
 */

type Ctx = AudioContext;

export class Sound {
  private ctx: Ctx | null = null;
  private out: GainNode | null = null;
  private air: { source: AudioBufferSourceNode; gain: GainNode } | null = null;
  private stepTimer = 0;
  private gullTimer = 0;
  private foot = 0;
  private noise: AudioBuffer | null = null;
  muted = false;

  /** Must be called from a click or key press: browsers only start audio on a user's action. */
  private wake(): Ctx | null {
    if (this.muted) return null;
    try {
      if (!this.ctx) {
        const AC: typeof AudioContext | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
        this.out = this.ctx.createGain();
        this.out.gain.value = 0.9;
        this.out.connect(this.ctx.destination);
        const length = this.ctx.sampleRate * 2;
        this.noise = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
        const data = this.noise.getChannelData(0);
        let brown = 0;
        for (let i = 0; i < length; i++) {
          // Brown noise: soft and low, like distant traffic and wind.
          brown = (brown + (Math.random() * 2 - 1) * 0.04) / 1.02;
          data[i] = brown * 3;
        }
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return this.ctx;
    } catch {
      return null;
    }
  }

  /** Call from a click, so the browser lets sound start. */
  unlock() {
    this.wake();
  }

  private tone(freq: number, at: number, length: number, peak: number, type: OscillatorType = 'sine', slideTo?: number) {
    const ctx = this.ctx;
    if (!ctx || !this.out) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, at + length);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
    osc.connect(gain).connect(this.out);
    osc.start(at);
    osc.stop(at + length + 0.05);
  }

  private footstep() {
    const ctx = this.ctx;
    if (!ctx || !this.out || !this.noise) return;
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    // Left and right feet land a little differently.
    filter.frequency.value = this.foot++ % 2 ? 620 : 760;
    filter.Q.value = 1.1;
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.5, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    source.connect(filter).connect(gain).connect(this.out);
    source.start(now, Math.random() * 1.5, 0.12);
  }

  private gull() {
    const ctx = this.wake();
    if (!ctx) return;
    const now = ctx.currentTime;
    // Three falling cries.
    for (let i = 0; i < 3; i++) this.tone(1750 - i * 90, now + i * 0.34, 0.26, 0.035, 'triangle', 1150 - i * 60);
  }

  /** Start or stop the sounds that run for as long as the walker is moving. */
  walking(on: boolean, daytime = true) {
    window.clearInterval(this.stepTimer);
    window.clearTimeout(this.gullTimer);
    this.stepTimer = 0;
    const ctx = on ? this.wake() : this.ctx;
    if (!on || !ctx || !this.out || !this.noise) {
      if (this.air && this.ctx) {
        const { source, gain } = this.air;
        gain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.3);
        source.stop(this.ctx.currentTime + 1.2);
        this.air = null;
      }
      return;
    }
    this.stepTimer = window.setInterval(() => this.footstep(), 430);
    if (!this.air) {
      const source = ctx.createBufferSource();
      source.buffer = this.noise;
      source.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 420;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.setTargetAtTime(0.16, ctx.currentTime, 0.8);
      source.connect(filter).connect(gain).connect(this.out);
      source.start();
      this.air = { source, gain };
    }
    if (daytime) {
      const next = () => {
        this.gull();
        this.gullTimer = window.setTimeout(next, 16000 + Math.random() * 22000);
      };
      this.gullTimer = window.setTimeout(next, 5000 + Math.random() * 9000);
    }
  }

  /** A gem collected: a quick rising sparkle, higher for each one in a row. */
  chime(n = 0) {
    const ctx = this.wake();
    if (!ctx) return;
    const now = ctx.currentTime;
    const base = 880 * 2 ** ((n % 5) / 12);
    [1, 1.5, 2, 3].forEach((ratio, i) => this.tone(base * ratio, now + i * 0.07, 0.5, 0.07));
  }

  /** The cable car's bell: two strikes. */
  bell() {
    const ctx = this.wake();
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const strike of [0, 0.28]) for (const [ratio, peak] of [[1, 0.09], [2.76, 0.04], [5.4, 0.02]]) this.tone(1050 * ratio, now + strike, 0.9, peak);
  }

  /** The walk is complete. */
  fanfare() {
    const ctx = this.wake();
    if (!ctx) return;
    const now = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(f, now + i * 0.13, i === 3 ? 1.4 : 0.5, 0.08, 'triangle'));
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (muted) this.walking(false);
  }

  dispose() {
    this.walking(false);
    void this.ctx?.close();
    this.ctx = null;
  }
}
