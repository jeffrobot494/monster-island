// Procedural creature rigs (spec §7.5): primitives on pivoted joints, animated from the pack's anim enum.
// Rigs are built in shape units (a human is ~0.8 units tall); the renderer scales the root by UNIT_M × entity scale.
import * as THREE from 'three';


export const ANIM = { idle: 0, walk: 1, run: 2, work: 3, windup: 4, strike: 5, flee: 6, downed: 7, bound: 8, carried: 9, dead: 10, sleep: 11 } as const;

const G = {
  box: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.SphereGeometry(0.5, 10, 7),
  cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 8),
  cone: new THREE.ConeGeometry(0.5, 1, 8),
  taper: new THREE.CylinderGeometry(0.35, 0.5, 1, 8),
};
type Prim = keyof typeof G;

const mats = new Map<string, THREE.MeshLambertMaterial>();
export function rigMat(color: string, emissive = 0): THREE.MeshLambertMaterial {
  const key = color + '|' + emissive;
  let m = mats.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color, flatShading: true });
    if (emissive) {
      m.emissive = new THREE.Color(color);
      m.emissiveIntensity = emissive;
    }
    mats.set(key, m);
  }
  return m;
}

function mesh(parent: THREE.Object3D, prim: Prim, size: [number, number, number], pos: [number, number, number], color: string, rot?: [number, number, number], emissive = 0): THREE.Mesh {
  const m = new THREE.Mesh(G[prim], rigMat(color, emissive));
  m.scale.set(size[0], size[1], size[2]);
  m.position.set(pos[0], pos[1], pos[2]);
  if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
  m.castShadow = true;
  parent.add(m);
  return m;
}

function joint(parent: THREE.Object3D, pos: [number, number, number]): THREE.Group {
  const g = new THREE.Group();
  g.position.set(pos[0], pos[1], pos[2]);
  parent.add(g);
  return g;
}

/** A limb hanging down (-y) from a joint. */
function limb(parent: THREE.Object3D, at: [number, number, number], len: number, thick: number, color: string, prim: Prim = 'box'): THREE.Group {
  const j = joint(parent, at);
  mesh(j, prim, [thick, len, thick * 1.1], [0, -len / 2, 0], color);
  return j;
}

export type Zone = 'head' | 'torso' | 'armL' | 'armR' | 'legL' | 'legR' | 'sig';
export const ZONE_BIT: Record<Zone, number> = { head: 0, torso: 1, armL: 2, armR: 3, legL: 4, legR: 5, sig: 6 };

export type Plan = 'biped' | 'quad' | 'serpent';

export class Rig {
  root = new THREE.Group(); // positioned + yawed by the renderer
  pose = new THREE.Group(); // roll / squash / lift
  body = new THREE.Group(); // leaning, breathing
  plan: Plan = 'biped';
  hipL?: THREE.Group; hipR?: THREE.Group; shL?: THREE.Group; shR?: THREE.Group; neck?: THREE.Group;
  /** quadrupeds: front legs are shL/shR, back legs hipL/hipR */
  segs: THREE.Group[] = [];
  wings: THREE.Group[] = [];
  tail?: THREE.Group;
  zoneObjs: Partial<Record<Zone, THREE.Object3D[]>> = {};
  stumps: Partial<Record<Zone, THREE.Mesh>> = {};
  height = 0.8;
  length = 0.4;
  hover = 0;
  phase = Math.random() * 10;
  strideLen = 0.35;
  lastMask = -1;
  castShadow = true;
  constructor() {
    this.root.add(this.pose);
    this.pose.add(this.body);
    this.root.rotation.order = 'YXZ';
  }

  mark(z: Zone, ...o: THREE.Object3D[]) {
    (this.zoneObjs[z] ??= []).push(...o);
  }

  stump(z: Zone, parent: THREE.Object3D, pos: [number, number, number], r: number) {
    const s = mesh(parent, 'cyl', [r, 0.02, r], pos, '#7a0a0a');
    s.visible = false;
    this.stumps[z] = s;
  }

  applyMask(mask: number) {
    if (mask === this.lastMask) return;
    this.lastMask = mask;
    for (const z of Object.keys(this.zoneObjs) as Zone[]) {
      const severed = (mask >> (8 + ZONE_BIT[z])) & 1;
      for (const o of this.zoneObjs[z]!) o.visible = !severed;
      const s = this.stumps[z];
      if (s) s.visible = !!severed;
    }
  }

  /** the entity just lost HP (rigs with a hit reaction override this) */
  hurt() {}

  crippled(mask: number, z: Zone) {
    return ((mask >> ZONE_BIT[z]) & 1) === 1 || ((mask >> (8 + ZONE_BIT[z])) & 1) === 1;
  }

  /**
   * Animate. `speed` is ground speed in units/s (before root scaling), `windup` 0..1 while telegraphing,
   * `strike` 1→0 just after a release.
   */
  update(dt: number, t: number, anim: number, speed: number, windup: number, strike: number, mask: number) {
    this.applyMask(mask);
    const moving = anim === ANIM.walk || anim === ANIM.run || anim === ANIM.flee;
    if (moving) this.phase += (Math.max(0.2, speed) * dt) / this.strideLen;
    else this.phase += dt * 0.5;
    const s = Math.sin(this.phase * Math.PI);
    const c = Math.cos(this.phase * Math.PI);
    const amp = anim === ANIM.run || anim === ANIM.flee ? 0.9 : moving ? 0.55 : 0;
    const limp = this.crippled(mask, 'legL') || this.crippled(mask, 'legR');
    const lifeless = anim === ANIM.dead || anim === ANIM.carried || anim === ANIM.bound;
    const breathe = lifeless ? 0 : Math.sin(t * 2 + this.phase * 0.1) * 0.01;
    this.body.position.y = breathe;
    this.body.rotation.set(0, 0, 0);

    if (this.plan === 'biped') {
      const lA = limp && this.crippled(mask, 'legL') ? 0.4 : 1;
      const rA = limp && this.crippled(mask, 'legR') ? 0.4 : 1;
      if (this.hipL) this.hipL.rotation.x = lifeless ? 0.2 : s * amp * lA;
      if (this.hipR) this.hipR.rotation.x = lifeless ? -0.1 : -s * amp * rA;
      let armL = -s * amp * 0.8, armR = s * amp * 0.8;
      let armLz = 0.05, armRz = -0.05;
      if (anim === ANIM.work) {
        armR = -0.8 + Math.sin(t * 4 + this.phase) * 0.6;
        armL = -0.5 + Math.sin(t * 4 + this.phase) * 0.3;
      }
      if (anim === ANIM.flee) {
        armL = -2.6 + s * 0.3;
        armR = -2.6 - s * 0.3;
      }
      if (windup > 0) {
        armR = -2.8 * windup;
        armL = -1.2 * windup;
        this.body.rotation.x = -0.3 * windup;
      }
      if (strike > 0) {
        armR = -2.8 + 4.2 * (1 - strike);
        this.body.rotation.x = 0.35 * strike;
      }
      if (lifeless) {
        armL = -0.3;
        armR = -0.4;
        armLz = 0.9;
        armRz = -0.9;
      }
      if (anim === ANIM.downed) {
        armL = -1.2 + Math.sin(t * 9) * 0.08;
        armR = -0.6;
      }
      if (this.shL) { this.shL.rotation.x = armL; this.shL.rotation.z = armLz; }
      if (this.shR) { this.shR.rotation.x = armR; this.shR.rotation.z = armRz; }
      if (moving) this.body.position.y += Math.abs(c) * 0.02;
      if (limp && moving) this.body.rotation.z = s * 0.08;
      if (this.neck) this.neck.rotation.x = anim === ANIM.dead ? 0.6 : windup > 0 ? -0.2 : 0;
    } else if (this.plan === 'quad') {
      const a = moving ? amp * 0.7 : 0;
      if (this.shL) this.shL.rotation.x = lifeless ? 0.9 : s * a;
      if (this.shR) this.shR.rotation.x = lifeless ? 0.9 : -s * a;
      if (this.hipL) this.hipL.rotation.x = lifeless ? -0.9 : -s * a;
      if (this.hipR) this.hipR.rotation.x = lifeless ? -0.9 : s * a;
      if (this.neck) {
        this.neck.rotation.x = windup > 0 ? 0.5 * windup : strike > 0 ? -0.4 * strike : anim === ANIM.work ? 0.6 : Math.sin(t * 1.3) * 0.05;
      }
      if (windup > 0) this.body.position.z = -0.08 * windup;
      else if (strike > 0) this.body.position.z = 0.12 * strike;
      else this.body.position.z = 0;
      if (moving) this.body.position.y += Math.abs(c) * 0.015;
      if (this.tail) this.tail.rotation.y = Math.sin(t * 3 + this.phase) * 0.3;
    } else {
      // serpent: segments follow a travelling sine; coil back on windup, lunge on strike
      const n = this.segs.length;
      const wave = moving ? 0.35 : 0.12;
      for (let i = 0; i < n; i++) {
        const seg = this.segs[i];
        seg.rotation.y = lifeless ? 0.25 : Math.sin(this.phase * Math.PI - i * 0.9) * wave;
      }
      if (this.segs[0]) {
        this.segs[0].rotation.x = windup > 0 ? -0.6 * windup : strike > 0 ? 0.3 * strike : 0;
        this.segs[0].position.z = windup > 0 ? -0.1 * windup : strike > 0 ? 0.15 * strike : 0;
      }
      for (const [i, w] of this.wings.entries()) {
        const flap = lifeless ? 0.2 : Math.sin(t * 9 + this.phase) * 0.6;
        w.rotation.z = (i === 0 ? 1 : -1) * flap;
      }
    }
  }
}

// ---------- builders ----------

const SKIN = '#c8946a';

export const JOB_BY_TINT: Record<string, string> = {
  'e6dcc4': 'shepherd', '7a3a5a': 'vinedresser', '6a4a2a': 'woodcutter', '3a6a8a': 'fisherman', 'c8a050': 'farmer', '8a2a2a': 'guard', 'b02a20': 'champion',
};

function human(tint: string, shape: string, seed: number): Rig {
  const r = new Rig();
  r.plan = 'biped';
  r.height = 0.82;
  r.strideLen = 0.3;
  const job = shape === 'champion' ? 'champion' : shape === 'guard' ? 'guard' : shape === 'guard-bare' ? 'guard-bare' : shape === 'shepherd' ? 'shepherd' : JOB_BY_TINT[tint.replace('#', '')] ?? 'farmer';
  const B = r.body;
  r.hipL = limb(B, [0.055, 0.38, 0], 0.37, 0.085, '#6a4a30');
  r.hipR = limb(B, [-0.055, 0.38, 0], 0.37, 0.085, '#6a4a30');
  mesh(r.hipL, 'box', [0.09, 0.03, 0.13], [0, -0.37, 0.02], '#4a3220');
  mesh(r.hipR, 'box', [0.09, 0.03, 0.13], [0, -0.37, 0.02], '#4a3220');
  const torso = mesh(B, 'taper', [0.24, 0.36, 0.15], [0, 0.55, 0], tint);
  mesh(B, 'box', [0.25, 0.03, 0.16], [0, 0.46, 0], '#5a3a20'); // belt
  mesh(B, 'taper', [0.26, 0.14, 0.17], [0, 0.34, 0], tint, [Math.PI, 0, 0]); // tunic skirt
  r.neck = joint(B, [0, 0.73, 0]);
  const head = mesh(r.neck, 'sphere', [0.13, 0.15, 0.14], [0, 0.07, 0.005], SKIN);
  const hair = job === 'guard' || job === 'guard-bare' || job === 'champion'
    ? mesh(r.neck, 'cone', [0.15, 0.08, 0.15], [0, 0.15, 0], job === 'champion' ? '#b08a3a' : '#8a6a3a')
    : mesh(r.neck, 'sphere', [0.14, 0.08, 0.15], [0, 0.12, -0.01], ['#3a2a1a', '#2a1a10', '#5a3a1a', '#d8ccb0'][seed % 4]);
  mesh(r.neck, 'box', [0.1, 0.05, 0.03], [0, 0.0, 0.06], '#3a2a1a'); // beard
  r.mark('head', head, hair);
  r.shL = limb(B, [0.15, 0.7, 0], 0.32, 0.065, tint);
  r.shR = limb(B, [-0.15, 0.7, 0], 0.32, 0.065, tint);
  mesh(r.shL, 'sphere', [0.06, 0.06, 0.06], [0, -0.33, 0], SKIN);
  mesh(r.shR, 'sphere', [0.06, 0.06, 0.06], [0, -0.33, 0], SKIN);
  const hand = joint(r.shR, [0, -0.33, 0]);
  switch (job) {
    case 'shepherd': mesh(hand, 'cyl', [0.022, 0.8, 0.022], [0, 0.1, 0.06], '#7a5a3a', [0.2, 0, 0]); break;
    case 'guard-bare': mesh(hand, 'box', [0.015, 0.02, 0.12], [0, -0.02, 0.07], '#b08a50'); break; // only a knife: his spear is thrown
    case 'guard': mesh(hand, 'cyl', [0.022, 1.0, 0.022], [0, 0.2, 0.05], '#6a4a2a'); mesh(hand, 'cone', [0.04, 0.1, 0.04], [0, 0.74, 0.05], '#c08a4a'); break;
    case 'woodcutter': mesh(hand, 'cyl', [0.02, 0.3, 0.02], [0, 0, 0.08], '#6a4a2a', [1.4, 0, 0]); mesh(hand, 'box', [0.02, 0.1, 0.07], [0, 0, 0.22], '#8a8070'); break;
    case 'farmer': case 'vinedresser': mesh(hand, 'box', [0.015, 0.02, 0.18], [0, -0.02, 0.1], '#9a8a6a'); break;
    case 'fisherman': mesh(hand, 'box', [0.16, 0.12, 0.02], [0, -0.08, 0.04], '#8a7a5a'); break;
    case 'champion': mesh(hand, 'box', [0.02, 0.05, 0.36], [0, 0, 0.18], '#c89a4a', undefined, 0.1); mesh(r.shL, 'cyl', [0.26, 0.03, 0.26], [0.06, -0.24, 0.06], '#a0602a', [0, 0, Math.PI / 2]); break;
  }
  r.mark('armL', r.shL);
  r.mark('armR', r.shR);
  r.mark('legL', r.hipL);
  r.mark('legR', r.hipR);
  r.mark('torso', torso);
  r.stump('armL', B, [0.15, 0.68, 0], 0.06);
  r.stump('armR', B, [-0.15, 0.68, 0], 0.06);
  r.stump('head', B, [0, 0.74, 0], 0.07);
  return r;
}

interface BipedOpts {
  tint: string;
  legLen: number; legW: number; legColor?: string;
  torso: [number, number, number]; torsoY: number;
  armLen: number; armW: number; shoulderX: number;
  head: [number, number, number]; headColor?: string;
  hunch?: number;
  digitigrade?: boolean;
}

function biped(o: BipedOpts): Rig {
  const r = new Rig();
  r.plan = 'biped';
  const B = r.body;
  const hipY = o.legLen;
  r.hipL = limb(B, [o.torso[0] * 0.28, hipY, 0], o.legLen, o.legW, o.legColor ?? o.tint);
  r.hipR = limb(B, [-o.torso[0] * 0.28, hipY, 0], o.legLen, o.legW, o.legColor ?? o.tint);
  if (o.digitigrade) {
    mesh(r.hipL, 'box', [o.legW * 0.8, o.legLen * 0.4, o.legW * 0.8], [0, -o.legLen * 0.75, -o.legW * 0.6], o.legColor ?? o.tint, [-0.5, 0, 0]);
    mesh(r.hipR, 'box', [o.legW * 0.8, o.legLen * 0.4, o.legW * 0.8], [0, -o.legLen * 0.75, -o.legW * 0.6], o.legColor ?? o.tint, [-0.5, 0, 0]);
  }
  const spine = joint(B, [0, hipY, 0]);
  spine.rotation.x = o.hunch ?? 0;
  const torso = mesh(spine, 'box', o.torso, [0, o.torsoY, 0], o.tint);
  const topY = o.torsoY + o.torso[1] / 2;
  r.neck = joint(spine, [0, topY, o.torso[2] * 0.1]);
  const head = mesh(r.neck, 'sphere', o.head, [0, o.head[1] / 2, o.head[2] * 0.15], o.headColor ?? o.tint);
  r.shL = limb(spine, [o.shoulderX, topY - 0.03, 0], o.armLen, o.armW, o.tint);
  r.shR = limb(spine, [-o.shoulderX, topY - 0.03, 0], o.armLen, o.armW, o.tint);
  r.height = hipY + topY + o.head[1];
  r.strideLen = o.legLen * 0.9;
  r.mark('head', head);
  r.mark('torso', torso);
  r.mark('armL', r.shL);
  r.mark('armR', r.shR);
  r.mark('legL', r.hipL);
  r.mark('legR', r.hipR);
  r.stump('armL', spine, [o.shoulderX, topY - 0.03, 0], o.armW);
  r.stump('armR', spine, [-o.shoulderX, topY - 0.03, 0], o.armW);
  r.stump('head', spine, [0, topY, 0], o.head[0] * 0.5);
  return r;
}

function quad(o: { tint: string; bodyL: number; bodyH: number; bodyW: number; legLen: number; legW: number; head: [number, number, number]; neckLen: number; low?: boolean; legColor?: string }): Rig {
  const r = new Rig();
  r.plan = 'quad';
  const B = r.body;
  const y = o.legLen + o.bodyH / 2;
  const torso = mesh(B, 'box', [o.bodyW, o.bodyH, o.bodyL], [0, y, 0], o.tint);
  const fx = o.bodyW * 0.38, fz = o.bodyL * 0.38;
  const lc = o.legColor ?? o.tint;
  r.shL = limb(B, [fx, o.legLen, fz], o.legLen, o.legW, lc);
  r.shR = limb(B, [-fx, o.legLen, fz], o.legLen, o.legW, lc);
  r.hipL = limb(B, [fx, o.legLen, -fz], o.legLen, o.legW, lc);
  r.hipR = limb(B, [-fx, o.legLen, -fz], o.legLen, o.legW, lc);
  r.neck = joint(B, [0, y + (o.low ? 0 : o.bodyH * 0.25), o.bodyL / 2]);
  const head = mesh(r.neck, 'box', o.head, [0, o.low ? 0 : o.head[1] * 0.2, o.neckLen + o.head[2] / 2], o.tint);
  r.tail = joint(B, [0, y, -o.bodyL / 2]);
  mesh(r.tail, 'cone', [o.bodyW * 0.4, o.bodyL * 0.7, o.bodyW * 0.3], [0, 0, -o.bodyL * 0.3], o.tint, [-Math.PI / 2, 0, 0]);
  r.height = y + o.bodyH / 2 + o.head[1];
  r.length = o.bodyL;
  r.strideLen = o.legLen * 1.2;
  r.mark('head', head);
  r.mark('torso', torso);
  r.mark('armL', r.shL);
  r.mark('armR', r.shR);
  r.mark('legL', r.hipL);
  r.mark('legR', r.hipR);
  return r;
}

function serpent(o: { tint: string; segs: number; radius: number; segLen: number; y: number; head: [number, number, number]; belly?: string }): Rig {
  const r = new Rig();
  r.plan = 'serpent';
  let parent: THREE.Object3D = r.body;
  const n = o.segs;
  // segments chain backwards from the head end (+z)
  const start = joint(r.body, [0, o.y, (n * o.segLen) / 2]);
  parent = start;
  for (let i = 0; i < n; i++) {
    const seg = joint(parent, [0, 0, i === 0 ? 0 : -o.segLen]);
    const k = 1 - i / (n + 2);
    mesh(seg, 'sphere', [o.radius * 2 * k, o.radius * 1.7 * k, o.segLen * 1.3], [0, 0, -o.segLen / 2], i % 2 ? o.tint : o.belly ?? o.tint);
    r.segs.push(seg);
    parent = seg;
  }
  r.neck = joint(r.segs[0], [0, 0, 0]);
  const head = mesh(r.neck, 'box', o.head, [0, o.radius * 0.2, o.head[2] / 2], o.tint);
  r.height = o.y + o.radius;
  r.length = n * o.segLen;
  r.strideLen = o.segLen * 2;
  r.mark('head', head);
  r.mark('torso', ...r.segs.slice(0, Math.ceil(n / 2)));
  r.mark('legL', ...r.segs.slice(Math.ceil(n / 2)));
  r.mark('legR', ...r.segs.slice(Math.ceil(n / 2)));
  return r;
}

const EYE = (p: THREE.Object3D, x: number, y: number, z: number, s = 0.03, color = '#fff2a0') => {
  mesh(p, 'sphere', [s, s, s], [x, y, z], color, undefined, 1);
  mesh(p, 'sphere', [s, s, s], [-x, y, z], color, undefined, 1);
};

function monster(arch: string, tint: string): Rig {
  switch (arch) {
    case 'nephil': {
      const r = biped({ tint, legLen: 0.4, legW: 0.15, legColor: '#5a4030', torso: [0.44, 0.38, 0.26], torsoY: 0.2, armLen: 0.42, armW: 0.12, shoulderX: 0.29, head: [0.2, 0.22, 0.2] });
      EYE(r.neck!, 0.05, 0.12, 0.09, 0.03, '#ffd060');
      mesh(r.neck!, 'box', [0.16, 0.08, 0.06], [0, 0.03, 0.08], '#3a2a1a'); // beard
      mesh(r.body, 'box', [0.46, 0.12, 0.28], [0, 0.42, 0], '#6a4a2a'); // kilt
      const club = joint(r.shR!, [0, -0.42, 0]);
      const c1 = mesh(club, 'cyl', [0.07, 0.5, 0.07], [0, 0.0, 0.2], '#4a3220', [Math.PI / 2, 0, 0]);
      const c2 = mesh(club, 'sphere', [0.17, 0.17, 0.2], [0, 0, 0.45], '#3a2a1a');
      r.mark('sig', c1, c2);
      return r;
    }
    case 'lilit': {
      const r = biped({ tint, legLen: 0.42, legW: 0.06, torso: [0.2, 0.34, 0.12], torsoY: 0.17, armLen: 0.5, armW: 0.05, shoulderX: 0.13, head: [0.17, 0.17, 0.14], hunch: 0.25, digitigrade: true });
      EYE(r.neck!, 0.04, 0.1, 0.07, 0.045, '#e8f080'); // owl eyes
      mesh(r.neck!, 'cone', [0.04, 0.06, 0.04], [0, 0.06, 0.09], '#c8b060', [Math.PI / 2, 0, 0]);
      mesh(r.body, 'taper', [0.3, 0.5, 0.2], [0, 0.42, -0.04], '#2a2834', [Math.PI, 0, 0]); // ragged robe
      const talL = mesh(r.shL!, 'cone', [0.06, 0.16, 0.06], [0, -0.56, 0.02], '#d8ccb0', [Math.PI, 0, 0]);
      const talR = mesh(r.shR!, 'cone', [0.06, 0.16, 0.06], [0, -0.56, 0.02], '#d8ccb0', [Math.PI, 0, 0]);
      r.mark('sig', talL, talR);
      return r;
    }
    case 'anak': {
      const r = biped({ tint, legLen: 0.32, legW: 0.11, torso: [0.36, 0.36, 0.22], torsoY: 0.18, armLen: 0.55, armW: 0.08, shoulderX: 0.22, head: [0.17, 0.18, 0.18], hunch: 0.6 });
      EYE(r.neck!, 0.04, 0.09, 0.08, 0.035, '#a0ffb0');
      mesh(r.neck!, 'box', [0.12, 0.05, 0.05], [0, 0.03, 0.09], '#3a1010'); // gaping mouth
      const hL = mesh(r.shL!, 'box', [0.14, 0.06, 0.16], [0, -0.58, 0.04], tint);
      const hR = mesh(r.shR!, 'box', [0.14, 0.06, 0.16], [0, -0.58, 0.04], tint);
      r.mark('sig', hL, hR);
      return r;
    }
    case 'seir': {
      const r = biped({ tint, legLen: 0.38, legW: 0.1, legColor: '#2a2018', torso: [0.32, 0.34, 0.22], torsoY: 0.17, armLen: 0.36, armW: 0.08, shoulderX: 0.2, head: [0.16, 0.2, 0.22], digitigrade: true });
      EYE(r.neck!, 0.05, 0.12, 0.1, 0.03, '#ff4020');
      mesh(r.neck!, 'box', [0.1, 0.1, 0.12], [0, 0.05, 0.14], tint); // muzzle
      const h1 = mesh(r.neck!, 'cone', [0.06, 0.3, 0.06], [0.07, 0.26, -0.04], '#d8ccb0', [-0.6, 0, -0.3]);
      const h2 = mesh(r.neck!, 'cone', [0.06, 0.3, 0.06], [-0.07, 0.26, -0.04], '#d8ccb0', [-0.6, 0, 0.3]);
      r.mark('sig', h1, h2);
      return r;
    }
    case 'reem': {
      const r = quad({ tint, bodyL: 0.62, bodyH: 0.32, bodyW: 0.32, legLen: 0.28, legW: 0.08, head: [0.18, 0.2, 0.26], neckLen: 0.02, legColor: '#2a1c14' });
      EYE(r.neck!, 0.07, 0.08, 0.2, 0.03, '#ff3020');
      const h1 = mesh(r.neck!, 'cone', [0.06, 0.5, 0.06], [0.12, 0.16, 0.18], '#e0d8c0', [1.1, 0, -0.5]);
      const h2 = mesh(r.neck!, 'cone', [0.06, 0.5, 0.06], [-0.12, 0.16, 0.18], '#e0d8c0', [1.1, 0, 0.5]);
      mesh(r.body, 'sphere', [0.3, 0.2, 0.26], [0, 0.66, 0.16], tint); // hump
      r.mark('sig', h1, h2);
      return r;
    }
    case 'rahab': {
      const r = quad({ tint, bodyL: 0.9, bodyH: 0.2, bodyW: 0.34, legLen: 0.12, legW: 0.08, head: [0.24, 0.12, 0.4], neckLen: 0.02, low: true });
      EYE(r.neck!, 0.08, 0.08, 0.1, 0.035, '#f0e040');
      const jaw = mesh(r.neck!, 'box', [0.22, 0.05, 0.36], [0, -0.06, 0.22], '#3a4a30');
      for (let i = 0; i < 4; i++) mesh(r.body, 'cone', [0.06, 0.1, 0.06], [0, 0.34, 0.3 - i * 0.2], '#2e4a30');
      r.mark('sig', jaw);
      return r;
    }
    case 'saraph': {
      const r = serpent({ tint, segs: 6, radius: 0.1, segLen: 0.13, y: 0.55, head: [0.16, 0.12, 0.2], belly: '#f0b040' });
      r.hover = 0.25;
      EYE(r.neck!, 0.05, 0.06, 0.14, 0.035, '#fff2a0');
      const wl = joint(r.segs[1], [0.08, 0.06, -0.05]);
      const wr = joint(r.segs[1], [-0.08, 0.06, -0.05]);
      const m1 = mesh(wl, 'box', [0.6, 0.02, 0.28], [0.3, 0, 0], '#f08a30', undefined, 0.45);
      const m2 = mesh(wr, 'box', [0.6, 0.02, 0.28], [-0.3, 0, 0], '#f08a30', undefined, 0.45);
      r.wings.push(wl, wr);
      r.mark('sig', m1, m2);
      r.mark('armL', m1);
      r.mark('armR', m2);
      return r;
    }
    case 'ziz': {
      // a great bird of prey: a short body, a huge wingspan, a hooked beak, talons
      const r = serpent({ tint, segs: 3, radius: 0.15, segLen: 0.16, y: 0.5, head: [0.14, 0.14, 0.18], belly: '#d8ccb0' });
      r.hover = 0.2;
      EYE(r.neck!, 0.05, 0.07, 0.12, 0.03, '#ffd040');
      mesh(r.neck!, 'cone', [0.06, 0.14, 0.06], [0, 0.0, 0.24], '#e0b040', [Math.PI / 2 + 0.3, 0, 0]);
      const wl = joint(r.segs[0], [0.1, 0.06, -0.08]);
      const wr = joint(r.segs[0], [-0.1, 0.06, -0.08]);
      const m1 = mesh(wl, 'box', [0.95, 0.025, 0.34], [0.47, 0, 0], tint);
      const m2 = mesh(wr, 'box', [0.95, 0.025, 0.34], [-0.47, 0, 0], tint);
      const t1 = mesh(wl, 'box', [0.3, 0.02, 0.2], [0.9, 0, -0.08], '#3a3028');
      const t2 = mesh(wr, 'box', [0.3, 0.02, 0.2], [-0.9, 0, -0.08], '#3a3028');
      mesh(r.segs[2], 'box', [0.3, 0.02, 0.26], [0, 0, -0.2], tint); // tail fan
      mesh(r.segs[1], 'cone', [0.05, 0.16, 0.05], [0.07, -0.18, 0], '#3a3020', [Math.PI, 0, 0]); // talons
      mesh(r.segs[1], 'cone', [0.05, 0.16, 0.05], [-0.07, -0.18, 0], '#3a3020', [Math.PI, 0, 0]);
      r.wings.push(wl, wr);
      r.mark('sig', m1, m2, t1, t2);
      r.mark('armL', m1, t1);
      r.mark('armR', m2, t2);
      return r;
    }
    case 'tannin':
    default: {
      const r = serpent({ tint, segs: 9, radius: 0.12, segLen: 0.14, y: 0.12, head: [0.2, 0.14, 0.24], belly: '#5a7a4a' });
      EYE(r.neck!, 0.06, 0.08, 0.16, 0.03, '#f0e040');
      r.neck!.position.y = 0.15;
      r.mark('sig', ...r.segs.slice(2, 6));
      return r;
    }
  }
}

function animal(species: string, tint: string): Rig {
  if (species === 'ox') {
    const r = quad({ tint, bodyL: 0.5, bodyH: 0.26, bodyW: 0.26, legLen: 0.24, legW: 0.06, head: [0.14, 0.15, 0.18], neckLen: 0.02 });
    mesh(r.neck!, 'cone', [0.03, 0.14, 0.03], [0.08, 0.15, 0.1], '#e0d8c0', [0, 0, -1]);
    mesh(r.neck!, 'cone', [0.03, 0.14, 0.03], [-0.08, 0.15, 0.1], '#e0d8c0', [0, 0, 1]);
    return r;
  }
  if (species === 'lamb') {
    const r = quad({ tint: '#f0ece0', bodyL: 0.22, bodyH: 0.14, bodyW: 0.14, legLen: 0.1, legW: 0.035, head: [0.08, 0.08, 0.1], neckLen: 0.01, legColor: '#3a3028' });
    return r;
  }
  const r = quad({ tint, bodyL: 0.32, bodyH: 0.16, bodyW: 0.15, legLen: 0.18, legW: 0.04, head: [0.08, 0.1, 0.12], neckLen: 0.02, legColor: '#3a3028' });
  mesh(r.neck!, 'cone', [0.025, 0.12, 0.025], [0.03, 0.14, 0.02], '#d8ccb0', [-0.5, 0, 0]);
  mesh(r.neck!, 'cone', [0.025, 0.12, 0.025], [-0.03, 0.14, 0.02], '#d8ccb0', [-0.5, 0, 0]);
  return r;
}

const MONSTERS = new Set(['nephil', 'saraph', 'seir', 'lilit', 'rahab', 'anak', 'reem', 'tannin', 'ziz']);
const HUMANS = new Set(['human', 'shepherd', 'guard', 'guard-bare', 'champion']);
const ANIMALS = new Set(['goat', 'ox', 'lamb']);

export function hasRig(shape: string) {
  return MONSTERS.has(shape) || HUMANS.has(shape) || ANIMALS.has(shape);
}

/** Monster palettes were tuned for a top-down view; lift them so they read at eye level. */
function lift(hex: string): string {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h, Math.min(1, hsl.s * 1.1), Math.max(hsl.l, 0.3 + hsl.l * 0.4));
  return '#' + c.getHexString();
}

export function buildRig(shape: string, tint: string, seed = 0): Rig {
  const r = MONSTERS.has(shape) ? monster(shape, lift(tint)) : ANIMALS.has(shape) ? animal(shape, tint) : human(tint, shape, seed);
  r.phase = (seed * 0.618) % 10;
  return r;
}

/** Which body plan the sim's aim-zone rules use for an archetype (spec §5.2). */
export function planOf(shape: string): Plan {
  if (shape === 'reem' || shape === 'rahab') return 'quad';
  if (shape === 'saraph' || shape === 'tannin' || shape === 'ziz') return 'serpent';
  return 'biped';
}
