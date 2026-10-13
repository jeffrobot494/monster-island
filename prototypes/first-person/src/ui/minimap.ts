// The minimap (top right): a round inset that turns with the view, so your heading is always up. Its terrain is baked
// from the ground's own colors and heights with hillshading (no fog of war: the M map keeps that); on it, the compass's
// landmarks (pinned to the rim when beyond it) and the monsters and villagers in sight.
import type { Terrain } from '../render/terrain';
import { M, NV, RES, WATER_Y } from '../sim/ground';
import { SIZE } from '../sim/world';

/** A landmark, as the compass has it (tiles). */
export interface MinimapMark {
  x: number;
  z: number;
  icon: string;
  cls?: string;
}

/** A creature in sight (tiles). */
export interface MinimapDot {
  x: number;
  z: number;
  kind: 'monster' | 'villager';
}

/** What Z steps through: meters from you to the rim. */
export const MINIMAP_RANGES = [60, 120, 250];

const PX = 4; // baked pixels per tile: 2 m each
const D = 190; // diameter, CSS px
const SEA = [22, 112, 122]; // open water, off the island and deep
const WATER = [58, 210, 194]; // the sea plane's color (render/terrain.ts), over the ground under it
// the light, from the north-west and above (north is -z, west is -x)
const L = (() => {
  const l = [-1, 1.6, -1];
  const n = Math.hypot(l[0], l[1], l[2]);
  return l.map((v) => v / n);
})();

export class Minimap {
  el: HTMLCanvasElement;
  range: number;
  private base = document.createElement('canvas');
  private dirty = true;
  private bakedAt = 0;

  constructor(parent: HTMLElement, range: number) {
    this.el = document.createElement('canvas');
    this.el.className = 'minimap';
    parent.appendChild(this.el);
    this.range = MINIMAP_RANGES.includes(range) ? range : 120;
  }

  /** The next range (Z): 60 → 120 → 250 → 60 m. */
  cycle(): number {
    this.range = MINIMAP_RANGES[(MINIMAP_RANGES.indexOf(this.range) + 1) % MINIMAP_RANGES.length];
    return this.range;
  }

  /** The ground changed (a new island, changed tiles): bake it again, at most every 2 s. */
  terrainChanged() {
    this.dirty = true;
  }

  /** The ground's colors (the 3D terrain's, between its vertices), lit by its slopes, the sea over what's below it. */
  private bake(t: Terrain) {
    const W = SIZE * PX;
    if (this.base.width !== W) this.base.width = this.base.height = W;
    const ctx = this.base.getContext('2d')!;
    const img = ctx.createImageData(W, W);
    const col = t.colors, g = t.ground;
    const e = 1 / M; // a meter, in tiles: the slope's baseline
    for (let py = 0; py < W; py++) {
      for (let px = 0; px < W; px++) {
        const x = (px + 0.5) / PX, z = (py + 0.5) / PX;
        const gx = Math.min(NV - 1.0001, x * RES), gz = Math.min(NV - 1.0001, z * RES);
        const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
        const o00 = (j * NV + i) * 3, o10 = o00 + 3, o01 = o00 + NV * 3, o11 = o01 + 3;
        const w00 = (1 - fx) * (1 - fz), w10 = fx * (1 - fz), w01 = (1 - fx) * fz, w11 = fx * fz;
        let r = (col[o00] * w00 + col[o10] * w10 + col[o01] * w01 + col[o11] * w11) * 255;
        let gr = (col[o00 + 1] * w00 + col[o10 + 1] * w10 + col[o01 + 1] * w01 + col[o11 + 1] * w11) * 255;
        let b = (col[o00 + 2] * w00 + col[o10 + 2] * w10 + col[o01 + 2] * w01 + col[o11 + 2] * w11) * 255;
        const h = g.y(x, z);
        if (h < WATER_Y) {
          // under the sea plane: its color over the ground, darkening with depth
          const k = Math.min(1, 0.74 + (WATER_Y - h) * 0.03);
          const deep = Math.min(1, (WATER_Y - h) / 12);
          r += ((WATER[0] * (1 - deep) + SEA[0] * deep) - r) * k;
          gr += ((WATER[1] * (1 - deep) + SEA[1] * deep) - gr) * k;
          b += ((WATER[2] * (1 - deep) + SEA[2] * deep) - b) * k;
        } else {
          // hillshade: the slope's normal against the light, relative to flat ground. The rise over 2 m is twice the
          // slope: relief exaggerated ×2, so gentle hills read too
          const dx = g.y(x + e, z) - g.y(x - e, z), dz = g.y(x, z + e) - g.y(x, z - e);
          const n = Math.hypot(dx, 1, dz);
          const lit = (-dx * L[0] + L[1] - dz * L[2]) / n / L[1];
          const s = Math.max(0.45, Math.min(1.3, lit));
          r *= s;
          gr *= s;
          b *= s;
        }
        const o = (py * W + px) * 4;
        img.data[o] = r;
        img.data[o + 1] = gr;
        img.data[o + 2] = b;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    this.dirty = false;
    this.bakedAt = performance.now();
  }

  /** Every frame: centered on `at` (tiles), turned so `yaw` (the view's heading) is up. */
  draw(t: Terrain, at: { x: number; z: number }, yaw: number, marks: MinimapMark[], dots: MinimapDot[]) {
    if (!t.ready) return;
    if (this.dirty && (!this.bakedAt || performance.now() - this.bakedAt > 2000)) this.bake(t);
    const dpr = Math.min(2, devicePixelRatio);
    if (this.el.width !== Math.round(D * dpr)) this.el.width = this.el.height = Math.round(D * dpr);
    const ctx = this.el.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, D, D);
    const c = D / 2, R = c - 3;
    const k = R / this.range; // CSS px per meter
    // world (tiles) → minimap: about you, turned by yaw − π (heading up; north is −z, east +x)
    const th = yaw - Math.PI, cs = Math.cos(th), sn = Math.sin(th);
    const place = (x: number, z: number): [number, number] => {
      const dx = (x - at.x) * M, dz = (z - at.z) * M;
      return [c + (dx * cs - dz * sn) * k, c + (dx * sn + dz * cs) * k];
    };

    // terrain
    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = `rgb(${SEA.join(',')})`;
    ctx.fillRect(0, 0, D, D);
    ctx.translate(c, c);
    ctx.rotate(th);
    const s = (k * M) / PX; // CSS px per baked pixel
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.base, -at.x * PX * s, -at.z * PX * s, this.base.width * s, this.base.height * s);
    ctx.restore();

    // creatures in sight, inside the rim
    for (const d of dots) {
      const [x, y] = place(d.x, d.z);
      if (Math.hypot(x - c, y - c) > R - 3) continue;
      ctx.beginPath();
      ctx.arc(x, y, d.kind === 'monster' ? 3.6 : 2.4, 0, Math.PI * 2);
      ctx.fillStyle = d.kind === 'monster' ? '#ff3a24' : '#f6ecd6';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.stroke();
    }

    // landmarks: beyond the rim they're pinned to it, fainter
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const m of marks) {
      let [x, y] = place(m.x, m.z);
      const d = Math.hypot(x - c, y - c), edge = R - 9;
      const out = d > edge;
      if (out) {
        x = c + ((x - c) / d) * edge;
        y = c + ((y - c) / d) * edge;
      }
      ctx.globalAlpha = out ? 0.7 : 1;
      const scream = m.cls === 'scream';
      ctx.font = scream ? '900 16px system-ui, sans-serif' : '14px serif';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(m.icon, x, y);
      ctx.fillStyle = scream || m.cls === 'dev-monster' ? '#ff4030' : m.cls === 'dead' ? '#b8ab90' : '#fff0c8';
      ctx.fillText(m.icon, x, y);
    }
    ctx.globalAlpha = 1;

    // you, pointing up
    ctx.beginPath();
    ctx.moveTo(c, c - 8);
    ctx.lineTo(c + 5.5, c + 6);
    ctx.lineTo(c, c + 3);
    ctx.lineTo(c - 5.5, c + 6);
    ctx.closePath();
    ctx.fillStyle = '#ffe080';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#000';
    ctx.stroke();

    // the rim, north on it, and the range
    ctx.beginPath();
    ctx.arc(c, c, R, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(201, 169, 106, 0.85)';
    ctx.stroke();
    const nx = c + sn * R, ny = c - cs * R; // north (0, −1) turned
    ctx.beginPath();
    ctx.arc(nx, ny, 8, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(14, 10, 8, 0.85)';
    ctx.fill();
    ctx.font = '600 11px Georgia, serif';
    ctx.fillStyle = '#fff2c8';
    ctx.fillText('N', nx, ny + 0.5);
    ctx.font = '10px system-ui, sans-serif';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.strokeText(`${this.range} m`, c, D - 14);
    ctx.fillStyle = '#e8d8b8';
    ctx.fillText(`${this.range} m`, c, D - 14);
  }
}
