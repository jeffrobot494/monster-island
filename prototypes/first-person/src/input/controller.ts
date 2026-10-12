// The champion controller (spec §4): client-authoritative movement at frame rate with tile collision, stamina,
// dodge, climbing (docs/climbing-phase1-plan.md, Part C), and pose messages to the sim. Positions in tiles; speeds
// in m/s are converted with M.
import { M } from '../sim/ground';
import { SIZE, TileGrid } from '../sim/world';
import type { Controls } from './controls';
import type { Ground } from '../sim/ground';
import type { CtrlReason } from '../sim/champion';
import { distToFace, faceAt, LEDGE, localFace, slopeAlong, WALL, wallNear, type Face } from './climb-surface';

export const EYE_H = 1.65;
const R = 0.35 / M; // body radius in tiles
const WALK = 4.5, SPRINT = 8.8; // m/s
const ACCEL = 30, FRICTION = 12;
const GRAVITY = 22, JUMP_V = 6.2; // m/s², m/s: a ~0.85 m hop, ~0.55 s in the air
const AIR_CONTROL = 2.5; // how quickly you can steer in the air (1/s)
const FLY = 60, FLY_FAST = 240; // dev fly mode, m/s (Shift for fast)
// climbing (docs/climbing-phase1-plan.md, Rules)
const CLIMB_SPEED = 1.8; // m/s
const STANDOFF = 0.45; // body axis to the face, at feet height (m)
const HANDS = 1.3; // above the feet: where the normal and the mantle are read (m)
const DRAIN_MOVE = 6, DRAIN_HOLD = 3; // stamina/s
const LUNGE_M = 2, LUNGE_T = 0.25, LUNGE_COST = 15;
const WALL_JUMP_V = 4; // m/s horizontally
const MANTLE_T = 0.5;
const START_T = 0.15; // pushing into a wall this long starts a climb

export type MoveMode = 'walk' | 'air' | 'wall' | 'mantle';

export interface Solid { x: number; z: number; r: number } // tiles

/** the body's collision samples: a circle of radius R */
const RING: [number, number][] = [[R, 0], [-R, 0], [0, R], [0, -R], [R * 0.7, R * 0.7], [-R * 0.7, R * 0.7], [R * 0.7, -R * 0.7], [-R * 0.7, -R * 0.7], [0, 0]];

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
  /** walking, airborne (jumps and falls), on a wall, or pulling up over a lip */
  mode: MoveMode = 'walk';
  get air() {
    return this.mode === 'air';
  }
  get climbing() {
    return this.mode === 'wall' || this.mode === 'mantle';
  }
  /** feet height (m, absolute) and vertical speed (m/s); the sim sees the feet as `alt` above the ground */
  feetY = 0;
  vy = 0;
  onLand: (impact: number) => void = () => {};
  /** a landing hard enough to hurt (impact > 13 m/s): main.ts tells the sim, which decides the damage */
  onFall: (impact: number) => void = () => {};
  /** every 0.6 m climbed */
  onClimbStep: () => void = () => {};
  /** set by main.ts: tile types (the renderer's grid, which gets god edits in place), the rock mask (Part A), the
   *  sim's control reason (hold vs autopilot), and the weather */
  grid: TileGrid = new TileGrid();
  rock: Uint8Array | null = null;
  reason: CtrlReason = 'player';
  rain = false;
  /** the wall being climbed */
  face: Face | null = null;
  private noGrabUntil = 0;
  private pushT = 0;
  private wallHit: Face | null = null;
  private mantle: { x0: number; z0: number; y0: number; x1: number; z1: number; y1: number; t: number } | null = null;
  private lunge: { lx: number; ly: number; t: number } | null = null;
  private sprintWas = false;
  private climbAcc = 0;
  private slideT = 0;
  /** feet height where the current fall began (walked off or jumped): for catching the lip on the way down */
  private fallFrom: number | null = null;
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
  /** dev fly mode: no collision, no gravity; eye height in meters (absolute) */
  flying = false;
  private flyY = 0;

  constructor(private controls: Controls, private ground: Ground, private send: (m: unknown) => void) {}

  walkable(x: number, z: number): boolean {
    const ix = Math.floor(x), iz = Math.floor(z);
    if (ix < 0 || iz < 0 || ix >= SIZE || iz >= SIZE) return false;
    return this.passable(ix, iz);
  }

  /** Tile type first: cliff tiles are ground the slope rules govern (unless rock stands on them); the champion's
   *  own tile is always walkable in the sim's table, so the table alone can't be trusted for them. */
  private passable(ix: number, iz: number): boolean {
    const i = iz * SIZE + ix;
    if (this.grid.types[i] === 'cliff') return !this.rock?.[i];
    return this.walk[i] > 0;
  }

  private isCliff(x: number, z: number): boolean {
    return this.grid.get(Math.floor(x), Math.floor(z)) === 'cliff';
  }

  /** In the air or on a wall you may also be over water (a sea-cliff foot) on terrain islands. */
  private free(x: number, z: number): boolean {
    const ix = Math.floor(x), iz = Math.floor(z);
    if (ix < 0 || iz < 0 || ix >= SIZE || iz >= SIZE) return false;
    if (this.passable(ix, iz)) return true;
    return !!this.grid.base && this.grid.types[iz * SIZE + ix].endsWith('water');
  }

  private freeR(x: number, z: number): boolean {
    for (const [dx, dz] of RING) if (!this.free(x + dx, z + dz)) return false;
    return true;
  }

  /** The sim's terrain factor for paths: 1 / clamp(cost, 0.6, 3). */
  terrainFactor(x: number, z: number): number {
    const ix = Math.floor(x), iz = Math.floor(z);
    const c = this.walk[iz * SIZE + ix] / 20;
    return c > 0 ? 1 / Math.min(3, Math.max(0.6, c)) : 1;
  }

  /** Is a circle of radius R at (x, z) clear of unwalkable tiles? */
  private clear(x: number, z: number): boolean {
    for (const [dx, dz] of RING) if (!this.walkable(x + dx, z + dz)) return false;
    return true;
  }

  /** Stuck where you can't stand (landed in the water at a cliff foot, a correction into a blocked tile): move to the
   *  nearest clear spot. Only when the centre itself is blocked, so a body brushing a wall is left alone. */
  private unstick() {
    if (this.walkable(this.x, this.z)) return;
    const rs: number[] = [];
    for (let r = 0.05; r < 1; r += 0.05) rs.push(r);
    for (let r = 1; r < 40; r++) rs.push(r);
    for (const r of rs) {
      for (let a = 0; a < 16; a++) {
        const nx = this.x + Math.cos((a / 16) * Math.PI * 2) * r, nz = this.z + Math.sin((a / 16) * Math.PI * 2) * r;
        if (this.clear(nx, nz)) {
          this.x = nx;
          this.z = nz;
          this.feetY = this.ground.y(nx, nz);
          this.inputSince = true;
          return;
        }
      }
    }
  }

  /** Enter walk mode on the ground here. */
  private toWalk() {
    this.mode = 'walk';
    this.fallFrom = null;
    this.face = null;
    this.mantle = this.lunge = null;
    this.vy = 0;
    this.unstick();
    this.feetY = this.ground.y(this.x, this.z);
    this.smoothEye = this.eyeY;
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

  /**
   * The sim put the champion here (epoch change, correction, hand-over). `alt` = feet above the ground. A climber or
   * faller still where the sim thinks they are is a resync and keeps going; otherwise a lifted champion is placed in
   * the air and regrabs a wall right there if there is one (a correction mid-climb puts you back on the wall).
   */
  snap(x: number, z: number, alt = 0) {
    if ((this.climbing || this.mode === 'air') && Math.hypot(x - this.x, z - this.z) < 0.1 && alt > 0.3) return;
    this.x = x;
    this.z = z;
    this.vx = this.vz = 0;
    this.vy = 0;
    this.dodgeT = -1;
    this.mantle = this.lunge = null;
    this.face = null;
    const gy = this.ground.y(x, z);
    if (alt > 0.3 && this.grid.base) {
      this.mode = 'air';
      this.feetY = gy + alt;
      this.smoothEye = this.feetY + EYE_H;
      this.tryGrab(performance.now() / 1000, true);
      return;
    }
    const was = this.mode;
    this.mode = 'walk';
    this.feetY = gy;
    this.unstick();
    if (was !== 'walk') this.smoothEye = this.eyeY;
  }

  /** Dev: toggle fly mode. Landing drops you (with gravity) onto the nearest walkable tile. */
  setFlying(on: boolean) {
    if (on === this.flying) return;
    this.flying = on;
    this.vx = this.vz = this.vy = 0;
    this.dodgeT = -1;
    if (on) {
      this.flyY = this.eyeY;
      this.mode = 'walk';
      this.face = null;
      this.mantle = this.lunge = null;
      return;
    }
    if (!this.clear(this.x, this.z)) {
      found: for (let r = 1; r < 40; r++) {
        for (let a = 0; a < 16; a++) {
          const nx = this.x + Math.cos((a / 16) * Math.PI * 2) * r, nz = this.z + Math.sin((a / 16) * Math.PI * 2) * r;
          if (this.clear(nx, nz)) {
            this.x = nx;
            this.z = nz;
            break found;
          }
        }
      }
    }
    this.feetY = Math.max(this.flyY - EYE_H, this.ground.y(this.x, this.z));
    this.mode = 'air';
    this.inputSince = true;
  }

  tryJump(now: number): boolean {
    if (this.ctrl !== 'player' || this.flying || this.mode !== 'walk' || this.view !== 'normal' || this.dragging || this.dodgeT >= 0) return false;
    if (!this.spend(8)) return false;
    this.mode = 'air';
    this.feetY = this.fallFrom = this.ground.y(this.x, this.z);
    this.vy = JUMP_V;
    this.inputSince = true;
    void now;
    return true;
  }

  tryDodge(now: number): boolean {
    if (this.ctrl !== 'player' || this.flying || now < this.dodgeReady || this.dragging || this.mode !== 'walk') return false;
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
    if (this.ctrl !== 'player' || this.view === 'downed' || now < this.swingReady || this.blocking || this.dragging || this.climbing) return false;
    if (!this.spend(12)) return false;
    this.swingReady = now + 0.6;
    return true;
  }

  setBlocking(on: boolean) {
    const want = on && !this.winded && !this.torch && !this.dragging && this.ctrl === 'player' && !this.climbing;
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

    // stamina regeneration (none while on a wall)
    if (!this.climbing && now - this.spentAt > 0.8) this.stamina = Math.min(100, this.stamina + 25 * dt);
    if (this.winded && this.stamina >= 25) this.winded = false;

    if (this.ctrl === 'player' && this.flying) {
      this.fly(dt, now);
      return;
    }
    if (this.climbing) {
      this.climb(dt, now);
      if (this.climbing) return;
    }
    this.wallHit = null;
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
      const k = this.mode === 'air' ? (l > 0 ? Math.min(1, AIR_CONTROL * dt) : 0) : Math.min(1, (l > 0 ? ACCEL / Math.max(0.1, top * M) : FRICTION) * dt);
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
      // pushing into a wall on a cliff tile for a moment starts a climb
      const hit = this.wallHit as Face | null; // set by move()
      if (hit && this.mode === 'walk' && c.down('forward') && -(s * hit.nx + co * hit.nz) >= 0.5 && this.canClimb()) {
        this.pushT += dt;
        if (this.pushT >= START_T) this.startClimb(hit);
      } else this.pushT = 0;
      if (this.climbing) return;
      this.sendPose(now);
      // footsteps
      if (this.mode === 'walk') this.stepAcc += this.moveSpeed * dt;
      const stride = this.sprinting ? 2.4 : 1.6;
      if (this.stepAcc > stride) {
        this.stepAcc = 0;
        this.onStep();
      }
    } else {
      this.moveSpeed = 0;
      this.sprinting = false;
      this.dodgeT = -1;
      this.pushT = 0;
      // a fall in progress still falls (and still lands, and still hurts)
      if (this.mode === 'air') this.move(this.vx * dt, this.vz * dt);
    }
    let gy = this.ground.y(this.x, this.z);
    if (this.mode === 'air') {
      this.vy -= GRAVITY * dt;
      this.feetY += this.vy * dt;
      if (this.ctrl === 'player' && this.reason === 'player' && this.controls.down('jump')) this.tryGrab(now, false);
      gy = this.ground.y(this.x, this.z);
      if (this.mode === 'air' && this.feetY <= gy) {
        const f = this.isCliff(this.x, this.z) ? localFace(this.ground, this.x, this.z) : null;
        if (f && f.slope > WALL && this.slideT < 3) {
          // landing on a face is a slide, not a landing: you keep falling, carried out along it just fast enough to
          // follow the face down
          this.feetY = gy;
          const sp = Math.max(Math.hypot(this.vx, this.vz) * M, 3, -this.vy / f.slope) / M;
          this.vx = f.nx * sp;
          this.vz = f.nz * sp;
          this.slideT += dt;
        } else {
          const impact = -this.vy;
          this.mode = 'walk';
          this.vy = 0;
          this.slideT = 0;
          this.fallFrom = null;
          this.unstick();
          gy = this.ground.y(this.x, this.z);
          this.feetY = gy;
          // a little knee-bend on landing; the eye smoothing below springs back up
          this.smoothEye = gy + EYE_H - Math.min(0.18, Math.max(0, impact) * 0.02);
          this.onLand(impact);
          if (impact > 13) this.onFall(impact);
        }
      } else if (this.feetY > gy + 0.05) this.slideT = 0;
    }
    if (this.mode === 'walk') {
      this.feetY = gy;
      // standing on a face is impossible: you start to fall down it (landings, snaps, loads, corrections)
      if (this.isCliff(this.x, this.z) && localFace(this.ground, this.x, this.z).slope > WALL) {
        this.mode = 'air';
        this.vy = 0;
      }
    }
    // eye height
    let target = gy + EYE_H;
    if (this.view === 'downed') target = this.ground.y(this.x, this.z) + 0.45;
    if (this.view === 'carried') target = this.ground.y(this.x, this.z) + 1.4 + this.lift * 0.5;
    const bobA = this.moveSpeed > 0.5 && this.mode === 'walk' ? (this.sprinting ? 0.08 : 0.04) : 0;
    this.bobT += dt * (this.sprinting ? 12 : 8);
    const bob = Math.sin(this.bobT) * bobA;
    if (this.air) this.smoothEye = this.feetY + EYE_H;
    else this.smoothEye += (target - this.smoothEye) * Math.min(1, dt * 12);
    if (Math.abs(target - this.smoothEye) > 3) this.smoothEye = target;
    this.eyeY = this.smoothEye + bob;
  }

  private sendPose(now: number) {
    if (now * 1000 - this.lastPose < this.poseEvery) return;
    this.lastPose = now * 1000;
    const pose: Record<string, unknown> = { type: 'pose', x: this.x, z: this.z, yaw: this.yaw, pitch: this.pitch, epoch: this.epoch, input: this.inputSince };
    // height only matters on terraformer islands; procedural islands keep sending exactly what they always did
    if (this.grid.base) {
      pose.alt = Math.max(0, this.feetY - this.ground.y(this.x, this.z));
      const climb = this.climbing ? 'wall' : this.isCliff(this.x, this.z) ? 'perch' : undefined;
      if (climb) pose.climb = climb;
    }
    this.send({ type: 'input', input: pose });
    this.inputSince = false;
  }

  // ---- climbing (docs/climbing-phase1-plan.md, C2–C7) ----

  private canClimb(): boolean {
    return this.stamina >= 5 && !this.dragging && this.view === 'normal' && this.reason === 'player' && this.ctrl === 'player' && !this.flying;
  }

  private startClimb(f: Face) {
    this.mode = 'wall';
    this.face = f;
    this.vx = this.vz = this.vy = 0;
    this.dodgeT = -1;
    this.pushT = 0;
    this.climbAcc = 0;
    // a step onto the wall, so the feet are on the face and not the flat at its foot
    this.feetY = this.ground.y(this.x, this.z) + 0.3;
    this.inputSince = true;
    if (!this.reanchor()) this.toWalk();
  }

  /** Grab a wall within reach of the hands (air mode). `force`: no Space needed (a correction mid-climb). */
  private tryGrab(now: number, force: boolean): boolean {
    if (this.mode !== 'air' || !this.grid.base) return false;
    if (!force && (now < this.noGrabUntil || !this.canClimb())) return false;
    if (force && (this.stamina <= 0 || this.dragging)) return false;
    const was = { x: this.x, z: this.z, feetY: this.feetY };
    let f = wallNear(this.ground, this.x, this.z, this.feetY + HANDS);
    if (!f && !force && this.fallFrom !== null && this.feetY > this.fallFrom - 1.5) {
      // just went over an edge: catch the lip, hanging by the hands below it
      f = wallNear(this.ground, this.x, this.z, this.fallFrom - HANDS, 1.5);
      if (f) this.feetY = this.fallFrom - HANDS;
    }
    if (!f) return false;
    const px = this.x - (f.nx * 0.6) / M, pz = this.z - (f.nz * 0.6) / M;
    if (!this.isCliff(this.x, this.z) && !this.isCliff(px, pz)) {
      this.feetY = was.feetY;
      return false;
    }
    this.mode = 'wall';
    this.face = f;
    if (!this.reanchor()) {
      Object.assign(this, was);
      this.mode = 'air';
      this.face = null;
      return false;
    }
    this.vx = this.vz = this.vy = 0;
    this.climbAcc = 0;
    this.fallFrom = null;
    this.inputSince = true;
    return true;
  }

  /**
   * Keep the body STANDOFF out from the face at feet height, and re-read the normal (at the hands when the face is
   * there, else at the feet). False when there's no face at feet height (above the lip, or the face fell away).
   */
  private anchor: { x: number; z: number; slope: number } | null = null;
  private reanchor(): boolean {
    const f = this.face!;
    const g = this.ground;
    const sx = this.x + (f.nx * 2) / M, sz = this.z + (f.nz * 2) / M;
    const d = distToFace(g, sx, sz, f.nx, f.nz, this.feetY, 4);
    if (d === null || d === 0) {
      this.anchor = null;
      return false;
    }
    const ax = sx - (f.nx * d) / M, az = sz - (f.nz * d) / M;
    const af = faceAt(g, ax, az);
    this.anchor = { x: ax, z: az, slope: af.slope };
    const dh = distToFace(g, sx, sz, f.nx, f.nz, this.feetY + HANDS, 4);
    let nf = af;
    if (dh !== null && dh > 0) {
      const hf = faceAt(g, sx - (f.nx * dh) / M, sz - (f.nz * dh) / M);
      if (hf.slope > LEDGE) nf = hf;
    }
    if (nf.slope > LEDGE && nf.nx * f.nx + nf.nz * f.nz > 0.2) this.face = nf;
    else this.face = { nx: f.nx, nz: f.nz, slope: Math.max(nf.slope, af.slope) };
    this.x = ax + (this.face.nx * STANDOFF) / M;
    this.z = az + (this.face.nz * STANDOFF) / M;
    return true;
  }

  /** The lip 0.8 m into the face from the anchor: low enough to reach, flat, and somewhere you can stand. */
  private mantleTo(): { x: number; z: number; y: number } | null {
    const f = this.face!;
    const bx = this.anchor ? this.anchor.x : this.x - (f.nx * STANDOFF) / M, bz = this.anchor ? this.anchor.z : this.z - (f.nz * STANDOFF) / M;
    const tx = bx - (f.nx * 0.8) / M, tz = bz - (f.nz * 0.8) / M;
    const ty = this.ground.y(tx, tz);
    if (ty > this.feetY + HANDS || localFace(this.ground, tx, tz).slope >= LEDGE || !this.clear(tx, tz)) return null;
    return { x: tx, z: tz, y: ty };
  }

  private startMantle(t: { x: number; z: number; y: number }) {
    this.mode = 'mantle';
    this.lunge = null;
    this.mantle = { x0: this.x, z0: this.z, y0: this.feetY, x1: t.x, z1: t.z, y1: t.y, t: 0 };
  }

  /** Let go of the wall: a fall, pushed a little off the face. */
  letGo(now = performance.now() / 1000) {
    if (!this.climbing) return;
    const f = this.face;
    this.mode = 'air';
    this.mantle = this.lunge = null;
    this.vx = this.vz = this.vy = 0;
    if (f) {
      const px = this.x + (f.nx * 0.3) / M, pz = this.z + (f.nz * 0.3) / M;
      if (this.freeR(px, pz)) {
        this.x = px;
        this.z = pz;
      }
    }
    this.face = null;
    this.fallFrom = null;
    this.noGrabUntil = now + 0.6;
    this.inputSince = true;
  }

  /** Hit while hanging: knocked off. */
  knock() {
    this.letGo();
  }

  /** Space on a wall: a jump away when looking away from the face, otherwise a lunge up. */
  wallJump(now = performance.now() / 1000) {
    if (this.mode !== 'wall' || this.ctrl !== 'player' || this.reason !== 'player' || !this.face) return;
    const s = Math.sin(this.yaw), co = Math.cos(this.yaw);
    const f = this.face;
    if (s * f.nx + co * f.nz > 0.3) {
      if (!this.spend(8)) return;
      this.mode = 'air';
      this.face = null;
      this.lunge = null;
      this.vx = (s * WALL_JUMP_V) / M;
      this.vz = (co * WALL_JUMP_V) / M;
      this.vy = JUMP_V;
      this.noGrabUntil = now + 0.3;
      this.inputSince = true;
      return;
    }
    this.startLunge(0, 1);
  }

  private startLunge(lx: number, ly: number) {
    if (this.lunge || !this.spend(LUNGE_COST)) return;
    const l = Math.hypot(lx, ly);
    this.lunge = { lx: lx / l, ly: ly / l, t: 0 };
  }

  /** Wall and mantle modes. */
  private climb(dt: number, now: number) {
    const c = this.controls;
    this.moveSpeed = 0;
    this.sprinting = false;
    this.dodgeT = -1;
    this.pushT = 0;
    // the sim moves you now: back to the ground (the sim takes you off the cliff, D3)
    if (this.view === 'carried' || this.view === 'spectate' || (this.ctrl === 'sim' && this.reason !== 'hold')) {
      this.toWalk();
      return;
    }
    if (this.view === 'downed') {
      this.letGo(now);
      return;
    }
    const active = this.ctrl === 'player' && this.reason === 'player';
    if (this.mode === 'mantle') {
      const m = this.mantle!;
      if (active) m.t += dt / MANTLE_T;
      const k = Math.min(1, m.t);
      this.feetY = m.y0 + (Math.max(m.y0, m.y1 + 0.05) - m.y0) * Math.min(1, k / 0.6);
      const h = Math.max(0, (k - 0.6) / 0.4);
      this.x = m.x0 + (m.x1 - m.x0) * h;
      this.z = m.z0 + (m.z1 - m.z0) * h;
      this.eyeY = this.smoothEye = this.feetY + EYE_H;
      if (k >= 1) {
        this.toWalk();
        this.inputSince = true;
      }
      if (active) this.sendPose(now);
      return;
    }
    const f0 = this.face!;
    const prev = { x: this.x, z: this.z, feetY: this.feetY };
    let up = 0, side = 0;
    if (active) {
      let fz = 0, fx = 0;
      if (c.down('forward')) fz += 1;
      if (c.down('back')) fz -= 1;
      if (c.down('left')) fx += 1;
      if (c.down('right')) fx -= 1;
      const sprint = c.down('sprint');
      if (sprint && !this.sprintWas && (fx || fz)) this.startLunge(fx, fz);
      this.sprintWas = sprint;
      if (this.lunge) {
        const step = Math.min(dt, LUNGE_T - this.lunge.t) * (LUNGE_M / LUNGE_T);
        up = this.lunge.ly * step;
        side = this.lunge.lx * step;
        this.lunge.t += dt;
        if (this.lunge.t >= LUNGE_T) this.lunge = null;
      } else {
        up = fz * CLIMB_SPEED * dt;
        side = fx * CLIMB_SPEED * dt;
      }
      // stamina
      const drain = (up || side ? DRAIN_MOVE : DRAIN_HOLD) * (this.rain ? 1.5 : 1) * dt;
      this.stamina = Math.max(0, this.stamina - drain);
      this.spentAt = now;
    }
    // sideways along the face; undone if that's somewhere you can't be
    if (side) {
      const nx = this.x + (-f0.nz * side) / M, nz = this.z + (f0.nx * side) / M;
      if (this.freeR(nx, nz)) {
        this.x = nx;
        this.z = nz;
      }
    }
    this.feetY += up;
    // feet never below the ground under the body
    const gyBody = this.ground.y(this.x, this.z);
    if (this.feetY < gyBody) this.feetY = gyBody;
    if (!this.reanchor()) {
      // nothing at feet height: past the lip (mantle) or the face fell away
      const t = up > 0 ? this.mantleTo() : null;
      if (t) {
        this.startMantle(t);
        return;
      }
      Object.assign(this, prev);
      this.face = f0;
      if (!this.reanchor()) {
        this.letGo(now);
        return;
      }
    }
    // exits, in order
    if (up > 0) {
      const t = this.mantleTo();
      if (t) {
        this.startMantle(t);
        return;
      }
    }
    const gy = this.ground.y(this.x, this.z);
    const standable = localFace(this.ground, this.x, this.z).slope < LEDGE && this.clear(this.x, this.z);
    if (standable && Math.abs(this.feetY - gy) < 0.15) {
      this.toWalk();
      this.inputSince = true;
      return;
    }
    if (!standable && this.feetY < gy + 0.15) this.feetY = gy + 0.15; // a foot you can't stand on (water): no lower
    if (this.anchor && this.anchor.slope < LEDGE) {
      const t = this.mantleTo();
      if (t) this.startMantle(t);
      else this.letGo(now);
      return;
    }
    if (this.stamina <= 0) {
      this.winded = true;
      this.letGo(now);
      return;
    }
    this.climbAcc += Math.abs(this.feetY - prev.feetY) + Math.abs(side);
    if (this.climbAcc > 0.6) {
      this.climbAcc = 0;
      this.onClimbStep();
    }
    if (up || side) this.inputSince = true;
    this.eyeY = this.smoothEye = this.feetY + EYE_H;
    if (active) this.sendPose(now);
  }

  /** Dev fly mode: WASD along the view, Space up, C down, Shift for speed. */
  private fly(dt: number, now: number) {
    const c = this.controls;
    let fx = 0, fz = 0, up = 0;
    if (c.down('forward')) fz += 1;
    if (c.down('back')) fz -= 1;
    if (c.down('left')) fx += 1;
    if (c.down('right')) fx -= 1;
    if (c.down('jump')) up += 1;
    if (c.down('dodge')) up -= 1;
    const sp = c.down('sprint') ? FLY_FAST : FLY;
    const s = Math.sin(this.yaw), co = Math.cos(this.yaw), cp = Math.cos(this.pitch), sp2 = Math.sin(this.pitch);
    let wx = fz * s * cp + fx * co, wz = fz * co * cp - fx * s, wy = fz * sp2 + up;
    const l = Math.hypot(wx, wy, wz);
    if (l > 0) { wx /= l; wy /= l; wz /= l; }
    this.x = Math.min(SIZE - 0.01, Math.max(0, this.x + (wx * sp * dt) / M));
    this.z = Math.min(SIZE - 0.01, Math.max(0, this.z + (wz * sp * dt) / M));
    this.flyY = Math.min(400, Math.max(this.ground.y(this.x, this.z) + EYE_H, this.flyY + wy * sp * dt));
    if (l > 0) this.inputSince = true;
    this.moveSpeed = 0;
    this.sprinting = false;
    this.mode = 'walk';
    this.eyeY = this.smoothEye = this.flyY;
    if (now * 1000 - this.lastPose >= this.poseEvery) {
      this.lastPose = now * 1000;
      this.send({ type: 'input', input: { type: 'pose', x: this.x, z: this.z, yaw: this.yaw, pitch: this.pitch, epoch: this.epoch, input: this.inputSince, fly: true } });
      this.inputSince = false;
    }
  }

  /** May this sub-step go along one axis? Walk mode on cliff tiles: no walking up a wall (and remember it, for
   *  starting a climb); walking off a drop starts a fall. In the air, no flying into a face. */
  private stepOk(nx: number, nz: number, ax: number, az: number, dx: number, dz: number): boolean {
    if (this.mode === 'air') {
      if (!(this.grid.base ? this.freeR(nx, nz) : this.clear(nx, nz))) return false;
      return !(this.isCliff(nx, nz) && this.ground.y(nx, nz) > this.feetY + 0.3);
    }
    if (!this.clear(nx, nz)) return false;
    if (this.mode !== 'walk' || !(this.isCliff(this.x, this.z) || this.isCliff(nx, nz))) return true;
    const along = slopeAlong(this.ground, this.x, this.z, ax, az);
    const dir = slopeAlong(this.ground, this.x, this.z, dx, dz);
    if (along > WALL || (dir > WALL && along > 0)) {
      const f = faceAt(this.ground, this.x + (dx * 0.25) / M, this.z + (dz * 0.25) / M);
      this.wallHit = f.slope > WALL ? f : faceAt(this.ground, this.x + (ax * 0.25) / M, this.z + (az * 0.25) / M);
      return false;
    }
    if (along < -WALL || dir < -WALL) {
      this.mode = 'air';
      this.vy = 0;
      this.feetY = this.fallFrom = this.ground.y(this.x, this.z);
    }
    return true;
  }

  private move(mx: number, mz: number) {
    // sub-step so a dodge never tunnels through a wall corner
    const steps = Math.max(1, Math.ceil(Math.hypot(mx, mz) / (R * 0.8)));
    const l = Math.hypot(mx, mz), dx = l > 0 ? mx / l : 0, dz = l > 0 ? mz / l : 0;
    for (let i = 0; i < steps; i++) {
      const sx = mx / steps, sz = mz / steps;
      if (sx && this.stepOk(this.x + sx, this.z, Math.sign(sx), 0, dx, dz)) this.x += sx;
      else if (sx) this.vx = 0;
      if (sz && this.stepOk(this.x, this.z + sz, 0, Math.sign(sz), dx, dz)) this.z += sz;
      else if (sz) this.vz = 0;
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
