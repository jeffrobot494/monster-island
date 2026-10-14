// First-person sky (spec §7.7): gradient dome, the sun, the other worlds (worlds.ts), stars, a cloud shell, and linear
// distance fog tied to the light.
// Monster Island isn't under Earth's sky. The barriers between the realities have failed: other worlds hang over the
// island, a river of foreign stars crosses the night, and thin bright seams mark where the barriers tore. There's no
// moon; by night the island is lit by the glow of the Great World.
import * as THREE from 'three';
import type { Atmosphere } from '../sim/types';
import { Worlds, WORLDS, skyDir } from './worlds';

// The day palette follows media/concept-art/world-mood: teal skies over golden land and long amber evenings. The
// twilights are not Earth's: a violet and then a sea-green dawn, a magenta dusk with a teal afterglow, and an indigo
// night.
// [hour, zenith, horizon, sun color, sun intensity, ambient intensity, cloud cover 0..1]
const KEYS: [number, string, string, string, number, number, number][] = [
  [0, '#070a24', '#1e2550', '#7fb4cc', 0.18, 0.24, 0.3],
  [4.4, '#070a24', '#1e2550', '#7fb4cc', 0.18, 0.24, 0.3],
  [5.2, '#16164a', '#5a3a78', '#a08ad0', 0.22, 0.28, 0.35],
  [5.8, '#1e3c62', '#3fa59a', '#90d0c0', 0.4, 0.34, 0.4],
  [6.4, '#3c6278', '#f2a674', '#ffb070', 0.85, 0.46, 0.5],
  [8, '#3f8490', '#e4d2a6', '#ffe2aa', 1.45, 0.66, 0.4],
  [12, '#3a8a98', '#d6d8b8', '#fff0d2', 1.6, 0.7, 0.3],
  [15.5, '#3c8290', '#e2cc9a', '#ffe2a2', 1.55, 0.68, 0.4],
  [17.3, '#3e6e80', '#f2b062', '#ffb25a', 1.35, 0.58, 0.55],
  [18.4, '#34587a', '#f08a58', '#ff8a4a', 0.9, 0.46, 0.6],
  [19.2, '#2a2464', '#d8508e', '#e070a8', 0.4, 0.34, 0.5],
  [19.9, '#161c4a', '#2f8a8a', '#80c8c0', 0.24, 0.28, 0.45],
  [20.8, '#0a0e2c', '#22285a', '#7fb4cc', 0.18, 0.24, 0.35],
  [24, '#070a24', '#1e2550', '#7fb4cc', 0.18, 0.24, 0.3],
];

/** the light the clock alone gives (the sim's `light` also carries eclipses and second moons) */
export function clockLight(hour: number) {
  return hour >= 7 && hour <= 17 ? 1 : hour >= 19 || hour <= 5 ? 0 : hour < 7 ? (hour - 5) / 2 : (19 - hour) / 2;
}

const NOISE = `
  float h2(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }
  float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vn(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
  float h3(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float vn3(vec3 p){
    vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(h3(i), h3(i + vec3(1,0,0)), f.x), mix(h3(i + vec3(0,1,0)), h3(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(h3(i + vec3(0,0,1)), h3(i + vec3(1,0,1)), f.x), mix(h3(i + vec3(0,1,1)), h3(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm3(vec3 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vn3(p); p = p * 2.07 + 13.3; a *= 0.5; } return s; }
`;

const UNIFORMS = `
  uniform vec3 top; uniform vec3 bottom; uniform vec3 sunDir; uniform vec3 sunCol; uniform float glow;
  uniform vec3 lightDir; uniform vec3 cloudLit; uniform vec3 cloudShade; uniform float cover; uniform float time;
  uniform float night; uniform vec3 worldDir; uniform vec3 worldCol;
  varying vec3 vP;
`;

const VERT = 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }';

export class Sky {
  sun = new THREE.DirectionalLight(0xffffff, 1);
  ambient = new THREE.HemisphereLight(0xdfe9ff, 0x4a5a3a, 0.6);
  atmosphere: Atmosphere = {};
  night = 0;
  dome: THREE.Mesh;
  worlds = new Worlds();
  private uni = {
    top: { value: new THREE.Color() },
    bottom: { value: new THREE.Color() },
    sunDir: { value: new THREE.Vector3(0, 1, 0) },
    sunCol: { value: new THREE.Color() },
    glow: { value: 1 },
    lightDir: { value: new THREE.Vector3(0, 1, 0) },
    cloudLit: { value: new THREE.Color() },
    cloudShade: { value: new THREE.Color() },
    cover: { value: 0.4 },
    time: { value: 0 },
    night: { value: 0 },
    worldDir: { value: new THREE.Vector3() },
    worldCol: { value: new THREE.Color(WORLDS[0].atmo) },
  };
  private clouds: THREE.Mesh;
  private sunDisc: THREE.Mesh;
  private stars: THREE.Points;
  private starUni = { time: { value: 0 }, opacity: { value: 0 } };
  /** toward the Great World, whose glow lights the night */
  private worldDir = skyDir(WORLDS[0].az, WORLDS[0].el);
  private c1 = new THREE.Color();
  private c2 = new THREE.Color();
  private sunDir = new THREE.Vector3();
  private lightDir = new THREE.Vector3();
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
    this.uni.worldDir.value.copy(this.worldDir);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uni,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: VERT,
      // gradient + sun glow, and by night the star river, the seams and the Great World's glow
      fragmentShader: `
        ${UNIFORMS}
        ${NOISE}
        // a seam where the barrier between the realities tore: a thin wavering line of shifting color across part
        // of a great circle (n: the circle's plane, c: the middle of the seam, len: half its length in radians)
        vec3 seam(vec3 d, vec3 n, vec3 c, float len, float seed){
          n = normalize(n); c = normalize(c - n * dot(c, n));
          vec3 b = cross(n, c);
          float along = atan(dot(d, b), dot(d, c));
          float span = smoothstep(len, len * 0.5, abs(along)) * step(abs(along), len);
          float off = dot(d, n) + (vn(vec2(along * 7.0, seed)) - 0.5) * 0.035 + (vn(vec2(along * 31.0, seed + 3.0)) - 0.5) * 0.006;
          float core = exp(-off * off / 0.000005);
          float halo = exp(-off * off / 0.0004);
          vec3 irid = 0.6 + 0.3 * cos(6.2832 * (along * 1.3 + vec3(0.0, 0.33, 0.67) + time * 0.015 + seed));
          float shimmer = 0.6 + 0.4 * vn(vec2(along * 18.0 - time * 0.6, seed));
          return irid * (core * 0.8 + halo * 0.14) * span * shimmer;
        }
        void main(){
          vec3 d = normalize(vP);
          float h = clamp(d.y * 1.6 + 0.08, 0.0, 1.0);
          vec3 col = mix(bottom, top, pow(h, 0.75));
          float sd = max(dot(d, sunDir), 0.0);
          // warm bloom around the sun that spreads along the horizon
          float band = exp(-abs(d.y) * 7.0);
          col += sunCol * glow * (pow(sd, 8.0) * 0.22 + pow(sd, 60.0) * 0.5 + band * pow(sd, 2.0) * 0.25);
          float up = smoothstep(-0.02, 0.12, d.y);
          // the star river: violet and teal dust with dark lanes, tilted across the night
          vec3 nb = normalize(vec3(0.35, 0.45, -0.82));
          float bd = dot(d, nb);
          float dust = fbm3(d * 3.2 + 5.0);
          float lanes = smoothstep(0.42, 0.62, fbm3(d * 7.0 + 11.0));
          float river = exp(-bd * bd * 12.0) * smoothstep(0.3, 0.8, dust) * (1.0 - 0.7 * lanes);
          vec3 riverCol = mix(vec3(0.62, 0.22, 0.7), vec3(0.15, 0.62, 0.66), smoothstep(0.35, 0.7, fbm3(d * 1.7 + 2.0)));
          col += riverCol * river * 0.32 * night * up;
          // the Great World's light scattered through the air around it
          float wd = max(dot(d, worldDir), 0.0);
          col += worldCol * (pow(wd, 10.0) * 0.28 + band * pow(wd, 3.0) * 0.12) * night;
          // the seams: faint by day, bright at night
          vec3 s = seam(d, vec3(0.2, 0.3, 1.0), vec3(1.0, 0.8, -0.1), 0.9, 1.0)
                 + seam(d, vec3(-0.9, 0.35, 0.25), vec3(0.1, 0.5, -0.9), 0.6, 4.0)
                 + seam(d, vec3(0.45, 0.6, -0.6), vec3(-0.6, 0.7, -0.2), 0.45, 7.0);
          col += s * mix(0.08, 0.24, night) * up;
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1300, 32, 16), mat);
    this.dome.renderOrder = -10;
    this.dome.frustumCulled = false;
    scene.add(this.dome);
    this.sunDisc = new THREE.Mesh(new THREE.CircleGeometry(46, 28), new THREE.MeshBasicMaterial({ color: '#fff6d8', fog: false, depthWrite: false }));
    this.sunDisc.renderOrder = -9;
    scene.add(this.sunDisc);
    this.stars = this.makeStars();
    this.stars.renderOrder = -9;
    scene.add(this.stars);
    this.worlds.group.renderOrder = -8;
    scene.add(this.worlds.group);
    // a painted cloud layer (fbm on a plane above the eye), on its own shell so it passes in front of the sun and
    // the worlds
    const cloudMat = new THREE.ShaderMaterial({
      uniforms: this.uni,
      side: THREE.BackSide,
      depthWrite: false,
      transparent: true,
      fog: false,
      vertexShader: VERT,
      fragmentShader: `
        ${UNIFORMS}
        ${NOISE}
        void main(){
          vec3 d = normalize(vP);
          if (d.y <= 0.0) discard;
          vec2 uv = d.xz / (d.y + 0.12) * 1.3 + vec2(time * 0.004, time * 0.0015);
          float n = fbm(uv);
          float c = smoothstep(1.0 - cover, 1.0 - cover + 0.22, n) * smoothstep(0.0, 0.18, d.y);
          if (c < 0.004) discard;
          float lit = clamp((fbm(uv + lightDir.xz * 0.12) - n) * 6.0 + 0.5, 0.0, 1.0);
          float sd = max(dot(d, lightDir), 0.0);
          vec3 cc = mix(cloudShade, cloudLit, lit * 0.8 + pow(sd, 3.0) * 0.4);
          gl_FragColor = vec4(cc, c * 0.92);
          #include <colorspace_fragment>
        }`,
    });
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(1250, 32, 16), cloudMat);
    this.clouds.renderOrder = -7;
    this.clouds.frustumCulled = false;
    scene.add(this.clouds);
  }

  /** colored, twinkling stars: an even scatter plus a crowd along the star river */
  private makeStars() {
    const N = 4200, RIVER = 1600;
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N), phase = new Float32Array(N);
    let s = 9;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const tints = ['#ffffff', '#cfe0ff', '#ffe6b0', '#ffb8c8', '#a8fff0', '#d8b8ff'].map((c) => new THREE.Color(c));
    const nb = new THREE.Vector3(0.35, 0.45, -0.82).normalize();
    const v = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
      if (i < N - RIVER) {
        const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2;
        const y = Math.abs(u), r = Math.sqrt(1 - y * y);
        v.set(Math.cos(a) * r, y, Math.sin(a) * r);
      } else {
        // near the river's plane
        for (;;) {
          v.set(rnd() * 2 - 1, rnd(), rnd() * 2 - 1).normalize();
          const d = v.dot(nb);
          if (Math.abs(d) < 0.12 * Math.sqrt(-Math.log(rnd() + 1e-6))) break;
        }
      }
      pos.set([v.x * 1200, v.y * 1200, v.z * 1200], i * 3);
      const t = tints[Math.floor(rnd() * rnd() * tints.length)];
      col.set([t.r, t.g, t.b], i * 3);
      const big = rnd();
      size[i] = 1.2 + big * big * big * 3.2;
      phase[i] = rnd() * 6.28;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('size', new THREE.BufferAttribute(size, 1));
    g.setAttribute('phase', new THREE.BufferAttribute(phase, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: this.starUni,
      transparent: true,
      depthWrite: false,
      fog: false,
      vertexShader: `
        attribute float size; attribute float phase;
        uniform float time; uniform float opacity;
        varying vec3 vC; varying float vA;
        void main(){
          vC = color;
          float tw = 0.7 + 0.3 * sin(time * (1.3 + phase * 0.4) + phase * 20.0);
          vA = opacity * tw * smoothstep(0.0, 0.15, normalize(position).y);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size;
        }`,
      fragmentShader: `
        varying vec3 vC; varying float vA;
        void main(){
          float d = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(vC, vA * smoothstep(0.5, 0.15, d));
          #include <colorspace_fragment>
        }`,
      vertexColors: true,
    });
    const p = new THREE.Points(g, mat);
    p.frustumCulled = false;
    return p;
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
    const extra = light - clockLight(hour);
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
    const weather = at.weather === 'rain' || at.weather === 'fog' || at.weather === 'ash';
    if (weather) {
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
    // The sun climbs from the east (+x) at 05:00, peaks at noon and is gone below the west by 19:00. By day the light
    // comes from the sun; through the twilights it swings over to the Great World, which lights the night. The
    // shadow-casting light follows the eye.
    const ang = Math.PI * (0.08 + (0.84 * (hour - 6)) / 12);
    const sunDir = this.sunDir.set(Math.cos(ang), Math.sin(ang), 0.35).normalize();
    const toWorld = hour >= 12 ? THREE.MathUtils.smoothstep(hour, 18.2, 19.6) : 1 - THREE.MathUtils.smoothstep(hour, 4.6, 6.0);
    const dir = this.lightDir.copy(sunDir).lerp(this.worldDir, toWorld).normalize();
    const snap = (v: number) => Math.round(v / 4) * 4;
    this.sun.position.set(snap(eye.x) + dir.x * 200, eye.y + dir.y * 200, snap(eye.z) + dir.z * 200);
    this.sun.target.position.set(snap(eye.x), eye.y, snap(eye.z));
    this.dome.position.copy(eye);
    this.clouds.position.copy(eye);
    this.stars.position.copy(eye);
    const starA = Math.min(1, Math.max(0, (this.night - 0.25) * 1.6));
    this.starUni.opacity.value = starA;
    this.starUni.time.value = performance.now() / 1000;
    this.stars.visible = starA > 0;
    this.sunDisc.position.copy(eye).addScaledVector(sunDir, 1100);
    this.sunDisc.lookAt(eye);
    this.sunDisc.visible = sunDir.y > -0.06;
    (this.sunDisc.material as THREE.MeshBasicMaterial).color.copy(sunC).lerp(this.c2.set('#fff4d0'), 0.6);
    const u = this.uni;
    u.sunDir.value.copy(sunDir);
    u.sunCol.value.copy(sunC);
    u.glow.value = Math.min(1, sunI) * THREE.MathUtils.smoothstep(sunDir.y, -0.25, 0.02);
    u.lightDir.value.copy(dir);
    u.cover.value = cover;
    u.time.value = performance.now() / 1000;
    u.night.value = THREE.MathUtils.smoothstep(this.night, 0.15, 0.9) * (weather ? 0.35 : 1);
    // clouds catch the light's color on their lit side; shadowed sides lean toward the zenith
    const day = 1 - toWorld;
    u.cloudLit.value.copy(hor).lerp(sunC, 0.55).lerp(this.c2.set('#ffffff'), 0.05 + 0.25 * day);
    u.cloudShade.value.copy(top).lerp(hor, 0.45).multiplyScalar(0.8 + 0.15 * day);
    // the worlds wash out by day and behind weather
    const sky = this.c1.copy(top).lerp(hor, 0.35);
    this.worlds.update(eye, Math.max(light, weather ? 0.8 : 0), sky, hor, performance.now() / 1000);
  }
}
