// The world map (spec §8.2): a full-screen canvas drawn from tile colors and the explored mask, with markers.
import { SIZE } from '../sim/world';
import type { TileTypeDef } from '../sim/types';

export interface MapMarker {
  x: number;
  z: number;
  kind: 'champion' | 'village' | 'altar' | 'high' | 'lair' | 'lair-dead' | 'scream' | 'villager' | 'monster' | 'guard' | 'creation';
  label?: string;
  yaw?: number;
}

export class WorldMap {
  el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private base: HTMLCanvasElement;
  private baseCtx: CanvasRenderingContext2D;
  private explored = new Uint8Array(SIZE * SIZE);
  private types: string[] = [];
  private defs = new Map<string, TileTypeDef>();
  private dirty = true;
  open = false;
  zoom = 1;
  panX = 0;
  panZ = 0;
  private drag: { x: number; y: number; px: number; pz: number } | null = null;
  reveal = false;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'map-screen hidden';
    this.el.innerHTML = '<div class="map-title">The Island <span class="map-hint">M or Esc to close · wheel to zoom · drag to pan</span></div>';
    this.canvas = document.createElement('canvas');
    this.el.appendChild(this.canvas);
    parent.appendChild(this.el);
    this.base = document.createElement('canvas');
    this.base.width = this.base.height = SIZE;
    this.baseCtx = this.base.getContext('2d')!;
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom = Math.max(1, Math.min(5, this.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    }, { passive: false });
    this.canvas.addEventListener('mousedown', (e) => (this.drag = { x: e.clientX, y: e.clientY, px: this.panX, pz: this.panZ }));
    window.addEventListener('mouseup', () => (this.drag = null));
    window.addEventListener('mousemove', (e) => {
      if (!this.drag || !this.open) return;
      const s = this.scale();
      this.panX = this.drag.px - (e.clientX - this.drag.x) / s;
      this.panZ = this.drag.pz - (e.clientY - this.drag.y) / s;
    });
  }

  setTiles(types: string[], defs: Map<string, TileTypeDef>) {
    this.types = types;
    this.defs = defs;
    this.dirty = true;
  }
  setExplored(e: Uint8Array) {
    this.explored.set(e);
    this.dirty = true;
  }
  markExplored(idx: number[]) {
    if (!idx.length) return;
    for (const i of idx) this.explored[i] = 1;
    this.dirty = true;
  }
  tilesChanged() {
    this.dirty = true;
  }

  isExplored(x: number, z: number) {
    const i = Math.floor(z) * SIZE + Math.floor(x);
    return this.reveal || this.explored[i] === 1;
  }

  toggle(on = !this.open, center?: { x: number; z: number }) {
    this.open = on;
    this.el.classList.toggle('hidden', !on);
    if (on && center) {
      this.panX = center.x;
      this.panZ = center.z;
    }
  }

  private scale() {
    const r = this.canvas.getBoundingClientRect();
    return (Math.min(r.width, r.height) / SIZE) * this.zoom;
  }

  private rebuildBase() {
    const img = this.baseCtx.createImageData(SIZE, SIZE);
    for (let i = 0; i < SIZE * SIZE; i++) {
      const t = this.types[i] ?? 'deep-water';
      const col = t === 'house' ? '#8a6a4a' : t === 'gate' ? '#c8b48a' : this.defs.get(t)?.color ?? '#1f4f7a';
      const n = parseInt(col.slice(1), 16);
      const seen = this.reveal || this.explored[i] === 1;
      const k = seen ? 1 : 0.16;
      img.data[i * 4] = ((n >> 16) & 255) * k + (seen ? 0 : 14);
      img.data[i * 4 + 1] = ((n >> 8) & 255) * k + (seen ? 0 : 12);
      img.data[i * 4 + 2] = (n & 255) * k + (seen ? 0 : 10);
      img.data[i * 4 + 3] = 255;
    }
    this.baseCtx.putImageData(img, 0, 0);
    this.dirty = false;
  }

  draw(markers: MapMarker[], t: number) {
    if (!this.open) return;
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio);
    if (this.canvas.width !== Math.round(r.width * dpr)) {
      this.canvas.width = Math.round(r.width * dpr);
      this.canvas.height = Math.round(r.height * dpr);
    }
    if (this.dirty) this.rebuildBase();
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0c10';
    ctx.fillRect(0, 0, r.width, r.height);
    const s = this.scale();
    if (this.zoom <= 1.001) {
      this.panX = SIZE / 2;
      this.panZ = SIZE / 2;
    }
    const ox = r.width / 2 - this.panX * s, oz = r.height / 2 - this.panZ * s;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.base, ox, oz, SIZE * s, SIZE * s);
    const px = (x: number) => ox + x * s, pz = (z: number) => oz + z * s;
    ctx.font = '600 12px Georgia, serif';
    ctx.textAlign = 'center';
    for (const m of markers) {
      const x = px(m.x), y = pz(m.z);
      switch (m.kind) {
        case 'villager':
          ctx.fillStyle = '#f0e6d0';
          ctx.beginPath();
          ctx.arc(x, y, 2.5, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'guard':
          ctx.fillStyle = '#d06040';
          ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
          break;
        case 'monster':
          ctx.fillStyle = '#ff3020';
          ctx.beginPath();
          ctx.arc(x, y, 5, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'scream': {
          const p = 6 + Math.sin(t * 8) * 3;
          ctx.strokeStyle = '#ff4030';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, p + 4, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = '#ff4030';
          ctx.fillText('!', x, y + 4);
          break;
        }
        default: {
          const icon = { village: '⌂', altar: '🔥', high: '▲', lair: '☠', 'lair-dead': '✝', creation: '✦', champion: '' }[m.kind as string] ?? '';
          if (m.kind === 'champion') {
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(-(m.yaw ?? 0) + Math.PI);
            ctx.fillStyle = '#ffe080';
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(0, -9);
            ctx.lineTo(6, 7);
            ctx.lineTo(0, 3);
            ctx.lineTo(-6, 7);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.restore();
          } else {
            ctx.font = '16px serif';
            ctx.fillStyle = m.kind === 'high' ? '#ff6050' : m.kind === 'lair' ? '#e0d0b0' : '#ffe0a0';
            ctx.fillText(icon, x, y + 6);
          }
          if (m.label) {
            ctx.font = '600 12px Georgia, serif';
            ctx.fillStyle = '#f0e2c4';
            ctx.strokeStyle = 'rgba(0,0,0,0.7)';
            ctx.lineWidth = 3;
            ctx.strokeText(m.label, x, y + 22);
            ctx.fillText(m.label, x, y + 22);
          }
        }
      }
    }
  }
}
