import { getSettings } from '../settings';

export type Sfx = 'select' | 'order' | 'hit' | 'arrow' | 'boulder' | 'death' | 'build' | 'complete' | 'warning' | 'error' | 'coin' | 'ability' | 'victory' | 'defeat';

/** Tiny procedural sound effects on WebAudio - no asset downloads, works offline. */
export class AudioFx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private last = new Map<Sfx, number>();

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = getSettings().volume;
      this.master.connect(this.ctx.destination);
      return this.ctx;
    } catch { return null; }
  }

  unlock(): void {
    const c = this.ensure();
    if (c && c.state === 'suspended') c.resume().catch(() => { /* ignore */ });
  }

  setVolume(v: number): void { if (this.master) this.master.gain.value = v; }

  play(name: Sfx, pan = 0): void {
    const c = this.ensure();
    if (!c || !this.master || getSettings().volume <= 0) return;
    const now = c.currentTime;
    const lastT = this.last.get(name) ?? -1;
    const minGap = name === 'hit' || name === 'arrow' ? 0.05 : 0.12;
    if (now - lastT < minGap) return;
    this.last.set(name, now);
    const out = c.createStereoPanner ? c.createStereoPanner() : null;
    const dest: AudioNode = out ?? this.master;
    if (out) { out.pan.value = Math.max(-1, Math.min(1, pan)); out.connect(this.master); }

    const tone = (freq: number, dur: number, type: OscillatorType, gain: number, slide = 1) => {
      const o = c.createOscillator(); const g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, now); o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), now + dur);
      g.gain.setValueAtTime(gain, now); g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      o.connect(g); g.connect(dest); o.start(now); o.stop(now + dur + 0.02);
    };
    const noise = (dur: number, gain: number, freq: number) => {
      const len = Math.floor(c.sampleRate * dur);
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const s = c.createBufferSource(); s.buffer = buf;
      const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 0.8;
      const g = c.createGain(); g.gain.setValueAtTime(gain, now); g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      s.connect(f); f.connect(g); g.connect(dest); s.start(now);
    };
    switch (name) {
      case 'select': tone(880, 0.06, 'triangle', 0.12, 1.2); break;
      case 'order': tone(620, 0.07, 'square', 0.06, 1.1); break;
      case 'hit': noise(0.08, 0.25, 1800); tone(180, 0.06, 'square', 0.08, 0.6); break;
      case 'arrow': noise(0.12, 0.12, 3500); break;
      case 'boulder': noise(0.35, 0.5, 300); tone(70, 0.3, 'sine', 0.3, 0.5); break;
      case 'death': tone(220, 0.25, 'sawtooth', 0.12, 0.4); noise(0.15, 0.15, 900); break;
      case 'build': noise(0.1, 0.15, 1200); tone(300, 0.08, 'square', 0.05, 1); break;
      case 'complete': tone(523, 0.12, 'triangle', 0.14); setTimeout(() => tone(784, 0.2, 'triangle', 0.14), 90); break;
      case 'warning': tone(440, 0.15, 'square', 0.15, 0.8); setTimeout(() => tone(440, 0.2, 'square', 0.15, 0.8), 200); break;
      case 'error': tone(200, 0.15, 'sawtooth', 0.08, 0.8); break;
      case 'coin': tone(1400, 0.05, 'triangle', 0.05, 1.3); break;
      case 'ability': tone(500, 0.2, 'sine', 0.15, 2); noise(0.15, 0.1, 2500); break;
      case 'victory': [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, 0.35, 'triangle', 0.15), i * 130)); break;
      case 'defeat': [400, 330, 262, 196].forEach((f, i) => setTimeout(() => tone(f, 0.45, 'sawtooth', 0.1, 0.9), i * 180)); break;
    }
  }
}
