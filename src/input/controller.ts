// The champion controller (spec §4): client-authoritative movement at frame rate with tile collision, stamina,
// dodge, and pose messages to the sim. Positions in tiles; speeds in m/s are converted with M.
import { M } from '../sim/ground';
import { SIZE } from '../sim/world';
import type { Controls } from './controls';
import type { Ground } from '../sim/ground';

export const EYE_H = 1.65;
const R = 0.35 / M; // body radius in tiles
const WALK = 4.5, SPRINT = 8.8; // m/s
const ACCEL = 30, FRICTION = 12;
const GRAVITY = 22, JUMP_V = 6.2; // m/s², m/s: a ~0.85 m hop, ~0.55 s in the air
const AIR_CONTROL = 2.5; // how quickly you can steer in the air (1/s)

export interface Solid { x: number; z: number; r: number } // tiles

export class ChampionController {
  x = 64;
  z = 64;
  yaw = 0;
  pitch = 0;
  vx = 0;
  vz = 0;
  /** sim or player authority */
  ctrl: 'player' | 'sim' = 'sim';
  stamina = 100;
  winded = false;
  private spentAt = -10;
  swingReady = 0;
  dodgeReady = 0;
  dodgeT = -1;
  /** jumping: feet height (m, absolute) and vertical speed (m/s); client-only, the sim never sees it */
  air = false;
  feetY = 0;
  vy = 0;
  onLand: (impact: number) => void = () => {};
  private dodgeDx = 0;
  private dodgeDz = 0;
  blocking = false;
  torch = false;
  sprinting = false;
  speedMul = 1;
  /** sim-supplied: can't sprint or swing (dragging) */
  dragging = false;
  /** champion move cost per tile × 20; 0 = blocked (F19) */
  walk: Uint8Array = new Uint8Array(SIZE * SIZE);
  epoch = 0;
  /** client-only colliders (tree trunks, boulders, columns; F32): tile index → circles (tiles) */
  decorSolids: Map<number, Solid[]> = new Map();
  /** set when real input happened since the last pose (F9) */
  private inputSince = false;
  solids: Solid[] = [];
  eyeY = 0;
  private smoothEye = 0;
  bobT = 0;
  moveSpeed = 0; // m/s, for bob/footsteps
  private lastPose = 0;
  onStep: () => void = () => {};
  private stepAcc = 0;
  /** downed: eye low; captive: lifted */
  view: 'normal' | 'downed' | 'carried' | 'spectate' = 'normal';
  lift = 0;
  /** a gentle cap on the pose rate (ms) */
  poseEvery = 50;

  constructor(private controls: Controls, private ground: Ground, private send: (m: unknown) => void) {}

  walkable(x: number, z: number): boolean {
    const ix = Math.floor(x), iz = Math.floor(z);
    if (ix < 0 || iz < 0 || ix >= SIZE || iz >= SIZE) return false;
    return this.walk[iz * SIZE + ix] > 0;
  }

  /** The sim's terrain factor for paths: 1 / clamp(cost, 0.6, 3). */
  terrainFactor(x: number, z: number): number {
    const ix = Math.floor(x), iz = Math.floor(z);
    const c = this.walk[iz * SIZE + ix] / 20;
    return c > 0 ? 1 / Math.min(3, Math.max(0.6, c)) : 1;
  }

  /** Is a circle of radius R at (x, z) clear of unwalkable tiles? */
  private clear(x: number, z: number): boolean {
    for (const [dx, dz] of [[R, 0], [-R, 0], [0, R], [0, -R], [R * 0.7, R * 0.7], [-R * 0.7, R * 0.7], [R * 0.7, -R * 0.7], [-R * 0.7, -R * 0.7], [0, 0]]) {
      if (!this.walkable(x + dx, z + dz)) return false;
    }
    return true;
  }

  private spend(n: number): boolean {
    if (this.winded || this.stamina < n) return false;
    this.stamina -= n;
    this.spentAt = performance.now() / 1000;
    if (this.stamina <= 0) {
      this.stamina = 0;
      this.winded = true;
    }
    return true;
  }

  /** Stamina cost of a blocked hit (from the sim). */
  blockedHit(prevented: number) {
    this.stamina = Math.max(0, this.stamina - prevented * 0.5);
    this.spentAt = performance.now() / 1000;
    if (this.stamina <= 0) this.winded = true;
  }

  snap(x: number, z: number) {
    this.x = x;
    this.z = z;
    this.vx = this.vz = 0;
    this.air = false;
    this.vy = 0;
  }

  tryJump(now: number): boolean {
    if (this.ctrl !== 'player' || this.air || this.view !== 'normal' || this.dragging || this.dodgeT >= 0) return false;
    if (!this.spend(8)) return false;
    this.air = true;
    this.feetY = this.ground.y(this.x, this.z);
    this.vy = JUMP_V;
    this.inputSince = true;
    void now;
    return true;
  }

  tryDodge(now: number): boolean {
    if (this.ctrl !== 'player' || now < this.dodgeReady || this.dragging || this.air) return false;
    if (!this.spend(25)) return false;
    this.dodgeReady = now + 0.5;
    let fx = 0, fz = 0;
    const c = this.controls;
    if (c.down('forward')) fz += 1;
    if (c.down('back')) fz -= 1;
    if (c.down('left')) fx += 1;
    if (c.down('right')) fx -= 1;
    if (!fx && !fz) fz = -1;
    const l = Math.hypot(fx, fz);
    fx /= l;
    fz /= l;
    const s = Math.sin(this.yaw), co = Math.cos(this.yaw);
    this.dodgeDx = fz * s + fx * co;
    this.dodgeDz = fz * co - fx * s;
    this.dodgeT = 0;
    this.send({ type: 'input', input: { type: 'dodge' } });
    return true;
  }

  /** Start a swing (the target is picked at blade contact by the caller, F7). */
  trySwing(now: number): boolean {
    if (this.ctrl !== 'player' || this.view === 'downed' || now < this.swingReady || this.blocking || this.dragging) return false;
    if (!this.spend(12)) return false;
    this.swingReady = now + 0.6;
    return true;
  }

  setBlocking(on: boolean) {
    const want = on && !this.winded && !this.torch && !this.dragging && this.ctrl === 'player';
    if (want === this.blocking) return;
    this.blocking = want;
    this.send({ type: 'input', input: { type: 'block', on: want } });
  }

  update(dt: number, now: number) {
    const c = this.controls;
    const [dy, dp] = c.readLook();
    if (dy || dp || c.down('forward') || c.down('back') || c.down('left') || c.down('right')) this.inputSince = true;
    this.yaw += dy;
    this.pitch = Math.max(-1.48, Math.min(1.48, this.pitch + dp));
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;

    // stamina regeneration
    if (now - this.spentAt > 0.8) this.stamina = Math.min(100, this.stamina + 25 * dt);
    if (this.winded && this.stamina >= 25) this.winded = false;

    if (this.ctrl === 'player') {
      let fx = 0, fz = 0;
      if (c.down('forward')) fz += 1;
      if (c.down('back')) fz -= 1;
      if (c.down('left')) fx += 1;
      if (c.down('right')) fx -= 1;
      const l = Math.hypot(fx, fz);
      if (l > 0) { fx /= l; fz /= l; }
      const s = Math.sin(this.yaw), co = Math.cos(this.yaw);
      const wx = fz * s + fx * co, wz = fz * co - fx * s;
      this.sprinting = c.down('sprint') && l > 0 && fz >= 0 && !this.blocking && !this.winded && !this.dragging;
      if (this.sprinting) {
        this.stamina = Math.max(0, this.stamina - 12 * dt);
        this.spentAt = now;
        if (this.stamina <= 0) this.winded = true;
      }
            const crawl = this.view === 'downed';
      if (crawl) this.sprinting = false;
      const top = crawl ? 0.75 / M : ((this.sprinting ? SPRINT : WALK) * this.speedMul * this.terrainFactor(this.x, this.z)) / M; // tiles/s
      const tx = wx * top, tz = wz * top;
      // accelerate toward the target velocity, with friction when idle
      // in the air you keep your momentum and can only steer a little
      const k = this.air ? (l > 0 ? Math.min(1, AIR_CONTROL * dt) : 0) : Math.min(1, (l > 0 ? ACCEL / Math.max(0.1, top * M) : FRICTION) * dt);
      this.vx += (tx - this.vx) * k;
      this.vz += (tz - this.vz) * k;
      let mx = this.vx * dt, mz = this.vz * dt;
      if (this.dodgeT >= 0) {
        const step = Math.min(dt, 0.2 - this.dodgeT);
        mx += (this.dodgeDx * 3.5 / M / 0.2) * step;
        mz += (this.dodgeDz * 3.5 / M / 0.2) * step;
        this.dodgeT += dt;
        if (this.dodgeT >= 0.2) this.dodgeT = -1;
      }
      this.move(mx, mz);
      this.moveSpeed = (Math.hypot(mx, mz) / Math.max(1e-4, dt)) * M;
      if (now * 1000 - this.lastPose >= this.poseEvery) {
        this.lastPose = now * 1000;
        this.send({ type: 'input', input: { type: 'pose', x: this.x, z: this.z, yaw: this.yaw, pitch: this.pitch, epoch: this.epoch, input: this.inputSince } });
        this.inputSince = false;
      }
      // footsteps
      if (!this.air) this.stepAcc += this.moveSpeed * dt;
      const stride = this.sprinting ? 2.4 : 1.6;
      if (this.stepAcc > stride) {
        this.stepAcc = 0;
        this.onStep();
      }
    } else {
      this.moveSpeed = 0;
      this.sprinting = false;
      this.dodgeT = -1;
      this.air = false;
    }
    const gy = this.ground.y(this.x, this.z);
    if (this.air) {
      this.vy -= GRAVITY * dt;
      this.feetY += this.vy * dt;
      if (this.feetY <= gy) {
        const impact = -this.vy;
        this.air = false;
        this.vy = 0;
        // a little knee-bend on landing; the eye smoothing below springs back up
        this.smoothEye = gy + EYE_H - Math.min(0.18, Math.max(0, impact) * 0.02);
        this.onLand(impact);
      }
    }
    // eye height
    let target = gy + EYE_H;
    if (this.view === 'downed') target = this.ground.y(this.x, this.z) + 0.45;
    if (this.view === 'carried') target = this.ground.y(this.x, this.z) + 1.4 + this.lift * 0.5;
    const bobA = this.moveSpeed > 0.5 && !this.air ? (this.sprinting ? 0.08 : 0.04) : 0;
    this.bobT += dt * (this.sprinting ? 12 : 8);
    const bob = Math.sin(this.bobT) * bobA;
    if (this.air) this.smoothEye = this.feetY + EYE_H;
    else this.smoothEye += (target - this.smoothEye) * Math.min(1, dt * 12);
    if (Math.abs(target - this.smoothEye) > 3) this.smoothEye = target;
    this.eyeY = this.smoothEye + bob;
  }

  private move(mx: number, mz: number) {
    // sub-step so a dodge never tunnels through a wall corner
    const steps = Math.max(1, Math.ceil(Math.hypot(mx, mz) / (R * 0.8)));
    for (let i = 0; i < steps; i++) {
      const sx = mx / steps, sz = mz / steps;
      if (this.clear(this.x + sx, this.z)) this.x += sx;
      else this.vx = 0;
      if (this.clear(this.x, this.z + sz)) this.z += sz;
      else this.vz = 0;
      // push out of solid circles (monsters, altars, trunks)
      const near = this.decorSolids.get(Math.floor(this.z) * SIZE + Math.floor(this.x));
      for (const s of near ? [...this.solids, ...near] : this.solids) {
        const dx = this.x - s.x, dz = this.z - s.z, d = Math.hypot(dx, dz), min = s.r + R;
        if (d < min && d > 1e-6) {
          const nx = s.x + (dx / d) * min, nz = s.z + (dz / d) * min;
          if (this.clear(nx, nz)) {
            this.x = nx;
            this.z = nz;
          }
        }
      }
    }
  }
}
