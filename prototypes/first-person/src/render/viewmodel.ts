// The first-person view model (spec §7.6): sword arm and shield or torch, drawn in its own scene on top of the world.
import * as THREE from 'three';

const mat = (c: string, e = 0) => {
  const m = new THREE.MeshLambertMaterial({ color: c, flatShading: true });
  if (e) {
    m.emissive = new THREE.Color(c);
    m.emissiveIntensity = e;
  }
  return m;
};

export class ViewModel {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, 1, 0.01, 10);
  private right = new THREE.Group();
  private left = new THREE.Group();
  private shield = new THREE.Group();
  private torch = new THREE.Group();
  private rope = new THREE.Group();
  private flame: THREE.Mesh;
  private ambient = new THREE.AmbientLight('#ffffff', 0.6);
  private sun = new THREE.DirectionalLight('#ffffff', 0.9);
  private swingT = -1;
  private throwT = -1;
  private sword!: THREE.Group;
  private spear = new THREE.Group();
  private dodgeT = -1;
  private blockK = 0;
  private hurtT = -1;
  private landT = -1;
  private landK = 0;
  /** the champion's vertical speed (m/s): the arms lag behind a jump */
  vy = 0;
  private bobT = 0;
  torchOn = false;
  dragging = false;
  visible = true;

  constructor() {
    this.scene.add(this.ambient, this.sun);
    this.sun.position.set(0.5, 1, 0.3);
    this.scene.add(this.camera);
    // right arm: forearm + bronze khopesh
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.38), mat('#b07a54'));
    arm.position.set(0, 0, 0.12);
    const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.12), mat('#b02a20'));
    sleeve.position.set(0, 0, 0.3);
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.13, 6), mat('#4a3220'));
    grip.position.set(0, 0.05, -0.08);
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.03), mat('#c89a4a', 0.05));
    guard.position.set(0, 0.12, -0.08);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.36, 0.05), mat('#d0a050', 0.08));
    blade.position.set(0, 0.3, -0.08);
    const hook = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.06, 0.16), mat('#d0a050', 0.08));
    hook.position.set(0, 0.47, -0.02);
    const swordPivot = new THREE.Group();
    swordPivot.add(grip, guard, blade, hook);
    swordPivot.rotation.x = -0.25;
    this.right.add(arm, sleeve, swordPivot);
    this.sword = swordPivot;
    // a spear, shown while throwing: held overhand along the forearm, point forward
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 1.5, 6), mat('#7a5634'));
    shaft.rotation.x = Math.PI / 2;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.14, 6), mat('#d0a050', 0.08));
    tip.rotation.x = -Math.PI / 2;
    tip.position.z = -0.82;
    this.spear.add(shaft, tip);
    this.spear.position.set(0, 0.05, -0.2);
    this.spear.visible = false;
    this.right.add(this.spear);
    this.right.position.set(0.34, -0.34, -0.5);
    this.right.scale.setScalar(0.8);
    this.camera.add(this.right);
    // left arm: shield or torch
    const larm = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.34), mat('#b07a54'));
    larm.position.set(0, 0, 0.12);
    this.left.add(larm);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.03, 18), mat('#7a4a28'));
    disc.rotation.x = Math.PI / 2;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.016, 6, 24), mat('#c89a4a', 0.05));
    const boss = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 6), mat('#c89a4a', 0.05));
    boss.position.z = -0.02;
    this.shield.add(disc, rim, boss);
    this.shield.position.set(0.04, 0.02, -0.05);
    this.left.add(this.shield);
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 0.4, 6), mat('#5a3a20'));
    stick.position.y = 0.12;
    const wrap = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.03, 0.08, 6), mat('#3a2a1a'));
    wrap.position.y = 0.3;
    this.flame = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.16, 7), mat('#ffb040', 1.4));
    this.flame.position.y = 0.4;
    this.torch.add(stick, wrap, this.flame);
    this.torch.visible = false;
    this.left.add(this.torch);
    // rope coil over the shoulder while dragging
    const ropeMesh = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.012, 5, 14), mat('#b89a60'));
    this.rope.add(ropeMesh);
    this.rope.visible = false;
    this.left.add(this.rope);
    this.left.position.set(-0.4, -0.4, -0.5);
    this.left.scale.setScalar(0.85);
    this.camera.add(this.left);
  }

  setAspect(a: number) {
    this.camera.aspect = a;
    this.camera.updateProjectionMatrix();
  }

  swing() {
    this.swingT = 0;
  }
  throwSpear() {
    this.throwT = 0;
    this.swingT = -1;
  }
  dodge() {
    this.dodgeT = 0;
  }
  hurt() {
    this.hurtT = 0;
  }
  land(impact: number) {
    this.landT = 0;
    this.landK = Math.min(1, impact / 7);
  }

  /** Where the torch flame is, in view space (for the light). */
  update(dt: number, t: number, moveSpeed: number, sprinting: boolean, blocking: boolean, lightLevel: number) {
    this.ambient.intensity = 0.25 + 0.5 * lightLevel + (this.torchOn ? 0.25 : 0);
    this.sun.intensity = 0.3 + 0.7 * lightLevel;
    this.torch.visible = this.torchOn;
    this.shield.visible = !this.torchOn;
    this.rope.visible = this.dragging;
    this.blockK += ((blocking && !this.torchOn ? 1 : 0) - this.blockK) * Math.min(1, dt * 14);
    const moving = moveSpeed > 0.5;
    this.bobT += dt * (moving ? (sprinting ? 13 : 8.5) : 1.5);
    const bobA = moving ? (sprinting ? 0.022 : 0.012) : 0.004;
    const bx = Math.sin(this.bobT * 0.5) * bobA;
    let by = -Math.abs(Math.cos(this.bobT * 0.5)) * bobA;
    // arms trail a jump (up when falling, down when rising), then dip on landing
    by += Math.max(-0.04, Math.min(0.04, -this.vy * 0.006));
    if (this.landT >= 0) {
      this.landT += dt / 0.25;
      if (this.landT >= 1) this.landT = -1;
      else by -= Math.sin(this.landT * Math.PI) * 0.05 * this.landK;
    }
    // right arm and sword
    let rx = 0, ry = 0, rz = 0, px = 0.34 + bx, py = -0.34 + by, pz = -0.5;
    if (this.swingT >= 0) {
      this.swingT += dt / 0.35;
      const k = this.swingT;
      if (k >= 1) this.swingT = -1;
      else if (k < 0.25) {
        const a = k / 0.25;
        ry = 0.9 * a;
        rz = -0.6 * a;
        px += 0.06 * a;
        py += 0.08 * a;
      } else {
        const a = Math.min(1, (k - 0.25) / 0.45);
        const e = 1 - Math.pow(1 - a, 3);
        ry = 0.9 - 2.3 * e;
        rz = -0.6 + 1.2 * e;
        rx = -0.6 * Math.sin(e * Math.PI);
        px += 0.06 - 0.38 * e;
        py += 0.08 - 0.12 * e;
        if (k > 0.7) {
          const b = (k - 0.7) / 0.3;
          ry = -1.4 * (1 - b);
          rz = 0.6 * (1 - b);
          px += 0.32 * b;
          py += 0.04 * b;
        }
      }
    }
    // throw: draw the spear back over the shoulder, then cast it
    this.spear.visible = this.throwT >= 0 && this.throwT < 0.55;
    this.sword.visible = this.throwT < 0;
    if (this.throwT >= 0) {
      this.throwT += dt / 0.6;
      const k = this.throwT;
      if (k >= 1) this.throwT = -1;
      else if (k < 0.4) {
        const a = Math.sin((k / 0.4) * Math.PI * 0.5);
        py += 0.22 * a;
        pz += 0.22 * a;
        px -= 0.04 * a;
        rx = 0.35 * a;
      } else {
        const a = Math.min(1, (k - 0.4) / 0.2);
        py += 0.22 - 0.3 * a;
        pz += 0.22 - 0.5 * a;
        rx = 0.35 - 0.7 * a;
        if (k > 0.6) py -= 0.3 * ((k - 0.6) / 0.4) * (1 - (k - 0.6) / 0.4);
      }
      ry = -0.25;
      rz = 0.2;
    }
    this.right.position.set(px, py, pz);
    this.right.rotation.set(rx - 0.15, ry + 0.25, rz - 0.2);
    // left: shield block or torch
    const lb = this.blockK;
    this.left.position.set(-0.4 + bx + 0.26 * lb, -0.4 + by + 0.24 * lb, -0.5 + 0.05 * lb);
    this.left.rotation.set(0.1 + 0.2 * lb, 0.35 - 0.3 * lb, 0);
    if (this.torchOn) {
      this.left.position.set(-0.32 + bx, -0.3 + by, -0.52);
      this.left.rotation.set(0.25, 0, 0.1);
      this.flame.scale.setScalar(1 + Math.sin(t * 23) * 0.08 + Math.sin(t * 37) * 0.05);
    }
    // dodge dip
    let dip = 0;
    if (this.dodgeT >= 0) {
      this.dodgeT += dt / 0.3;
      if (this.dodgeT >= 1) this.dodgeT = -1;
      else dip = Math.sin(this.dodgeT * Math.PI) * 0.06;
    }
    this.camera.position.y = -dip;
    let shake = 0;
    if (this.hurtT >= 0) {
      this.hurtT += dt / 0.2;
      if (this.hurtT >= 1) this.hurtT = -1;
      else shake = (1 - this.hurtT) * 0.02;
    }
    this.camera.position.x = (Math.random() - 0.5) * shake;
    this.scene.visible = this.visible;
  }

  render(r: THREE.WebGLRenderer) {
    if (!this.visible) return;
    r.autoClear = false;
    r.clearDepth();
    r.render(this.scene, this.camera);
  }
}
