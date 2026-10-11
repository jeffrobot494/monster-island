// Rigs from generated models (Meshy, via run.world threeDGen): one skinned mesh driven by named clips instead of
// primitives on joints. Each model is loaded once per page; until it arrives, or if it never does, the shape keeps its
// procedural rig from rigs.ts.
//
// A model file holds the rigged mesh plus every clip, named by its preset (idle, walk, run, attack, hit, fall, jump),
// merged from the per-clip files threeDGen returns. Clips are made in place here: the root bone's horizontal travel
// is pinned to its rest position, because the sim, not the clip, moves the body.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { Rig, ANIM, ZONE_BIT, buildRig, type Zone } from './rigs';

interface ModelDef {
  url: string;
  /** standing height in shape units (the procedural rig's height) */
  height: number;
  /** bone shrunk to nothing when that zone is severed */
  bones: Partial<Record<Zone, string>>;
  /** fraction of the attack clip where the blow lands: the windup scrubs up to it, the strike plays on from it */
  impact: number;
}

const MODELS: Record<string, ModelDef> = {
  nephil: {
    url: new URL('./models/nephil.glb', import.meta.url).href,
    height: 1.0,
    bones: { head: 'Head', armL: 'LeftArm', armR: 'RightArm', legL: 'LeftUpLeg', legR: 'RightUpLeg', sig: 'RightHand' },
    impact: 0.5,
  },
};

interface Loaded { scene: THREE.Object3D; clips: Map<string, THREE.AnimationClip>; size: number }
const loaded = new Map<string, Loaded>();
const listeners: (() => void)[] = [];

/** Called whenever another model finishes loading, so views built with the procedural rig can rebuild. */
export function onModelsReady(cb: () => void) {
  listeners.push(cb);
}

const loader = new GLTFLoader();
for (const [shape, def] of Object.entries(MODELS)) {
  loader.load(def.url, (g) => {
    const hips = g.scene.getObjectByProperty('isBone', true);
    const clips = new Map<string, THREE.AnimationClip>();
    for (const clip of g.animations) {
      const track = hips && clip.tracks.find((t) => t.name === `${hips.name}.position`);
      if (track) {
        for (let i = 0; i < track.values.length; i += 3) {
          track.values[i] = hips.position.x;
          track.values[i + 2] = hips.position.z;
        }
      }
      clips.set(clip.name, clip);
    }
    let size = 1;
    g.scene.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh) return;
      m.geometry.computeBoundingBox();
      size = m.geometry.boundingBox!.max.y - m.geometry.boundingBox!.min.y;
    });
    loaded.set(shape, { scene: g.scene, clips, size });
    for (const cb of listeners) cb();
  }, undefined, (err) => console.warn(`[glb-rig] ${shape}: ${def.url} failed to load; keeping the procedural rig`, err));
}

/** buildRig, with the generated model where one has loaded. */
export function buildModelRig(shape: string, tint: string, seed = 0): Rig {
  const m = loaded.get(shape);
  if (!m) return buildRig(shape, tint, seed);
  const r = new GlbRig(m, MODELS[shape]);
  r.phase = (seed * 0.618) % 10;
  return r;
}

const FADE = 0.2;

class GlbRig extends Rig {
  private mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private bones: Partial<Record<Zone, THREE.Object3D>> = {};
  private impact: number;
  private follow = 0; // seconds of attack follow-through left after a strike
  private hit = 0; // seconds of hit reaction left
  private lastStrike = 0;

  constructor(m: Loaded, def: ModelDef) {
    super();
    this.plan = 'biped';
    this.height = def.height;
    this.impact = def.impact;
    const model = clone(m.scene);
    model.scale.setScalar(def.height / m.size);
    model.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh) return;
      o.castShadow = true;
      o.frustumCulled = false; // the bind-pose bounds don't follow the clips
    });
    this.body.add(model);
    for (const [z, name] of Object.entries(def.bones) as [Zone, string][]) {
      const b = model.getObjectByName(name);
      if (b) this.bones[z] = b;
    }
    this.mixer = new THREE.AnimationMixer(model);
    for (const [name, clip] of m.clips) this.actions.set(name, this.mixer.clipAction(clip));
    this.play('idle');
  }

  override applyMask(mask: number) {
    if (mask === this.lastMask) return;
    this.lastMask = mask;
    for (const [z, b] of Object.entries(this.bones) as [Zone, THREE.Object3D][]) {
      b.scale.setScalar((mask >> (8 + ZONE_BIT[z])) & 1 ? 0.001 : 1);
    }
  }

  override hurt() {
    const a = this.actions.get('hit');
    if (a) this.hit = a.getClip().duration;
  }

  private play(name: string, once = false): THREE.AnimationAction | null {
    const a = this.actions.get(name) ?? this.actions.get('idle') ?? null;
    if (!a || a === this.current) return a;
    a.reset();
    a.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    a.clampWhenFinished = once;
    a.fadeIn(FADE).play();
    this.current?.fadeOut(FADE);
    this.current = a;
    return a;
  }

  override update(dt: number, _t: number, anim: number, _speed: number, windup: number, strike: number, mask: number) {
    this.applyMask(mask);
    const lifeless = anim === ANIM.dead || anim === ANIM.carried || anim === ANIM.bound || anim === ANIM.downed;
    if (strike > 0 && this.lastStrike === 0) {
      const a = this.actions.get('attack');
      this.follow = a ? a.getClip().duration * (1 - this.impact) : 0;
    }
    this.lastStrike = strike;
    this.follow = Math.max(0, this.follow - dt);
    this.hit = Math.max(0, this.hit - dt);

    if (lifeless) {
      // the renderer rolls the body onto its side; hold a still frame
      const a = this.play('idle');
      if (a) { a.paused = true; a.time = 0; }
    } else if (windup > 0) {
      const a = this.play('attack');
      if (a) { a.paused = true; a.time = windup * this.impact * a.getClip().duration; }
    } else if (this.follow > 0) {
      const a = this.play('attack');
      if (a) {
        if (a.paused) a.time = this.impact * a.getClip().duration;
        a.paused = false;
      }
    } else if (this.hit > 0) {
      this.play('hit', true);
    } else {
      const moving = anim === ANIM.walk || anim === ANIM.run || anim === ANIM.flee;
      const a = this.play(anim === ANIM.run || anim === ANIM.flee ? 'run' : moving ? 'walk' : 'idle');
      if (a) a.paused = false;
    }
    this.mixer.update(dt);
  }
}
