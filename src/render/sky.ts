// First-person sky (spec §7.7): gradient dome, sun and moon discs, stars, and linear distance fog tied to the light.
import * as THREE from 'three';
import type { Atmosphere } from '../sim/types';

// [hour, zenith, horizon, sun color, sun intensity, ambient intensity]
const KEYS: [number, string, string, string, number, number][] = [
  [0, '#05070f', '#141a2e', '#8090d0', 0.12, 0.16],
  [4.5, '#070a16', '#1a2038', '#8090d0', 0.12, 0.16],
  [6, '#3a4a78', '#f0a070', '#ffb07a', 0.7, 0.42],
  [7.5, '#5a92cc', '#d6e6ee', '#fff1d6', 1.6, 0.85],
  [16.5, '#5a90c8', '#d4e4ec', '#fff1d6', 1.6, 0.85],
  [18, '#3a4a80', '#f08a50', '#ff8a4a', 0.8, 0.44],
  [19.5, '#12163a', '#3a2c50', '#8088d0', 0.25, 0.22],
  [21, '#070a18', '#161c34', '#8090d0', 0.12, 0.16],
  [24, '#05070f', '#141a2e', '#8090d0', 0.12, 0.16],
];

export class Sky {
  sun = new THREE.DirectionalLight(0xffffff, 1);
  ambient = new THREE.HemisphereLight(0xdfe9ff, 0x4a5a3a, 0.6);
  atmosphere: Atmosphere = {};
  night = 0;
  dome: THREE.Mesh;
  private uni = { top: { value: new THREE.Color() }, bottom: { value: new THREE.Color() }, stars: { value: 0 } };
  private sunDisc: THREE.Mesh;
  private moonDisc: THREE.Mesh;
  private stars: THREE.Points;
  private c1 = new THREE.Color();
  private c2 = new THREE.Color();
  /** visibility radius in meters set from the champion's sight */
  sightM = 120;

  constructor(private scene: THREE.Scene) {
    scene.add(this.sun, this.sun.target, this.ambient);
    scene.background = new THREE.Color();
    scene.fog = new THREE.Fog(0x9fcbe8, 60, 900);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const c = this.sun.shadow.camera;
    c.left = -60; c.right = 60; c.top = 60; c.bottom = -60; c.near = 1; c.far = 400;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.4;
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uni,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float h = clamp(vP.y * 1.6 + 0.08, 0.0, 1.0); gl_FragColor = vec4(mix(bottom, top, pow(h, 0.7)), 1.0); }',
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1300, 24, 12), mat);
    this.dome.renderOrder = -10;
    this.dome.frustumCulled = false;
    scene.add(this.dome);
    this.sunDisc = new THREE.Mesh(new THREE.CircleGeometry(30, 20), new THREE.MeshBasicMaterial({ color: '#fff6d8', fog: false, depthWrite: false }));
    this.moonDisc = new THREE.Mesh(new THREE.CircleGeometry(22, 20), new THREE.MeshBasicMaterial({ color: '#e8ecf4', fog: false, depthWrite: false }));
    this.sunDisc.renderOrder = this.moonDisc.renderOrder = -9;
    scene.add(this.sunDisc, this.moonDisc);
    const sp = new Float32Array(1500 * 3);
    let s = 9;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 1500; i++) {
      const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2;
      const y = Math.abs(u), r = Math.sqrt(1 - y * y);
      sp.set([Math.cos(a) * r * 1200, y * 1200, Math.sin(a) * r * 1200], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: '#ffffff', size: 2, sizeAttenuation: false, fog: false, transparent: true, depthWrite: false }));
    this.stars.renderOrder = -9;
    scene.add(this.stars);
  }

  setShadows(q: 'off' | 'low' | 'high') {
    this.sun.castShadow = q !== 'off';
    const n = q === 'high' ? 2048 : 1024;
    if (this.sun.shadow.mapSize.x !== n) {
      this.sun.shadow.mapSize.set(n, n);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    }
  }

  /** hour 0..24; light 0..1 from the sim; eye = camera position (m) */
  update(hour: number, light: number, eye: THREE.Vector3) {
    let i = 0;
    while (i < KEYS.length - 2 && KEYS[i + 1][0] <= hour) i++;
    const a = KEYS[i], b = KEYS[i + 1];
    const f = Math.min(1, Math.max(0, (hour - a[0]) / (b[0] - a[0])));
    const top = this.c1.set(a[1]).lerp(this.c2.set(b[1]), f).clone();
    const hor = this.c1.set(a[2]).lerp(this.c2.set(b[2]), f).clone();
    const sunC = this.c1.set(a[3]).lerp(this.c2.set(b[3]), f).clone();
    let sunI = a[4] + (b[4] - a[4]) * f;
    let amb = a[5] + (b[5] - a[5]) * f;
    const clockLight = hour >= 7 && hour <= 17 ? 1 : hour >= 19 || hour <= 5 ? 0 : hour < 7 ? (hour - 5) / 2 : (19 - hour) / 2;
    const extra = light - clockLight;
    if (Math.abs(extra) > 0.02) {
      sunI = Math.max(0.12, sunI + extra * 0.9);
      amb = Math.max(0.14, amb + extra * 0.4);
      const tint = this.c2.set(extra < 0 ? '#120c18' : '#4a5a88');
      top.lerp(tint, Math.min(0.85, Math.abs(extra)));
      hor.lerp(tint, Math.min(0.7, Math.abs(extra)));
    }
    this.night = 1 - light;
    const at = this.atmosphere;
    if (at.skyTint) {
      top.lerp(this.c2.set(at.skyTint), 0.5);
      hor.lerp(this.c2.set(at.skyTint), 0.5);
    }
    if (at.lightTint) sunC.multiply(this.c2.set(at.lightTint));
    if (at.weather === 'rain' || at.weather === 'fog' || at.weather === 'ash') {
      const w = this.c2.set(at.weather === 'rain' ? '#6a7480' : at.weather === 'ash' ? '#5a504a' : '#9aa890');
      top.lerp(w, 0.5);
      hor.lerp(w, 0.6);
      sunI *= 0.65;
    }
    this.uni.top.value.copy(top);
    this.uni.bottom.value.copy(hor);
    this.uni.stars.value = this.night;
    (this.scene.background as THREE.Color).copy(hor);
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(at.fogColor ? this.c2.set(at.fogColor) : hor);
    // visibility: the champion's sight at night, far by day (spec §6)
    let far = this.sightM * 1.15 + (900 - this.sightM * 1.15) * Math.pow(light, 1.5);
    if (at.weather === 'fog') far *= 0.35;
    if (at.fogDensity) far *= Math.max(0.2, 1 - at.fogDensity * 8);
    fog.far = far;
    fog.near = Math.min(far * 0.25, 60);
    this.sun.color.copy(sunC);
    this.sun.intensity = sunI;
    this.ambient.intensity = amb;
    this.ambient.color.copy(top).lerp(this.c2.set('#ffffff'), 0.6);
    this.ambient.groundColor.set('#8a8068').multiplyScalar(0.45 + 0.55 * light);
    // sun or moon direction; the shadow-casting light follows the eye
    const day = hour >= 6 && hour < 18;
    const phase = day ? (hour - 6) / 12 : ((hour + 6) % 24) / 12;
    const ang = Math.PI * (0.08 + 0.84 * phase);
    const dir = new THREE.Vector3(Math.cos(ang), Math.sin(ang), 0.35).normalize();
    const snap = (v: number) => Math.round(v / 4) * 4;
    this.sun.position.set(snap(eye.x) + dir.x * 200, eye.y + dir.y * 200, snap(eye.z) + dir.z * 200);
    this.sun.target.position.set(snap(eye.x), eye.y, snap(eye.z));
    this.dome.position.copy(eye);
    this.stars.position.copy(eye);
    (this.stars.material as THREE.PointsMaterial).opacity = Math.max(0, this.night - 0.3) * 1.4;
    this.stars.visible = this.night > 0.3;
    const sdir = day ? dir : dir.clone().multiplyScalar(-1).setY(-1);
    this.sunDisc.position.copy(eye).addScaledVector(dir, 1100);
    this.sunDisc.lookAt(eye);
    this.sunDisc.visible = day && dir.y > -0.05;
    this.moonDisc.position.copy(eye).addScaledVector(dir, 1100);
    this.moonDisc.lookAt(eye);
    this.moonDisc.visible = !day;
    void sdir;
    (this.sunDisc.material as THREE.MeshBasicMaterial).color.copy(sunC).lerp(this.c2.set('#ffffff'), 0.5);
  }
}
