import * as THREE from 'three';
import type { Atmosphere } from '../sim/types';

// [hour, sky, sun color, sun intensity, ambient intensity]
const KEYS: [number, string, string, number, number][] = [
  [0, '#0e1428', '#7080c0', 0.32, 0.3],
  [4.5, '#141c38', '#7080c0', 0.32, 0.3],
  [6, '#e8a27a', '#ffb07a', 0.75, 0.48],
  [7.5, '#a9cfe8', '#fff1d6', 1.2, 0.62],
  [16.5, '#9fc6e2', '#fff1d6', 1.2, 0.62],
  [18, '#e8905e', '#ff8a4a', 0.8, 0.46],
  [19.5, '#2a2c58', '#8088d0', 0.4, 0.34],
  [21, '#121a34', '#7080c0', 0.32, 0.3],
  [24, '#0e1428', '#7080c0', 0.32, 0.3],
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
    scene.fog = new THREE.FogExp2(0x9fcbe8, 0.004);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    const c = this.sun.shadow.camera;
    c.left = -30; c.right = 30; c.top = 30; c.bottom = -30; c.near = 1; c.far = 160;
    this.sun.shadow.bias = -0.0008;
  }

  /** hour 0..24; light 0..1 from the sim (includes eclipses and a second moon); focus = camera target */
  update(hour: number, light: number, focus: THREE.Vector3) {
    let i = 0;
    while (i < KEYS.length - 2 && KEYS[i + 1][0] <= hour) i++;
    const a = KEYS[i], b = KEYS[i + 1];
    const f = Math.min(1, Math.max(0, (hour - a[0]) / (b[0] - a[0])));
    const sky = this.c1.set(a[1]).lerp(this.c2.set(b[1]), f).clone();
    const sunC = this.c1.set(a[2]).lerp(this.c2.set(b[2]), f).clone();
    let sunI = a[3] + (b[3] - a[3]) * f;
    let amb = a[4] + (b[4] - a[4]) * f;
    // the sim's light can differ from the clock (eclipse darkens the day; a second moon lights the night)
    const clockLight = hour >= 7 && hour <= 17 ? 1 : hour >= 19 || hour <= 5 ? 0 : hour < 7 ? (hour - 5) / 2 : (19 - hour) / 2;
    const extra = light - clockLight;
    if (Math.abs(extra) > 0.02) {
      sunI = Math.max(0.25, sunI + extra * 0.8);
      amb = Math.max(0.25, amb + extra * 0.35);
      sky.lerp(this.c2.set(extra < 0 ? '#120c18' : '#4a5a88'), Math.min(0.8, Math.abs(extra)));
    }
    this.night = 1 - light;

    const at = this.atmosphere;
    if (at.skyTint) sky.lerp(this.c2.set(at.skyTint), 0.55);
    if (at.lightTint) sunC.multiply(this.c2.set(at.lightTint));
    if (at.weather === 'rain' || at.weather === 'fog' || at.weather === 'ash') {
      sky.lerp(this.c2.set(at.weather === 'rain' ? '#6a7480' : at.weather === 'ash' ? '#5a504a' : '#9aa890'), 0.45);
      sunI *= 0.7;
    }
    (this.scene.background as THREE.Color).copy(sky);
    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.copy(at.fogColor ? this.c2.set(at.fogColor) : sky);
    fog.density = 0.004 + (at.fogDensity ?? 0) * 0.05 + (at.weather === 'fog' ? 0.02 : 0);
    this.sun.color.copy(sunC);
    this.sun.intensity = sunI;
    this.ambient.intensity = amb;
    this.ambient.color.copy(sky).lerp(this.c2.set('#ffffff'), 0.55);
    const day = hour >= 6 && hour < 18;
    const phase = day ? (hour - 6) / 12 : ((hour + 6) % 24) / 12;
    const ang = Math.PI * (0.12 + 0.76 * phase);
    this.sun.position.set(focus.x + Math.cos(ang) * 40, 22 + Math.sin(ang) * 40, focus.z + 22);
    this.sun.target.position.copy(focus);
  }
}
