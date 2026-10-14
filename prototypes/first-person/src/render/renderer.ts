// First-person renderer (spec §7): camera at the champion's eye, terrain, static structures, creature rigs,
// particles, telegraph rings, the drag rope, a fixed set of 4 point lights (F33), and the view model on top.
import * as THREE from 'three';
import { Terrain } from './terrain';
import { Structures } from './structures';
import { Entities, type ChampPose } from './entities';
import { Particles, particleUniforms } from './particles';
import { Sprites } from './sprites';
import { Sky, clockLight } from './sky';
import { ViewModel } from './viewmodel';
import { F_DOWNED, F_TELEGRAPH, F_DRAGGED, type FramePayload, type SimToMain } from '../protocol';
import type { ShapeDef } from '../sim/types';
import type { IslandLayout } from '../sim/island-gen';
import { M } from '../sim/ground';
import { BODY, SHAPE_M } from '../sim/body';

type FullState = Extract<SimToMain, { type: 'fullState' }>;
type Defs = Extract<SimToMain, { type: 'defs' }>;

export interface CamPose { x: number; y: number; z: number; yaw: number; pitch: number }

class RingPool {
  group = new THREE.Group();
  private pool: THREE.Mesh[] = [];
  private used = 0;
  constructor(private color: string, private inner: number, private opacity: number) {}
  begin() { this.used = 0; }
  place(x: number, y: number, z: number, r: number, alpha = 1) {
    let m = this.pool[this.used];
    if (!m) {
      m = new THREE.Mesh(new THREE.RingGeometry(this.inner, 1, 48), new THREE.MeshBasicMaterial({ color: this.color, transparent: true, opacity: this.opacity, depthWrite: false, side: THREE.DoubleSide, fog: false }));
      m.rotation.x = -Math.PI / 2;
      m.renderOrder = 2;
      this.pool.push(m);
      this.group.add(m);
    }
    this.used++;
    m.visible = true;
    m.position.set(x, y + 0.06, z);
    m.scale.setScalar(Math.max(0.01, r));
    (m.material as THREE.MeshBasicMaterial).opacity = this.opacity * alpha;
  }
  end() { for (let i = this.used; i < this.pool.length; i++) this.pool[i].visible = false; }
}

export class Renderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(75, 1, 0.2, 1500);
  terrain = new Terrain();
  structures = new Structures();
  ents = new Entities();
  particles = new Particles();
  sprites = new Sprites();
  sky: Sky;
  view = new ViewModel();
  layout: IslandLayout | null = null;
  hour = 12;
  light = 1;
  /** dev: draw the sky (and its light) at this hour instead of the sim's, by the clock's light alone */
  skyHour: number | null = null;
  private clock = new THREE.Clock();
  private rings = new RingPool('#ff2a1a', 0.86, 0.95);
  private ringFill = new RingPool('#ff2a1a', 0.0, 0.28);
  private downedRings = new RingPool('#ffd84a', 0.82, 0.7);
  private rope: THREE.Line;
  private torch = new THREE.PointLight('#ffb060', 0, 22, 1.6);
  private fires: THREE.PointLight[] = [];
  private dir = new THREE.Vector3();
  eye = new THREE.Vector3();
  t = 0;
  private fireAcc = 0;
  viewAllowed = true;
  /** the game is paused: the clock stops, so the picture holds still (bodies, particles, flicker, the arm) */
  frozen = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(1.5, devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.camera.rotation.order = 'YXZ';
    this.sky = new Sky(this.scene);
    const ropeGeo = new THREE.BufferGeometry().setFromPoints(new Array(12).fill(0).map(() => new THREE.Vector3()));
    this.rope = new THREE.Line(ropeGeo, new THREE.LineBasicMaterial({ color: '#c8a060' }));
    this.rope.frustumCulled = false;
    this.scene.add(this.terrain.group, this.structures.group, this.ents.group, this.particles.group, this.sprites.group, this.rings.group, this.ringFill.group, this.downedRings.group, this.rope, this.torch);
    // exactly four point lights, always present (F33): torch + three fires
    for (let i = 0; i < 3; i++) {
      const l = new THREE.PointLight('#ff9040', 0, 26, 1.8);
      this.fires.push(l);
      this.scene.add(l);
    }
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const w = this.renderer.domElement.clientWidth || innerWidth, h = this.renderer.domElement.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.view.setAspect(w / h);
    this.updateParticleScale();
  }

  setFov(fov: number) {
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
    this.updateParticleScale();
  }

  private updateParticleScale() {
    const h = this.renderer.domElement.height || innerHeight;
    particleUniforms.uScale.value = h / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
  }

  onDefs(d: Defs) {
    this.terrain.setDefs(d.tiles);
    this.ents.setDefs(d.shapeIndex, new Map<string, ShapeDef>(d.shapes));
    this.particles.defs = new Map(d.emitters);
  }

  onFullState(s: FullState) {
    this.layout = s.layout;
    this.terrain.load(s.tiles, s.elev, s.terrain);
    this.structures.build(this.terrain, s.layout);
    this.ents.apply(s.ents, s.tick, true);
    this.particles.setAttached(s.attached);
    this.sky.atmosphere = { ...s.atmosphere };
    this.particles.weather = s.atmosphere.weather ?? 'none';
    const fires = this.structures.fires;
    for (let i = 0; i < this.fires.length; i++) {
      const f = fires[i];
      if (f) this.fires[i].position.copy(f.pos).add(new THREE.Vector3(0, 0.8, 0));
    }
  }

  onFrame(f: FramePayload) {
    if (f.tiles.length) {
      this.terrain.updateTiles(f.tiles);
      if (f.tiles.some(([, t]) => t === 'wall' || t === 'house' || t === 'gate') && this.layout) this.structures.build(this.terrain, this.layout);
    }
    this.ents.apply(f.ents, f.tick, false);
    for (const op of f.emitterOps) {
      if (op.op === 'attach') this.particles.attach(op.ent, op.emitter);
      else if (op.op === 'detach') this.particles.detach(op.ent, op.emitter);
      else this.particles.burst(op.emitter, op.x * M, op.y, op.z * M);
    }
    for (const e of f.emotes) {
      const p = this.ents.positionOf(e.ent);
      if (p && p.distanceTo(this.eye) < 40) this.sprites.add(e.ent, e.text, e.seconds, e.speech, this.t);
    }
    if (f.atmosphere) {
      this.sky.atmosphere = { ...f.atmosphere };
      this.particles.weather = f.atmosphere.weather ?? 'none';
    }
  }

  private kickP = 0;
  private kickR = 0;
  /** A short camera jolt (rad) that springs back: impact on a hit, a shove when hurt. */
  kick(pitch: number, roll: number) {
    this.kickP += pitch;
    this.kickR += roll;
  }

  /** The look ray from the camera center. */
  lookRay(): { eye: THREE.Vector3; dir: THREE.Vector3 } {
    this.camera.getWorldDirection(this.dir);
    return { eye: this.camera.position, dir: this.dir };
  }

  private frameDt: { dt: number; t: number } | null = null;

  /** Advance the clock and animate the entities. main.ts calls this before the controller, so a champion riding a
   *  monster is placed on this frame's pose (docs/climbing-phase3-plan.md, Part B); otherwise render() does. */
  animate(champId: number | null, posedChamp: boolean) {
    const delta = this.clock.getDelta();
    const dt = this.frozen ? 0 : Math.min(0.1, delta);
    const t = (this.t += dt);
    this.ents.update(dt, t, this.eye, champId, posedChamp);
    this.frameDt = { dt, t };
  }

  render(cam: CamPose, o: { champId: number | null; sightTiles: number; torch: boolean; fold: number; lairsHome: Set<number>; viewModel: boolean; moveSpeed: number; sprinting: boolean; blocking: boolean; dragging: boolean; roll?: number; champPose?: ChampPose | null }) {
    if (!this.frameDt) this.animate(o.champId, !!o.champPose);
    const { dt, t } = this.frameDt!;
    this.frameDt = null;
    this.camera.position.set(cam.x, cam.y, cam.z);
    this.kickP *= Math.exp(-dt * 18);
    this.kickR *= Math.exp(-dt * 18);
    this.camera.rotation.set(cam.pitch + this.kickP, cam.yaw + Math.PI, (o.roll ?? 0) + this.kickR);
    this.camera.updateMatrixWorld();
    this.eye.copy(this.camera.position);

    this.sky.sightM = o.sightTiles * M;
    const light = this.skyHour === null ? this.light : clockLight(this.skyHour);
    this.sky.update(this.skyHour ?? this.hour, light, this.eye);
    const fog = this.scene.fog as THREE.Fog;
    particleUniforms.fogColor.value.copy(fog.color);
    particleUniforms.fogNear.value = fog.near;
    particleUniforms.fogFar.value = fog.far;
    this.terrain.update(dt, t);
    this.structures.update(t, this.sky.night, o.fold, o.lairsHome);
    if (o.champPose) this.ents.poseChamp(dt, t, this.eye, o.champId, o.champPose);
    const pos = (id: number) => this.ents.positionOf(id);
    const h = (id: number) => this.ents.heightOf(id);
    this.particles.update(dt, pos, h, this.eye);
    this.sprites.update(t, pos, h);

    // lights: torch on the camera; fires flicker, brighter at night
    const night = this.sky.night;
    const cp = o.champPose;
    if (cp) this.torch.position.set(cp.x - Math.cos(cam.yaw) * 0.4, cp.y + 1.7, cp.z + Math.sin(cam.yaw) * 0.4);
    else this.torch.position.copy(this.eye).add(new THREE.Vector3(Math.sin(cam.yaw) * 0.5 - Math.cos(cam.yaw) * 0.3, -0.25, Math.cos(cam.yaw) * 0.5 + Math.sin(cam.yaw) * 0.3));
    this.torch.intensity = o.torch ? (14 + Math.sin(t * 23) * 1.2 + Math.sin(t * 37) * 0.8) * (0.4 + 0.6 * night) : 0;
    this.fireAcc += dt;
    if (this.fireAcc > 0.12) {
      this.fireAcc = 0;
      for (const f of this.structures.fires) {
        if (f.pos.distanceTo(this.eye) < 120) {
          this.particles.burstN('fire', f.pos.x, f.pos.y - 0.4, f.pos.z, 3);
          if (Math.random() < 0.3) this.particles.burstN('smoke', f.pos.x, f.pos.y + 0.6, f.pos.z, 1);
        }
      }
    }
    for (const [i, l] of this.fires.entries()) {
      l.intensity = this.structures.fires[i] ? (10 + Math.sin(t * 13 + i) * 1.5) * (0.25 + 0.75 * night) : 0;
    }

    // telegraph rings at the hit radius around the front point; the fill completes 0.2 s early (F7)
    this.rings.begin();
    this.ringFill.begin();
    this.downedRings.begin();
    let dragPos: THREE.Vector3 | null = null;
    this.ents.each((v) => {
      if (!v.root.visible) return;
      if (v.flags & F_TELEGRAPH && v.ring > 0) {
        const b = BODY[v.shape];
        const half = b ? b.half * SHAPE_M * v.scale : 0;
        const fx = v.pos.x + Math.sin(v.yaw) * half, fz = v.pos.z + Math.cos(v.yaw) * half;
        const gy = this.terrain.y(fx / M, fz / M);
        const prog = Math.min(1, Math.max(0, v.windup) + (performance.now() - v.windupAt) / 800 + 0.25);
        this.rings.place(fx, gy, fz, v.ring, 0.75 + 0.25 * Math.sin(t * 30));
        this.ringFill.place(fx, gy, fz, v.ring * prog, 0.5 + 0.5 * prog);
      }
      if (v.flags & F_DOWNED) this.downedRings.place(v.pos.x, v.pos.y, v.pos.z, 1 + 0.4 * v.scale + Math.sin(t * 5) * 0.12, 0.8);
      if (v.flags & F_DRAGGED) dragPos = v.pos.clone().add(new THREE.Vector3(0, 0.4, 0));
    });
    this.rings.end();
    this.ringFill.end();
    this.downedRings.end();
    this.rope.visible = !!dragPos && o.dragging;
    if (dragPos) {
      const a = this.eye.clone().add(new THREE.Vector3(-Math.cos(cam.yaw) * 0.25, -0.5, Math.sin(cam.yaw) * 0.25));
      const b = dragPos as THREE.Vector3;
      const pts = this.rope.geometry.attributes.position as THREE.BufferAttribute;
      const sag = Math.min(0.6, a.distanceTo(b) * 0.08);
      for (let i = 0; i < 12; i++) {
        const k = i / 11;
        pts.setXYZ(i, a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k - Math.sin(k * Math.PI) * sag, a.z + (b.z - a.z) * k);
      }
      pts.needsUpdate = true;
    }

    this.view.visible = o.viewModel && this.viewAllowed;
    this.view.update(dt, t, o.moveSpeed, o.sprinting, o.blocking, light);
    this.renderer.autoClear = true;
    this.renderer.render(this.scene, this.camera);
    this.view.render(this.renderer);
    return dt;
  }
}
