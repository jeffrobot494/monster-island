import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Terrain } from './terrain';
import { ShapeRenderer } from './shapes';
import { Particles } from './particles';
import { Sprites } from './sprites';
import { Sky } from './sky';
import { ENT_STRIDE, type FramePayload, type SimToMain } from '../protocol';
import type { ShapeDef } from '../sim/types';
import { TICKS_PER_SECOND } from '../sim/time';

type FullState = Extract<SimToMain, { type: 'fullState' }>;
type Defs = Extract<SimToMain, { type: 'defs' }>;

export class Renderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  terrain = new Terrain();
  shapes = new ShapeRenderer();
  particles = new Particles();
  sprites = new Sprites();
  sky: Sky;

  private lastFrameAt = 0;
  private frameInterval = 100;
  private tick = 0;
  private prevTick = 0;
  private clock = new THREE.Clock();
  private fly: { from: THREE.Vector3; to: THREE.Vector3; fromDist: number; toDist: number; t: number; dur: number } | null = null;
  private raycaster = new THREE.Raycaster();
  private selection: THREE.Mesh;
  selectedId: number | null = null;
  speed = 1;
  paused = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.5, 600);
    this.camera.position.set(32, 48, 34 + 42);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(32, 0, 34);
    this.controls.enableDamping = true;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 140;
    this.controls.maxPolarAngle = Math.PI * 0.42;
    this.controls.minPolarAngle = Math.PI * 0.12;
    this.controls.screenSpacePanning = false;
    this.sky = new Sky(this.scene);
    this.scene.add(this.terrain.group, this.shapes.group, this.particles.group, this.sprites.group);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.6, 24), new THREE.MeshBasicMaterial({ color: '#fff6c0', transparent: true, opacity: 0.85, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;
    this.selection = ring;
    this.scene.add(ring);
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
    this.terrain.load(s.tiles, s.elev);
    this.shapes.applyFrame(s.ents, ENT_STRIDE, true);
    this.particles.setAttached(s.attached);
    this.sky.atmosphere = { ...s.atmosphere };
    this.particles.weather = s.atmosphere.weather ?? 'none';
    this.tick = this.prevTick = s.tick;
    this.lastFrameAt = performance.now();
  }

  onFrame(f: FramePayload) {
    const now = performance.now();
    this.frameInterval = 1000 / TICKS_PER_SECOND / Math.max(0.5, this.speed);
    this.lastFrameAt = now;
    this.prevTick = this.tick;
    this.tick = f.tick;
    if (f.tiles.length) this.terrain.applyChanges(f.tiles);
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

  flyTo(x: number, z: number, dist = 26, dur = 2.2) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    this.fly = { from: this.controls.target.clone(), to: new THREE.Vector3(x, 0, z), fromDist: offset.length(), toDist: dist, t: 0, dur };
  }

  pickAt(clientX: number, clientY: number): number | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const p = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(p, this.camera);
    return this.shapes.pick(this.raycaster);
  }

  render() {
    const dt = Math.min(0.1, this.clock.getDelta());
    const t = this.clock.elapsedTime;
    const alpha = this.paused ? 1 : Math.min(1, (performance.now() - this.lastFrameAt) / this.frameInterval);
    const tickF = this.prevTick + (this.tick - this.prevTick) * alpha;
    this.sky.update(tickF);
    this.terrain.update(t);
    this.shapes.update(alpha, t, this.sky.night);
    const pos = (id: number) => this.shapes.positionOf(id);
    const h = (id: number) => this.shapes.heightOf(id);
    this.particles.update(this.paused ? 0 : dt, pos, h, this.controls.target);
    this.sprites.update(t, pos, h);
    if (this.selectedId !== null) {
      const p = pos(this.selectedId);
      this.selection.visible = !!p;
      if (p) this.selection.position.set(p.x, p.y + 0.03, p.z);
    } else this.selection.visible = false;
    if (this.fly) {
      const f = this.fly;
      f.t = Math.min(1, f.t + dt / f.dur);
      const e = f.t < 0.5 ? 2 * f.t * f.t : 1 - (-2 * f.t + 2) ** 2 / 2;
      const offset = this.camera.position.clone().sub(this.controls.target).normalize();
      this.controls.target.lerpVectors(f.from, f.to, e);
      this.camera.position.copy(this.controls.target).addScaledVector(offset, f.fromDist + (f.toDist - f.fromDist) * e);
      if (f.t >= 1) this.fly = null;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
