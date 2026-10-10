import * as THREE from 'three';
import { Terrain } from './terrain';
import { ShapeRenderer, type EntityVis } from './shapes';
import { Particles } from './particles';
import { Sprites } from './sprites';
import { Sky } from './sky';
import { ENT_STRIDE, F_BOUND, F_CHAMPION, F_DOWNED, F_DRAGGED, F_TELEGRAPH, type FramePayload, type SimToMain } from '../protocol';
import type { ShapeDef } from '../sim/types';
import { TICKS_PER_SECOND } from '../sim/clock';

type FullState = Extract<SimToMain, { type: 'fullState' }>;
type Defs = Extract<SimToMain, { type: 'defs' }>;

const POLAR = (25 * Math.PI) / 180;

class RingPool {
  group = new THREE.Group();
  private pool: THREE.Mesh[] = [];
  private used = 0;
  constructor(private color: string, private inner: number, private opacity: number) {}
  begin() {
    this.used = 0;
  }
  place(x: number, y: number, z: number, r: number, alpha = 1) {
    let m = this.pool[this.used];
    if (!m) {
      m = new THREE.Mesh(new THREE.RingGeometry(this.inner, 1, 40), new THREE.MeshBasicMaterial({ color: this.color, transparent: true, opacity: this.opacity, depthWrite: false, side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2;
      m.renderOrder = 2;
      this.pool.push(m);
      this.group.add(m);
    }
    this.used++;
    m.visible = true;
    m.position.set(x, y + 0.04, z);
    m.scale.setScalar(r);
    (m.material as THREE.MeshBasicMaterial).opacity = this.opacity * alpha;
  }
  end() {
    for (let i = this.used; i < this.pool.length; i++) this.pool[i].visible = false;
  }
}

export class Renderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  terrain = new Terrain();
  shapes = new ShapeRenderer();
  particles = new Particles();
  sprites = new Sprites();
  sky: Sky;
  target = new THREE.Vector3(64, 0, 64);
  dist = 26;
  mapMode = false;
  /** camera follows this entity (the champion) unless panning is allowed and the user dragged */
  followId: number | null = null;
  panOffset = new THREE.Vector3();
  hour = 12;
  light = 1;
  /** entity the champion is attacking (marker) */
  targetId: number | null = null;
  selectedId: number | null = null;
  private tap: { x: number; z: number; t: number } | null = null;

  private lastFrameAt = 0;
  private frameInterval = 100;
  private clock = new THREE.Clock();
  private raycaster = new THREE.Raycaster();
  private telegraphs = new RingPool('#ff2a1a', 0.86, 0.75);
  private markers = new RingPool('#ffd84a', 0.8, 0.9);
  private champRing = new RingPool('#fff0a0', 0.78, 0.7);
  private ropes = new RingPool('#c8a060', 0.55, 0.95);
  private rope = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: '#d8b070' }));
  private fly: { from: THREE.Vector3; to: THREE.Vector3; fromDist: number; toDist: number; t: number; dur: number } | null = null;
  paused = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: devicePixelRatio < 2 });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.5, 700);
    this.sky = new Sky(this.scene);
    this.scene.add(this.terrain.group, this.shapes.group, this.particles.group, this.sprites.group, this.telegraphs.group, this.markers.group, this.champRing.group, this.ropes.group, this.rope);
    addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const w = this.renderer.domElement.clientWidth || innerWidth, h = this.renderer.domElement.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  onDefs(d: Defs) {
    this.terrain.setDefs(d.tiles);
    this.shapes.setDefs(d.shapeIndex, new Map<string, ShapeDef>(d.shapes));
    this.particles.defs = new Map(d.emitters);
  }

  onFullState(s: FullState) {
    this.terrain.load(s.tiles, s.elev, s.explored);
    this.shapes.applyFrame(s.ents, ENT_STRIDE, true);
    this.particles.setAttached(s.attached);
    this.sky.atmosphere = { ...s.atmosphere };
    this.particles.weather = s.atmosphere.weather ?? 'none';
    this.lastFrameAt = performance.now();
  }

  onFrame(f: FramePayload) {
    this.frameInterval = 1000 / TICKS_PER_SECOND;
    this.lastFrameAt = performance.now();
    if (f.tiles.length) this.terrain.applyChanges(f.tiles);
    if (f.explored.length) this.terrain.fog.mark(f.explored);
    this.shapes.applyFrame(f.ents, ENT_STRIDE, false);
    for (const op of f.emitterOps) {
      if (op.op === 'attach') this.particles.attach(op.ent, op.emitter);
      else if (op.op === 'detach') this.particles.detach(op.ent, op.emitter);
      else this.particles.burst(op.emitter, op.x, op.y, op.z);
    }
    const t = this.clock.elapsedTime;
    for (const e of f.emotes) this.sprites.add(e.ent, e.text, e.seconds, e.speech, t);
    if (f.atmosphere) {
      this.sky.atmosphere = { ...f.atmosphere };
      this.particles.weather = f.atmosphere.weather ?? 'none';
    }
  }

  setReveal(on: boolean) {
    this.terrain.fog.reveal.value = on ? 1 : 0;
  }

  zoom(factor: number) {
    if (this.mapMode) return;
    this.dist = Math.min(64, Math.max(12, this.dist * factor));
  }

  flyTo(x: number, z: number, dist = 26, dur = 2.2) {
    this.fly = { from: this.target.clone(), to: new THREE.Vector3(x, 0, z), fromDist: this.dist, toDist: dist, t: 0, dur };
  }

  markTap(x: number, z: number) {
    this.tap = { x, z, t: this.clock.elapsedTime };
  }

  /** World point on the terrain under a screen point. */
  groundAt(clientX: number, clientY: number): { x: number; z: number } | null {
    this.setRay(clientX, clientY);
    const hits = this.raycaster.intersectObjects(this.terrain.group.children.filter((c) => !(c instanceof THREE.InstancedMesh)), false);
    const p = hits[0]?.point;
    if (p) return { x: p.x, z: p.z };
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.2);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(plane, out) ? { x: out.x, z: out.z } : null;
  }

  private setRay(clientX: number, clientY: number) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const p = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(p, this.camera);
  }

  /** Entity under a tap, generously: direct mesh hit, else the nearest entity within `radius` tiles of the ground point. */
  pickAt(clientX: number, clientY: number, accept: (v: EntityVis) => boolean, radius = 0.9): number | null {
    this.setRay(clientX, clientY);
    const direct = this.shapes.pick(this.raycaster);
    if (direct !== null) {
      const v = this.shapes.ents.get(direct);
      if (v && accept(v)) return direct;
    }
    const g = this.groundAt(clientX, clientY);
    if (!g) return null;
    let best: number | null = null, bd = radius;
    for (const v of this.shapes.ents.values()) {
      if (!accept(v)) continue;
      const d = Math.hypot(v.x - g.x, v.z - g.z) - 0.25 * v.scale;
      if (d < bd) { bd = d; best = v.id; }
    }
    return best;
  }

  render() {
    const dt = Math.min(0.1, this.clock.getDelta());
    const t = this.clock.elapsedTime;
    const alpha = this.paused ? 1 : Math.min(1, (performance.now() - this.lastFrameAt) / this.frameInterval);
    // camera
    if (this.fly) {
      const f = this.fly;
      f.t = Math.min(1, f.t + dt / f.dur);
      const e = f.t < 0.5 ? 2 * f.t * f.t : 1 - (-2 * f.t + 2) ** 2 / 2;
      this.target.lerpVectors(f.from, f.to, e);
      this.dist = f.fromDist + (f.toDist - f.fromDist) * e;
      if (f.t >= 1) {
        this.fly = null;
        this.panOffset.set(0, 0, 0);
        this.followHold = t + 3;
      }
    } else if (this.mapMode) {
      this.target.lerp(new THREE.Vector3(64, 0, 66), Math.min(1, dt * 4));
    } else if (this.followId !== null && t > this.followHold) {
      const p = this.shapes.positionOf(this.followId);
      if (p) {
        const goal = new THREE.Vector3(p.x, 0, p.z).add(this.panOffset);
        if (goal.distanceTo(this.target) > 25) this.target.copy(goal);
        else this.target.lerp(goal, Math.min(1, dt * 5));
      }
    }
    const d = this.mapMode ? 150 : this.dist;
    this.camera.position.set(this.target.x, this.target.y + d * Math.cos(POLAR), this.target.z + d * Math.sin(POLAR));
    this.camera.lookAt(this.target);

    this.sky.update(this.hour, this.light, this.target);
    this.terrain.update(t);
    this.shapes.update(alpha, t, this.sky.night);
    const pos = (id: number) => this.shapes.positionOf(id);
    const h = (id: number) => this.shapes.heightOf(id);
    this.particles.update(this.paused ? 0 : dt, pos, h, this.target);
    this.sprites.update(t, pos, h);

    // rings: telegraphs (the real hit radius), downed markers, target marker, champion, tap
    this.telegraphs.begin();
    this.markers.begin();
    this.champRing.begin();
    this.ropes.begin();
    let champPos: THREE.Vector3 | null = null, dragPos: THREE.Vector3 | null = null;
    for (const v of this.shapes.ents.values()) {
      const gy = v.py + (v.y - v.py) * alpha;
      const gx = v.px + (v.x - v.px) * alpha, gz = v.pz + (v.z - v.pz) * alpha;
      if (v.flags & F_TELEGRAPH && v.ring > 0) this.telegraphs.place(gx, gy, gz, v.ring, 0.6 + 0.4 * Math.sin(t * 30));
      if (v.flags & F_DOWNED && !(v.flags & F_CHAMPION)) this.markers.place(gx, gy, gz, 0.5 + 0.2 * v.scale + Math.sin(t * 5) * 0.08, 0.8);
      if (v.flags & F_CHAMPION) {
        this.champRing.place(gx, gy, gz, 0.42, 0.8);
        champPos = new THREE.Vector3(gx, gy + 0.4, gz);
      }
      if (v.flags & F_BOUND) this.ropes.place(gx, gy, gz, 0.3 + 0.25 * v.scale, 1);
      if (v.flags & F_DRAGGED) dragPos = new THREE.Vector3(gx, gy + 0.25, gz);
      if (v.id === this.targetId || v.id === this.selectedId) this.markers.place(gx, gy, gz, 0.35 + 0.3 * v.scale, 1);
    }
    if (this.tap && t - this.tap.t < 0.6) {
      const k = (t - this.tap.t) / 0.6;
      const tx = Math.floor(this.tap.x), tz = Math.floor(this.tap.z);
      this.champRing.place(this.tap.x, this.terrain.height(tx, tz), this.tap.z, 0.2 + k * 0.4, 1 - k);
    }
    this.telegraphs.end();
    this.markers.end();
    this.champRing.end();
    this.ropes.end();
    this.rope.visible = !!(champPos && dragPos);
    if (champPos && dragPos) {
      this.rope.geometry.setFromPoints([champPos, dragPos]);
    }
    this.renderer.render(this.scene, this.camera);
  }

  private followHold = 0;
}
