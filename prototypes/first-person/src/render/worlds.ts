// The other worlds in Monster Island's sky. The barriers that kept the realities apart have failed, and the island
// looks out on its neighbours: each one hangs where it always hangs, turns slowly and is lit by its own sun, not by
// the island's. They're drawn as camera-facing quads at a fixed distance from the eye; the fragment shader paints a
// lit sphere (with rings, haze, lava or city lights) in each. Bright and solid at night, washed into the blue by day
// like a daytime moon.
import * as THREE from 'three';

interface WorldDef {
  name: string;
  /** degrees: azimuth (0 = +x, 90 = +z) and elevation above the horizon */
  az: number;
  el: number;
  /** angular radius in degrees (the real moon is about 0.25: these are much closer than physics allows) */
  size: number;
  kind: number;
  /** this world's own sun, in the quad's frame: x right, y up, z toward the island */
  light: [number, number, number];
  /** degrees: the spin axis leans this far in the picture, and the rings with it */
  tilt: number;
  /** surface turns per real minute */
  spin: number;
  a: string;
  b: string;
  c: string;
  atmo: string;
  /** ring inner and outer radius in world radii (0 = none) */
  rings?: [number, number];
}

// kind: 0 banded giant, 1 ocean world with lit coasts, 2 ember world, 3 bone moon
export const WORLDS: WorldDef[] = [
  // the great ringed giant low over the island; at night its glow is the island's moonlight
  { name: 'the Great World', az: -62, el: 24, size: 17, kind: 0, light: [-0.92, 0.3, 0.12], tilt: -18, spin: 0.25,
    a: '#3fb0b0', b: '#6a4c9c', c: '#e8c890', atmo: '#7fe0e0', rings: [1.35, 2.25] },
  // teal seas and rust-red land under its own white clouds; someone keeps fires burning on its night side
  { name: 'the Deep', az: -150, el: 46, size: 5.2, kind: 1, light: [0.85, 0.4, 0.2], tilt: 12, spin: 0.6,
    a: '#16707a', b: '#a8482c', c: '#f4f0ff', atmo: '#9ae8e0' },
  // black rock split by rivers of fire, and lit from within as much as by its sun
  { name: 'the Furnace', az: 160, el: 32, size: 3.4, kind: 2, light: [0.2, 0.8, 0.55], tilt: 25, spin: 0.9,
    a: '#1a1212', b: '#ff5a1a', c: '#ffc040', atmo: '#ff6a30' },
  // a small pale world of craters, high overhead
  { name: 'the Pale', az: -100, el: 70, size: 2.1, kind: 3, light: [-0.3, -0.5, 0.8], tilt: 0, spin: 0.1,
    a: '#e2d6dc', b: '#8a7c8e', c: '#ffffff', atmo: '#d8c8ff' },
];

const DIST = 1100;

/** unit vector toward a world (or any az/el in degrees) */
export function skyDir(az: number, el: number, out = new THREE.Vector3()) {
  const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180;
  return out.set(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e));
}

const VERT = `
  varying vec2 vUv; varying vec3 vDir;
  uniform float pad;
  void main(){
    vUv = uv * 2.0 - 1.0;
    vUv *= pad;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vDir = w.xyz - cameraPosition;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

const FRAG = `
  uniform int kind; uniform vec3 light; uniform float tilt; uniform float spin; uniform float time;
  uniform vec3 ca; uniform vec3 cb; uniform vec3 cc; uniform vec3 atmo; uniform vec2 rings;
  uniform float day; uniform vec3 skyCol; uniform vec3 hazeCol;
  varying vec2 vUv; varying vec3 vDir;

  float h3(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float vn3(vec3 p){
    vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(h3(i), h3(i + vec3(1,0,0)), f.x), mix(h3(i + vec3(0,1,0)), h3(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(h3(i + vec3(0,0,1)), h3(i + vec3(1,0,1)), f.x), mix(h3(i + vec3(0,1,1)), h3(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm3(vec3 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vn3(p); p = p * 2.07 + 13.3; a *= 0.5; } return s; }
  vec2 rot(vec2 v, float a){ float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }

  // the surface: base color and self-lit glow at a point on the unit sphere (in the world's own turning frame)
  void surface(vec3 s, out vec3 col, out vec3 glow){
    glow = vec3(0.0);
    if (kind == 0) {
      // bands that wander, a second fbm layer for streaks, and one great storm eye
      float w = fbm3(s * vec3(2.0, 0.6, 2.0)) * 0.9;
      float lat = s.y * 7.0 + w * 2.2;
      float band = sin(lat) * 0.5 + 0.5;
      float fine = sin(lat * 3.7 + fbm3(s * 6.0) * 3.0) * 0.5 + 0.5;
      col = mix(ca, cb, band);
      col = mix(col, cc, smoothstep(0.55, 0.95, fine) * 0.35);
      vec3 eye = normalize(vec3(0.55, -0.32, 0.77));
      float e = distance(s, eye);
      float swirl = sin(e * 40.0 - atan(s.z - eye.z, s.x - eye.x) * 2.0) * 0.5 + 0.5;
      col = mix(col, mix(cc, vec3(0.85, 0.35, 0.3), 0.5), smoothstep(0.2, 0.05, e) * (0.6 + 0.4 * swirl));
    } else if (kind == 1) {
      float land = fbm3(s * 2.4);
      float cloud = fbm3(s * 4.5 + vec3(time * 0.01, 0.0, 0.0));
      float isLand = smoothstep(0.52, 0.55, land);
      col = mix(ca * (0.7 + 0.5 * fbm3(s * 9.0)), cb * (0.8 + 0.4 * fbm3(s * 12.0)), isLand);
      col = mix(col, vec3(0.92, 0.9, 0.82), smoothstep(0.82, 0.92, abs(s.y))); // ice caps
      // pinpricks of fire along the coasts: somebody lives there
      float coast = isLand * smoothstep(0.62, 0.55, land);
      float town = step(0.9, h3(floor(s * 70.0))) * coast;
      glow = vec3(1.0, 0.72, 0.38) * town * 1.4;
      col = mix(col, cc, smoothstep(0.55, 0.75, cloud) * 0.85);
      glow *= 1.0 - smoothstep(0.55, 0.7, cloud);
    } else if (kind == 2) {
      float n = fbm3(s * 3.0);
      float cracks = 1.0 - smoothstep(0.0, 0.05, abs(fbm3(s * 2.2 + 7.0) - 0.5));
      cracks = max(cracks, 1.0 - smoothstep(0.0, 0.03, abs(fbm3(s * 5.0 + 3.0) - 0.5)));
      col = ca * (0.6 + 0.8 * n);
      float pulse = 0.8 + 0.2 * sin(time * 0.7 + n * 12.0);
      glow = mix(cb, cc, cracks * n) * cracks * 2.2 * pulse + cb * 0.08;
    } else {
      float n = fbm3(s * 5.0);
      col = mix(cb, ca, n);
      // a few craters: a dark floor and a bright rim
      for (int i = 0; i < 7; i++) {
        vec3 c = normalize(vec3(h3(vec3(float(i), 1.0, 2.0)), h3(vec3(float(i), 3.0, 4.0)), h3(vec3(float(i), 5.0, 6.0))) * 2.0 - 1.0);
        float r = 0.12 + 0.2 * h3(vec3(float(i), 7.0, 8.0));
        float d = distance(s, c) / r;
        col *= 1.0 - 0.35 * smoothstep(1.0, 0.8, d);
        col += cc * 0.18 * smoothstep(0.75, 1.0, d) * smoothstep(1.15, 1.0, d);
      }
    }
  }

  float ringDensity(float r){
    if (r < rings.x || r > rings.y) return 0.0;
    float k = (r - rings.x) / (rings.y - rings.x);
    float d = 0.55 + 0.45 * sin(r * 38.0) * sin(r * 11.0 + 1.3);
    d *= smoothstep(0.0, 0.06, k) * smoothstep(1.0, 0.9, k);
    d *= 1.0 - 0.85 * smoothstep(0.52, 0.55, k) * smoothstep(0.6, 0.57, k); // the gap
    return clamp(d, 0.0, 1.0);
  }

  void main(){
    vec2 p = rot(vUv, -tilt);
    float r = length(p);
    vec3 L = normalize(light);
    L.xy = rot(L.xy, -tilt);
    vec3 col = vec3(0.0);
    float a = 0.0;
    // the ring plane leans toward the island so we see it as an ellipse
    vec3 R = normalize(vec3(0.0, 1.0, 0.5));
    float sphereZ = r < 1.0 ? sqrt(1.0 - r * r) : -1.0;

    if (r < 1.0) {
      vec3 n = vec3(p, sphereZ);
      vec3 s = n;
      s.xz = rot(s.xz, time * spin);
      vec3 base, glow;
      surface(s, base, glow);
      float lam = dot(n, L);
      float lit = smoothstep(-0.08, 0.35, lam);
      // the rings' shadow across the face
      if (rings.y > 0.0) {
        float t = -dot(n, R) / dot(L, R);
        if (t > 0.0) lit *= 1.0 - 0.7 * ringDensity(length(n + L * t));
      }
      float rim = pow(1.0 - sphereZ, 3.0);
      col = base * (0.04 + lit * 1.05) + glow * (kind == 1 ? 1.0 - smoothstep(-0.1, 0.05, lam) : 1.0 - 0.85 * lit) + atmo * rim * (0.15 + 0.85 * smoothstep(-0.3, 0.5, lam)) * 0.8;
      a = smoothstep(1.0, 0.985, r);
    }
    // a thin glowing atmosphere just outside the limb, brightest toward the world's sun
    float halo = exp(-max(r - 1.0, 0.0) * 18.0) * step(1.0, r);
    vec2 lp = normalize(L.xy + 1e-4);
    float sunSide = 0.35 + 0.65 * max(dot(normalize(p + 1e-4), lp), 0.0);
    col += atmo * halo * sunSide * 0.9;
    a = max(a, halo * sunSide * 0.8);
    if (kind == 2) { // the furnace's red corona
      float co = exp(-max(r - 1.0, 0.0) * 3.5) * step(1.0, r);
      col += atmo * co * 0.5;
      a = max(a, co * 0.45);
    }

    if (rings.y > 0.0) {
      // where the line of sight crosses the ring plane
      float z = -(p.x * R.x + p.y * R.y) / R.z;
      vec3 q = vec3(p, z);
      float rd = ringDensity(length(q));
      if (rd > 0.0 && (r >= 1.0 || z > sphereZ)) {
        float shade = 1.0;
        float b = dot(q, L), c = dot(q, q) - 1.0;
        if (b < 0.0 && b * b > c) shade = 0.12; // in the world's shadow
        vec3 rc = mix(cc, ca, 0.35 + 0.3 * sin(length(q) * 23.0)) * (0.25 + 0.85 * shade);
        float ra = rd * 0.85;
        col = mix(col, rc, ra);
        a = a + ra * (1.0 - a);
      }
    }
    if (a < 0.003) discard;
    col /= max(a, 1e-3);

    // by day the sky washes over it: the dark side vanishes and the lit side pales toward the blue
    float lum = dot(col, vec3(0.3, 0.59, 0.11));
    vec3 dayCol = mix(skyCol, col, 0.35) + vec3(0.12);
    float dayA = a * smoothstep(0.08, 0.6, lum) * 0.6;
    col = mix(col, dayCol, day);
    a = mix(a, dayA, day);
    // the air near the horizon thickens
    float el = normalize(vDir).y;
    float haze = 1.0 - smoothstep(0.0, 0.3, el);
    col = mix(col, hazeCol, haze * 0.55);
    a *= 1.0 - haze * 0.35;
    gl_FragColor = vec4(col, a);
    #include <colorspace_fragment>
  }`;

export class Worlds {
  group = new THREE.Group();
  private mats: THREE.ShaderMaterial[] = [];
  private offsets: THREE.Vector3[] = [];
  private meshes: THREE.Mesh[] = [];

  constructor() {
    for (const w of WORLDS) {
      const pad = w.rings ? w.rings[1] + 0.1 : w.kind === 2 ? 2.0 : 1.25;
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          kind: { value: w.kind },
          light: { value: new THREE.Vector3(...w.light) },
          tilt: { value: (w.tilt * Math.PI) / 180 },
          spin: { value: (w.spin * Math.PI * 2) / 60 },
          time: { value: 0 },
          ca: { value: new THREE.Color(w.a) },
          cb: { value: new THREE.Color(w.b) },
          cc: { value: new THREE.Color(w.c) },
          atmo: { value: new THREE.Color(w.atmo) },
          rings: { value: new THREE.Vector2(...(w.rings ?? [0, 0])) },
          pad: { value: pad },
          day: { value: 0 },
          skyCol: { value: new THREE.Color() },
          hazeCol: { value: new THREE.Color() },
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        fog: false,
      });
      const radius = DIST * Math.tan((w.size * Math.PI) / 180);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
      m.scale.setScalar(radius * pad);
      m.renderOrder = -8; // over the dome and the stars, under everything on the island
      m.frustumCulled = false;
      const off = skyDir(w.az, w.el).multiplyScalar(DIST);
      // the quad always faces the island: the offset never changes, so neither does the orientation
      m.lookAt(off.clone().negate());
      this.offsets.push(off);
      this.mats.push(mat);
      this.meshes.push(m);
      this.group.add(m);
    }
  }

  /** day 0..1 (how washed out), sky/haze colors to wash toward, time in seconds */
  update(eye: THREE.Vector3, day: number, sky: THREE.Color, haze: THREE.Color, time: number) {
    for (let i = 0; i < this.meshes.length; i++) {
      this.meshes[i].position.copy(eye).add(this.offsets[i]);
      const u = this.mats[i].uniforms;
      u.day.value = day;
      u.time.value = time;
      (u.skyCol.value as THREE.Color).copy(sky);
      (u.hazeCol.value as THREE.Color).copy(haze);
    }
  }
}
