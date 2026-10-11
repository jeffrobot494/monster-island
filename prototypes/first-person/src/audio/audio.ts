// Positional game audio (spec §10), played from sourced CC0 recordings in public/audio (see public/audio/credits.md).
// Positions are in meters (renderer space).
export type SoundKind =
  | 'swing' | 'hit' | 'block' | 'step' | 'growl' | 'roar' | 'scream' | 'shofar' | 'judgment' | 'whiff' | 'hurt'
  | 'burn' | 'bind' | 'offer' | 'screech';

interface Pos { x: number; y: number; z: number }

export class GameAudio {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private fx!: GainNode;
  private amb!: GainNode;
  private bufs = new Map<string, AudioBuffer>();
  private wind: { gain: GainNode } | null = null;
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
    this.startAmbience();
    for (const f of FILES) void this.load(f);
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

  /** Ambience mix: day wind, surf near the shore (0..1 each). */
  ambience(night: number, shore: number, firePos: Pos | null) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.wind?.gain.gain.setTargetAtTime(0.05 + 0.08 * (1 - night), t, 0.5);
    this.surf?.gain.gain.setTargetAtTime(0.12 * shore, t, 0.5);
    if (this.fire && firePos) {
      const p = this.fire.panner;
      p.positionX.setTargetAtTime(firePos.x, t, 0.1);
      p.positionY.setTargetAtTime(firePos.y, t, 0.1);
      p.positionZ.setTargetAtTime(firePos.z, t, 0.1);
    }
  }

  private async load(name: string): Promise<AudioBuffer | null> {
    const have = this.bufs.get(name);
    if (have) return have;
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}audio/${name}.mp3`);
      const buf = await this.ctx!.decodeAudioData(await res.arrayBuffer());
      this.bufs.set(name, buf);
      return buf;
    } catch {
      return null;
    }
  }

  /** One-shot of a loaded file; silently skipped if it hasn't finished loading yet. */
  private sample(name: string, out: AudioNode, gain: number, rate = 1, at = 0) {
    const buf = this.bufs.get(name);
    if (!buf) return;
    const c = this.ctx!;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = c.createGain();
    g.gain.value = gain;
    src.connect(g).connect(out);
    src.start(c.currentTime + at);
  }

  /** A looped file that starts once loaded; returns its gain so the mix can ride it. */
  private loop(name: string, out: AudioNode, gain: number): GainNode {
    const c = this.ctx!;
    const g = c.createGain();
    g.gain.value = gain;
    g.connect(out);
    void this.load(name).then((buf) => {
      if (!buf) return;
      const src = c.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(g);
      // start somewhere random so loops don't line up across reloads
      src.start(0, Math.random() * buf.duration);
    });
    return g;
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

  private startAmbience() {
    this.wind = { gain: this.loop('wind', this.amb, 0.08) };
    this.surf = { gain: this.loop('surf', this.amb, 0) };
    // the village altar fire, positioned at the altar
    const panner = this.panner({ x: 0, y: 0, z: 0 }, 60, 2);
    panner.disconnect();
    panner.connect(this.amb);
    // soften it: the raw recording's crackle is sharp and loud up close
    const tame = this.ctx!.createBiquadFilter();
    tame.type = 'lowpass';
    tame.frequency.value = 2400;
    tame.Q.value = 0.5;
    tame.connect(panner);
    const fg = this.loop('fire', tame, 0.28);
    this.fire = { panner, gain: fg };
  }

  play(kind: SoundKind, p?: Pos, opts: { size?: number; surface?: string } = {}) {
    const c = this.ctx;
    if (!c || c.state !== 'running') return;
    const out: AudioNode = p ? this.panner(p, kind === 'roar' || kind === 'screech' ? 400 : kind === 'scream' ? 160 : 120, kind === 'roar' || kind === 'screech' ? 10 : 4) : this.fx;
    const size = opts.size ?? 1;
    // a little pitch scatter so repeated sounds don't machine-gun
    const vary = (amt: number) => 1 + (Math.random() * 2 - 1) * amt;
    switch (kind) {
      case 'swing': this.sample('swing', out, 0.6, vary(0.08)); break;
      case 'whiff': this.sample('whiff', out, 0.4, vary(0.08)); break;
      case 'hit': this.sample('hit', out, 0.9, vary(0.06)); break;
      case 'hurt': this.sample('hurt', out, 0.8, vary(0.05)); break;
      case 'block': this.sample('block', out, 0.5, vary(0.05)); break;
      case 'step': {
        const soft = opts.surface === 'sand' || opts.surface === 'marsh' || opts.surface === 'salt';
        this.sample(soft ? 'step-soft' : 'step', out, soft ? 0.35 : 0.3, vary(0.12));
        break;
      }
      // bigger monsters sound deeper
      case 'growl': this.sample('growl', out, 0.8, vary(0.05) / Math.sqrt(size)); break;
      case 'roar': this.sample('roar', out, 1, vary(0.04) / Math.sqrt(size)); break;
      case 'screech': this.sample('screech', out, 0.9, vary(0.06)); break;
      case 'scream': this.sample('scream', out, 0.6, vary(0.1)); break;
      case 'shofar': this.sample('shofar', out, 0.7); break;
      case 'judgment': this.sample('judgment', out, 1); break;
      case 'burn':
      case 'offer': this.sample('burn', out, 0.6, vary(0.05)); break;
      case 'bind': this.sample('bind', out, 0.5, vary(0.05)); break;
    }
  }
}

const FILES = ['swing', 'whiff', 'hit', 'hurt', 'block', 'step', 'step-soft', 'growl', 'roar', 'screech', 'scream', 'shofar', 'judgment', 'burn', 'bind'];
