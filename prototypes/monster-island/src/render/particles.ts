import * as THREE from 'three';
import type { EmitterDef } from '../sim/types';

const POOL = 1000; // per blend mode (2,000 total)

class Pool {
  geo = new THREE.BufferGeometry();
  pos = new Float32Array(POOL * 3);
  col = new Float32Array(POOL * 3);
  size = new Float32Array(POOL);
  alpha = new Float32Array(POOL);
  vel = new Float32Array(POOL * 3);
  life = new Float32Array(POOL);
  maxLife = new Float32Array(POOL);
  grav = new Float32Array(POOL);
  baseSize = new Float32Array(POOL);
  next = 0;
  points: THREE.Points;
  constructor(additive: boolean) {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: `attribute float size; attribute float alpha; attribute vec3 color; varying vec3 vC; varying float vA;
        void main(){ vC=color; vA=alpha; vec4 mv=modelViewMatrix*vec4(position,1.0); gl_PointSize=size*(900.0/-mv.z); gl_Position=projectionMatrix*mv; }`,
      fragmentShader: `varying vec3 vC; varying float vA;
        void main(){ vec2 d=gl_PointCoord-0.5; float r=dot(d,d); if(r>0.25) discard; gl_FragColor=vec4(vC, vA*(1.0-r*3.0)); }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
  }
  spawn(x: number, y: number, z: number, d: EmitterDef, c: THREE.Color, rand: () => number) {
    const i = this.next;
    this.next = (this.next + 1) % POOL;
    this.pos.set([x, y, z], i * 3);
    const s = d.spread;
    const th = rand() * Math.PI * 2;
    const up = 1 - s * rand();
    const horiz = Math.sqrt(Math.max(0, 1 - up * up));
    const sp = d.speed * (0.6 + 0.4 * rand());
    this.vel.set([Math.cos(th) * horiz * sp, up * sp, Math.sin(th) * horiz * sp], i * 3);
    this.col.set([c.r, c.g, c.b], i * 3);
    this.life[i] = this.maxLife[i] = d.life * (0.7 + 0.3 * rand());
    this.grav[i] = d.gravity;
    this.baseSize[i] = d.size;
  }
  update(dt: number) {
    for (let i = 0; i < POOL; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        this.size[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const k = i * 3;
      this.vel[k + 1] -= this.grav[i] * dt;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      const f = Math.max(0, this.life[i] / this.maxLife[i]);
      this.alpha[i] = Math.min(1, f * 2);
      this.size[i] = this.baseSize[i] * (0.6 + 0.4 * f);
    }
    for (const a of ['position', 'color', 'size', 'alpha']) this.geo.getAttribute(a).needsUpdate = true;
  }
}

export class Particles {
  group = new THREE.Group();
  defs = new Map<string, EmitterDef>();
  private normal = new Pool(false);
  private glow = new Pool(true);
  /** entity id → emitter ids */
  attached = new Map<number, Set<string>>();
  private acc = new Map<string, number>();
  private seed = 1;
  private c1 = new THREE.Color();
  private c2 = new THREE.Color();
  weather: 'none' | 'rain' | 'snow' = 'none';

  constructor() {
    this.group.add(this.normal.points, this.glow.points);
  }

  private rand = () => {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  };

  private emit(d: EmitterDef, x: number, y: number, z: number) {
    this.c1.set(d.color);
    if (d.color2) this.c1.lerp(this.c2.set(d.color2), this.rand());
    (d.glow ? this.glow : this.normal).spawn(x, y, z, d, this.c1, this.rand);
  }

  burst(id: string, x: number, y: number, z: number) {
    const d = this.defs.get(id);
    if (!d) return;
    const n = Math.max(6, Math.min(40, Math.round(d.rate * 0.6)));
    for (let i = 0; i < n; i++) this.emit(d, x, y, z);
  }

  setAttached(list: [number, string[]][]) {
    this.attached = new Map(list.map(([id, l]) => [id, new Set(l)]));
  }

  attach(ent: number, emitter: string) {
    let s = this.attached.get(ent);
    if (!s) this.attached.set(ent, (s = new Set()));
    s.add(emitter);
  }

  detach(ent: number, emitter: string) {
    this.attached.get(ent)?.delete(emitter);
  }

  update(dt: number, positionOf: (id: number) => THREE.Vector3 | null, heightOf: (id: number) => number, focus: THREE.Vector3) {
    for (const [ent, set] of this.attached) {
      const p = positionOf(ent);
      if (!p) continue;
      const h = heightOf(ent);
      for (const em of set) {
        const d = this.defs.get(em);
        if (!d) continue;
        const key = `${ent}:${em}`;
        let a = (this.acc.get(key) ?? this.rand()) + d.rate * dt;
        while (a >= 1) {
          a -= 1;
          this.emit(d, p.x + (this.rand() - 0.5) * 0.3, p.y + h * 0.8, p.z + (this.rand() - 0.5) * 0.3);
        }
        this.acc.set(key, a);
      }
    }
    if (this.weather !== 'none') {
      const rain = this.weather === 'rain';
      const d: EmitterDef = rain
        ? { color: '#a8c4e8', size: 0.07, rate: 0, life: 1.1, speed: 0, spread: 0, gravity: 18 }
        : { color: '#ffffff', size: 0.13, rate: 0, life: 4, speed: 0, spread: 0, gravity: 0.6 };
      const n = Math.round((rain ? 160 : 50) * dt * 10) / 10;
      for (let i = 0; i < n; i++) {
        this.emit(d, focus.x + (this.rand() - 0.5) * 50, 14 + this.rand() * 4, focus.z + (this.rand() - 0.5) * 50);
      }
    }
    this.normal.update(dt);
    this.glow.update(dt);
  }
}
