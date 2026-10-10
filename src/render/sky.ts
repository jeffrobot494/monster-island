import * as THREE from 'three';
import type { Atmosphere } from '../sim/types';
import { DUSK_TICK, TICKS_PER_DAY } from '../sim/time';

// [dayTick, sky, sun color, sun intensity, ambient intensity]
const KEYS: [number, string, string, number, number][] = [
  [0, '#f2b38a', '#ffc28a', 0.7, 0.5],
  [150, '#a9d4ef', '#fff1d6', 1.15, 0.65],
  [1000, '#9fcbe8', '#fff1d6', 1.15, 0.65],
  [1170, '#f0a070', '#ff9a5a', 0.8, 0.5],
  [1260, '#3a3f6e', '#8a90d0', 0.5, 0.42],
  [1350, '#1c2444', '#8090d8', 0.45, 0.4],
  [1740, '#222a4a', '#8090d8', 0.45, 0.4],
  [1800, '#f2b38a', '#ffc28a', 0.7, 0.5],
];

export class Sky {
  sun = new THREE.DirectionalLight(0xffffff, 1);
  ambient = new THREE.HemisphereLight(0xdfe9ff, 0x4a5a3a, 0.6);
  atmosphere: Atmosphere = {};
  night = 0;
  private c1 = new THREE.Color();
  private c2 = new THREE.Color();

  constructor(private scene: THREE.Scene) {
    scene.add(this.sun, this.sun.target, this.ambient);
    scene.background = new THREE.Color();
    scene.fog = new THREE.FogExp2(0x9fcbe8, 0.006);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const c = this.sun.shadow.camera;
    c.left = -40; c.right = 40; c.top = 40; c.bottom = -40; c.near = 1; c.far = 160;
    this.sun.shadow.bias = -0.0008;
  }

  update(tickF: number) {
    const dt = ((tickF % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY;
    let i = 0;
    while (i < KEYS.length - 2 && KEYS[i + 1][0] <= dt) i++;
    const a = KEYS[i], b = KEYS[i + 1];
    const f = (dt - a[0]) / (b[0] - a[0]);
    const sky = this.c1.set(a[1]).lerp(this.c2.set(b[1]), f).clone();
    const sunC = this.c1.set(a[2]).lerp(this.c2.set(b[2]), f).clone();
    let sunI = a[3] + (b[3] - a[3]) * f;
    const amb = a[4] + (b[4] - a[4]) * f;
    this.night = dt >= DUSK_TICK ? Math.min(1, (dt - DUSK_TICK + 60) / 150) * Math.min(1, (TICKS_PER_DAY - dt) / 60) : dt > DUSK_TICK - 60 ? (dt - (DUSK_TICK - 60)) / 210 : 0;

    const at = this.atmosphere;
    if (at.skyTint) sky.lerp(this.c2.set(at.skyTint), 0.55);
    if (at.lightTint) sunC.multiply(this.c2.set(at.lightTint));
    if (at.weather === 'rain' || at.weather === 'snow') {
      sky.lerp(this.c2.set(at.weather === 'rain' ? '#6a7480' : '#c8d0dc'), 0.45);
      sunI *= 0.6;
    }
    (this.scene.background as THREE.Color).copy(sky);
    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.copy(at.fogColor ? this.c2.set(at.fogColor) : sky);
    fog.density = 0.006 + (at.fogDensity ?? 0) * 0.06;
    this.sun.color.copy(sunC);
    this.sun.intensity = sunI;
    this.ambient.intensity = amb;
    this.ambient.color.copy(sky).lerp(this.c2.set('#ffffff'), 0.5);
    // the sun arcs east → west over the day; at night the "moon" comes from the opposite side
    const phase = dt < DUSK_TICK ? dt / DUSK_TICK : (dt - DUSK_TICK) / (TICKS_PER_DAY - DUSK_TICK);
    const ang = Math.PI * (0.1 + 0.8 * phase);
    this.sun.position.set(32 + Math.cos(ang) * 50, 20 + Math.sin(ang) * 45, 32 + 25);
    this.sun.target.position.set(32, 0, 32);
  }
}
