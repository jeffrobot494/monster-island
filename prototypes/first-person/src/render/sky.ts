// First-person sky (spec §7.7): gradient dome, sun and moon discs, stars, and linear distance fog tied to the light.
import * as THREE from 'three';
import type { Atmosphere } from '../sim/types';

// The palette follows media/concept-art/world-mood: teal skies over golden land, long amber evenings with a pink
// band at dusk, and a deep blue (not black) night.
// [hour, zenith, horizon, sun color, sun intensity, ambient intensity, cloud cover 0..1]
const KEYS: [number, string, string, string, number, number, number][] = [
  [0, '#081428', '#1d3554', '#7f9ccc', 0.16, 0.24, 0.35],
  [4.5, '#081428', '#1d3554', '#7f9ccc', 0.16, 0.24, 0.35],
  [5.5, '#1c3858', '#806c84', '#a090c0', 0.25, 0.3, 0.4],
  [6.4, '#3c6278', '#f2a674', '#ffb070', 0.85, 0.46, 0.5],
  [8, '#3f8490', '#e4d2a6', '#ffe2aa', 1.45, 0.66, 0.4],
  [12, '#3a8a98', '#d6d8b8', '#fff0d2', 1.6, 0.7, 0.3],
  [15.5, '#3c8290', '#e2cc9a', '#ffe2a2', 1.55, 0.68, 0.4],
  [17.3, '#3e6e80', '#f2b062', '#ffb25a', 1.35, 0.58, 0.55],
  [18.4, '#34587a', '#f08a58', '#ff8a4a', 0.9, 0.46, 0.6],
  [19.4, '#22406a', '#d47a88', '#d08aa0', 0.36, 0.32, 0.5],
  [20.5, '#10213e', '#2c4a70', '#8098d0', 0.16, 0.24, 0.4],
  [24, '#081428', '#1d3554', '#7f9ccc', 0.16, 0.24, 0.35],
];

export class Sky {
  sun = new THREE.DirectionalLight(0xffffff, 1);
  ambient = new THREE.HemisphereLight(0xdfe9ff, 0x4a5a3a, 0.6);
  atmosphere: Atmosphere = {};
  night = 0;
  dome: THREE.Mesh;
  private uni = {
    top: { value: new THREE.Color() },
    bottom: { value: new THREE.Color() },
    sunDir: { value: new THREE.Vector3(0, 1, 0) },
    sunCol: { value: new THREE.Color() },
    glow: { value: 1 },
    cloudLit: { value: new THREE.Color() },
    cloudShade: { value: new THREE.Color() },
    cover: { value: 0.4 },
    time: { value: 0 },
  };
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
      // gradient + sun glow + a painted cloud layer (fbm on a plane above the eye)
      fragmentShader: `
        uniform vec3 top; uniform vec3 bottom; uniform vec3 sunDir; uniform vec3 sunCol; uniform float glow;
        uniform vec3 cloudLit; uniform vec3 cloudShade; uniform float cover; uniform float time;
        varying vec3 vP;
        float h2(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }
        float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vn(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
        void main(){
          vec3 d = normalize(vP);
          float h = clamp(d.y * 1.6 + 0.08, 0.0, 1.0);
          vec3 col = mix(bottom, top, pow(h, 0.75));
          float sd = max(dot(d, sunDir), 0.0);
          // warm bloom around the sun that spreads along the horizon
          float band = exp(-abs(d.y) * 7.0);
          col += sunCol * glow * (pow(sd, 8.0) * 0.22 + pow(sd, 60.0) * 0.5 + band * pow(sd, 2.0) * 0.25);
          if (d.y > 0.0) {
            vec2 uv = d.xz / (d.y + 0.12) * 1.3 + vec2(time * 0.004, time * 0.0015);
            float n = fbm(uv);
            float c = smoothstep(1.0 - cover, 1.0 - cover + 0.22, n) * smoothstep(0.0, 0.18, d.y);
            float lit = clamp((fbm(uv + sunDir.xz * 0.12) - n) * 6.0 + 0.5, 0.0, 1.0);
            vec3 cc = mix(cloudShade, cloudLit, lit * 0.8 + pow(sd, 3.0) * 0.4);
            col = mix(col, cc, c * 0.92);
          }
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1300, 24, 12), mat);
    this.dome.renderOrder = -10;
    this.dome.frustumCulled = false;
    scene.add(this.dome);
    this.sunDisc = new THREE.Mesh(new THREE.CircleGeometry(46, 28), new THREE.MeshBasicMaterial({ color: '#fff6d8', fog: false, depthWrite: false }));
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
    let cover = a[6] + (b[6] - a[6]) * f;
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
      cover = Math.min(0.85, cover + 0.35);
    }
    this.uni.top.value.copy(top);
    this.uni.bottom.value.copy(hor);
    (this.scene.background as THREE.Color).copy(hor);
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(at.fogColor ? this.c2.set(at.fogColor) : hor);
    // visibility: the champion's sight at night, far by day (spec §6)
    // by day a warm haze swallows the far hills, layering the island like the paintings
    let far = this.sightM * 1.15 + (620 - this.sightM * 1.15) * Math.pow(light, 1.5);
    if (at.weather === 'fog') far *= 0.35;
    if (at.fogDensity) far *= Math.max(0.2, 1 - at.fogDensity * 8);
    fog.far = far;
    fog.near = Math.min(far * 0.12, 40);
    this.sun.color.copy(sunC);
    this.sun.intensity = sunI;
    this.ambient.intensity = amb;
    // cool teal fill in the shadows against the warm sun
    this.ambient.color.copy(top).lerp(hor, 0.2).lerp(this.c2.set('#ffffff'), 0.15);
    this.ambient.groundColor.set('#9a7a50').multiplyScalar(0.45 + 0.55 * light);
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
    (this.sunDisc.material as THREE.MeshBasicMaterial).color.copy(sunC).lerp(this.c2.set('#fff4d0'), 0.6);
    const u = this.uni;
    u.sunDir.value.copy(dir); // the moon's glow at night
    u.sunCol.value.copy(sunC);
    u.glow.value = day ? Math.min(1, sunI) : 0.25;
    u.cover.value = cover;
    u.time.value = performance.now() / 1000;
    // clouds catch the sun's color on their lit side; shadowed sides lean toward the zenith
    u.cloudLit.value.copy(hor).lerp(sunC, 0.55).lerp(this.c2.set('#ffffff'), day ? 0.3 : 0.05);
    u.cloudShade.value.copy(top).lerp(hor, 0.45).multiplyScalar(day ? 0.95 : 0.8);
  }
}
