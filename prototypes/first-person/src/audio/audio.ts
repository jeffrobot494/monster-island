// Synthesized, positional game audio (spec §10). No audio files: everything is oscillators, filtered noise and
// envelopes. Positions are in meters (renderer space).
export type SoundKind =
  | 'swing' | 'hit' | 'block' | 'step' | 'growl' | 'roar' | 'scream' | 'shofar' | 'judgment' | 'whiff' | 'hurt'
  | 'burn' | 'bind' | 'offer';

interface Pos { x: number; y: number; z: number }

export class GameAudio {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private fx!: GainNode;
  private amb!: GainNode;
  private noiseBuf!: AudioBuffer;
  private wind: { src: AudioBufferSourceNode; gain: GainNode; filt: BiquadFilterNode } | null = null;
  private crickets: { gain: GainNode } | null = null;
  private surf: { gain: GainNode } | null = null;
  private fire: { panner: PannerNode; gain: GainNode } | null = null;
  volume = 0.8;
  fxVolume = 1;

  /** Must be called from a user gesture (browser autoplay rules). */
  start() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);
    this.fx = ctx.createGain();
    this.fx.gain.value = this.fxVolume;
    this.fx.connect(this.master);
    this.amb = ctx.createGain();
    this.amb.gain.value = 0.5;
    this.amb.connect(this.master);
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    let s = 12345;
    for (let i = 0; i < len; i++) {
      s = (s * 1103515245 + 12345) >>> 0;
      d[i] = (s / 4294967296) * 2 - 1;
    }
    this.startAmbience();
  }

  setVolumes(master: number, fx: number) {
    this.volume = master;
    this.fxVolume = fx;
    if (!this.ctx) return;
    this.master.gain.value = master;
    this.fx.gain.value = fx;
  }

  /** Update the listener from the camera (meters). */
  listener(p: Pos, fx: number, fy: number, fz: number) {
    const c = this.ctx;
    if (!c) return;
    const L = c.listener;
    if (L.positionX) {
      const t = c.currentTime;
      L.positionX.setTargetAtTime(p.x, t, 0.02);
      L.positionY.setTargetAtTime(p.y, t, 0.02);
      L.positionZ.setTargetAtTime(p.z, t, 0.02);
      L.forwardX.setTargetAtTime(fx, t, 0.02);
      L.forwardY.setTargetAtTime(fy, t, 0.02);
      L.forwardZ.setTargetAtTime(fz, t, 0.02);
      L.upX.value = 0;
      L.upY.value = 1;
      L.upZ.value = 0;
    } else {
      (L as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(p.x, p.y, p.z);
      (L as unknown as { setOrientation(a: number, b: number, c: number, d: number, e: number, f: number): void }).setOrientation(fx, fy, fz, 0, 1, 0);
    }
  }

  /** Ambience mix: day wind, night crickets, surf near the shore (0..1 each). */
  ambience(night: number, shore: number, firePos: Pos | null) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.wind?.gain.gain.setTargetAtTime(0.05 + 0.08 * (1 - night), t, 0.5);
    this.crickets?.gain.gain.setTargetAtTime(0.05 * night, t, 0.5);
    this.surf?.gain.gain.setTargetAtTime(0.12 * shore, t, 0.5);
    if (this.fire && firePos) {
      const p = this.fire.panner;
      p.positionX.setTargetAtTime(firePos.x, t, 0.1);
      p.positionY.setTargetAtTime(firePos.y, t, 0.1);
      p.positionZ.setTargetAtTime(firePos.z, t, 0.1);
    }
  }

  private noise(loop = false): AudioBufferSourceNode {
    const n = this.ctx!.createBufferSource();
    n.buffer = this.noiseBuf;
    n.loop = loop;
    if (!loop) n.loopStart = 0;
    return n;
  }

  private panner(p: Pos, maxDistance = 300, ref = 4): PannerNode {
    const pn = this.ctx!.createPanner();
    pn.panningModel = 'HRTF';
    pn.distanceModel = 'inverse';
    pn.refDistance = ref;
    pn.maxDistance = maxDistance;
    pn.rolloffFactor = 1;
    if (pn.positionX) {
      pn.positionX.value = p.x;
      pn.positionY.value = p.y;
      pn.positionZ.value = p.z;
    } else (pn as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(p.x, p.y, p.z);
    pn.connect(this.fx);
    return pn;
  }

  private env(g: GainNode, t: number, a: number, peak: number, dec: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + dec);
  }

  private startAmbience() {
    const c = this.ctx!;
    // wind: looped noise through a slowly wandering lowpass
    const src = this.noise(true);
    const filt = c.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 500;
    const lfo = c.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = c.createGain();
    lfoGain.gain.value = 250;
    lfo.connect(lfoGain).connect(filt.frequency);
    const gain = c.createGain();
    gain.gain.value = 0.08;
    src.connect(filt).connect(gain).connect(this.amb);
    src.start();
    lfo.start();
    this.wind = { src, gain, filt };
    // crickets: a 4.2 kHz sine gated by a fast square
    const osc = c.createOscillator();
    osc.frequency.value = 4200;
    const gate = c.createGain();
    gate.gain.value = 0;
    const chirp = c.createOscillator();
    chirp.type = 'square';
    chirp.frequency.value = 14;
    const chirpGain = c.createGain();
    chirpGain.gain.value = 0.5;
    chirp.connect(chirpGain).connect(gate.gain);
    const cg = c.createGain();
    cg.gain.value = 0;
    osc.connect(gate).connect(cg).connect(this.amb);
    osc.start();
    chirp.start();
    this.crickets = { gain: cg };
    // surf: noise through a lowpass with a slow swell
    const sn = this.noise(true);
    const sf = c.createBiquadFilter();
    sf.type = 'lowpass';
    sf.frequency.value = 900;
    const swell = c.createOscillator();
    swell.frequency.value = 0.12;
    const swellGain = c.createGain();
    swellGain.gain.value = 0.5;
    const sg = c.createGain();
    sg.gain.value = 0;
    const sv = c.createGain();
    sv.gain.value = 0.5;
    swell.connect(swellGain).connect(sv.gain);
    sn.connect(sf).connect(sv).connect(sg).connect(this.amb);
    sn.start();
    swell.start();
    this.surf = { gain: sg };
    // the village altar fire: a soft low roar that breathes, with sparse irregular pops on top
    const fn = this.noise(true);
    const ff = c.createBiquadFilter();
    ff.type = 'lowpass';
    ff.frequency.value = 420;
    ff.Q.value = 0.4;
    const roar = c.createGain();
    roar.gain.value = 0.5;
    // two slow, detuned swells so the roar never settles into an audible beat
    for (const [hz, depth] of [[0.13, 0.14], [0.31, 0.09]]) {
      const lfo = c.createOscillator();
      lfo.frequency.value = hz;
      const lg = c.createGain();
      lg.gain.value = depth;
      lfo.connect(lg).connect(roar.gain);
      lfo.start();
    }
    // crackles: a long buffer of a few random clicks of random size, so the loop has no rhythm
    const len = Math.floor(c.sampleRate * 9.7);
    const cb = c.createBuffer(1, len, c.sampleRate);
    const d = cb.getChannelData(0);
    for (let k = 0; k < 26; k++) {
      const at = Math.floor(Math.random() * (len - 2000));
      const amp = 0.15 + Math.random() ** 3 * 0.85;
      const dur = 60 + Math.floor(Math.random() * 500);
      for (let i = 0; i < dur; i++) d[at + i] += (Math.random() * 2 - 1) * amp * Math.exp(-i / (dur * 0.25));
    }
    const cs = c.createBufferSource();
    cs.buffer = cb;
    cs.loop = true;
    const cf = c.createBiquadFilter();
    cf.type = 'bandpass';
    cf.frequency.value = 2200;
    cf.Q.value = 0.7;
    const cgain = c.createGain();
    cgain.gain.value = 0.22;
    const fg = c.createGain();
    fg.gain.value = 0.35;
    const panner = this.panner({ x: 0, y: 0, z: 0 }, 60, 2);
    panner.disconnect();
    panner.connect(this.amb);
    fn.connect(ff).connect(roar).connect(fg);
    cs.connect(cf).connect(cgain).connect(fg);
    fg.connect(panner);
    fn.start();
    cs.start();
    this.fire = { panner, gain: fg };
  }

  play(kind: SoundKind, p?: Pos, opts: { size?: number; surface?: string } = {}) {
    const c = this.ctx;
    if (!c || c.state !== 'running') return;
    const t = c.currentTime;
    const out: AudioNode = p ? this.panner(p, kind === 'roar' ? 400 : kind === 'scream' ? 160 : 120, kind === 'roar' ? 10 : 4) : this.fx;
    const size = opts.size ?? 1;
    switch (kind) {
      case 'swing':
      case 'whiff': {
        const n = this.noise();
        const f = c.createBiquadFilter();
        f.type = 'bandpass';
        f.Q.value = 2;
        f.frequency.setValueAtTime(400, t);
        f.frequency.exponentialRampToValueAtTime(2400, t + 0.18);
        const g = c.createGain();
        this.env(g, t, 0.03, kind === 'swing' ? 0.5 : 0.3, 0.18);
        n.connect(f).connect(g).connect(out);
        n.start(t);
        n.stop(t + 0.3);
        break;
      }
      case 'hit':
      case 'hurt': {
        const n = this.noise();
        const f = c.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = kind === 'hurt' ? 500 : 900;
        const g = c.createGain();
        this.env(g, t, 0.005, 0.9, 0.16);
        n.connect(f).connect(g).connect(out);
        n.start(t);
        n.stop(t + 0.25);
        const o = c.createOscillator();
        o.frequency.setValueAtTime(140, t);
        o.frequency.exponentialRampToValueAtTime(50, t + 0.15);
        const og = c.createGain();
        this.env(og, t, 0.005, 0.6, 0.15);
        o.connect(og).connect(out);
        o.start(t);
        o.stop(t + 0.2);
        break;
      }
      case 'block': {
        for (const fr of [820, 1230, 1660]) {
          const o = c.createOscillator();
          o.frequency.value = fr * (0.98 + Math.random() * 0.04);
          const g = c.createGain();
          this.env(g, t, 0.003, 0.18, 0.45);
          o.connect(g).connect(out);
          o.start(t);
          o.stop(t + 0.5);
        }
        break;
      }
      case 'step': {
        const n = this.noise();
        const f = c.createBiquadFilter();
        f.type = 'lowpass';
        const soft = opts.surface === 'sand' || opts.surface === 'marsh' || opts.surface === 'salt';
        f.frequency.value = soft ? 300 : 600;
        const g = c.createGain();
        this.env(g, t, 0.004, soft ? 0.12 : 0.2, 0.07);
        n.connect(f).connect(g).connect(out);
        n.start(t, Math.random());
        n.stop(t + 0.1);
        break;
      }
      case 'growl': {
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = 70 / Math.sqrt(size);
        const wob = c.createOscillator();
        wob.frequency.value = 9;
        const wg = c.createGain();
        wg.gain.value = 12;
        wob.connect(wg).connect(o.frequency);
        const f = c.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 420;
        const g = c.createGain();
        this.env(g, t, 0.15, 0.7, 0.65);
        o.connect(f).connect(g).connect(out);
        o.start(t);
        wob.start(t);
        o.stop(t + 0.85);
        wob.stop(t + 0.85);
        break;
      }
      case 'roar': {
        const o = c.createOscillator();
        o.type = 'sawtooth';
        const base = 110 / Math.sqrt(size);
        o.frequency.setValueAtTime(base * 1.6, t);
        o.frequency.exponentialRampToValueAtTime(base * 0.7, t + 1.4);
        const n = this.noise();
        const nf = c.createBiquadFilter();
        nf.type = 'bandpass';
        nf.frequency.value = 600;
        const f = c.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 900;
        const g = c.createGain();
        this.env(g, t, 0.12, 1.0, 1.35);
        o.connect(f);
        n.connect(nf).connect(f);
        f.connect(g).connect(out);
        o.start(t);
        n.start(t);
        o.stop(t + 1.6);
        n.stop(t + 1.6);
        break;
      }
      case 'scream': {
        const o = c.createOscillator();
        o.type = 'triangle';
        o.frequency.setValueAtTime(700, t);
        o.frequency.linearRampToValueAtTime(1150, t + 0.3);
        o.frequency.linearRampToValueAtTime(820, t + 1.2);
        const vib = c.createOscillator();
        vib.frequency.value = 7;
        const vg = c.createGain();
        vg.gain.value = 30;
        vib.connect(vg).connect(o.frequency);
        const g = c.createGain();
        this.env(g, t, 0.05, 0.6, 1.15);
        o.connect(g).connect(out);
        o.start(t);
        vib.start(t);
        o.stop(t + 1.3);
        vib.stop(t + 1.3);
        break;
      }
      case 'shofar': {
        const notes: [number, number, number][] = [[233, 0, 1.2], [349, 1.25, 1.6]];
        for (const [fr, at, dur] of notes) {
          const o = c.createOscillator();
          o.type = 'sawtooth';
          o.frequency.setValueAtTime(fr * 0.97, t + at);
          o.frequency.linearRampToValueAtTime(fr, t + at + 0.2);
          const f = c.createBiquadFilter();
          f.type = 'lowpass';
          f.frequency.setValueAtTime(600, t + at);
          f.frequency.linearRampToValueAtTime(1800, t + at + 0.4);
          const g = c.createGain();
          g.gain.setValueAtTime(0.0001, t + at);
          g.gain.exponentialRampToValueAtTime(0.5, t + at + 0.25);
          g.gain.setValueAtTime(0.5, t + at + dur - 0.2);
          g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
          o.connect(f).connect(g).connect(out);
          o.start(t + at);
          o.stop(t + at + dur + 0.05);
        }
        break;
      }
      case 'judgment': {
        const o = c.createOscillator();
        o.frequency.setValueAtTime(90, t);
        o.frequency.exponentialRampToValueAtTime(40, t + 0.6);
        const g = c.createGain();
        this.env(g, t, 0.005, 1, 0.8);
        o.connect(g).connect(out);
        o.start(t);
        o.stop(t + 1);
        for (const fr of [220, 277, 330, 440]) {
          const v = c.createOscillator();
          v.type = 'sine';
          v.frequency.value = fr;
          const vg = c.createGain();
          vg.gain.setValueAtTime(0.0001, t + 0.3);
          vg.gain.exponentialRampToValueAtTime(0.08, t + 1.5);
          vg.gain.exponentialRampToValueAtTime(0.0001, t + 4.2);
          v.connect(vg).connect(out);
          v.start(t + 0.3);
          v.stop(t + 4.3);
        }
        break;
      }
      case 'burn':
      case 'offer': {
        const n = this.noise();
        const f = c.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = 1200;
        const g = c.createGain();
        this.env(g, t, 0.2, 0.5, 1.4);
        n.connect(f).connect(g).connect(out);
        n.start(t);
        n.stop(t + 1.8);
        break;
      }
      case 'bind': {
        const n = this.noise();
        const f = c.createBiquadFilter();
        f.type = 'highpass';
        f.frequency.value = 2000;
        const g = c.createGain();
        this.env(g, t, 0.01, 0.3, 0.35);
        n.connect(f).connect(g).connect(out);
        n.start(t);
        n.stop(t + 0.4);
        break;
      }
    }
  }
}
