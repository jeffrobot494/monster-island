import * as THREE from 'three';

interface Bubble {
  ent: number;
  sprite: THREE.Sprite;
  until: number;
  born: number;
  speech: boolean;
}

const MAX_VISIBLE = 20;

export class Sprites {
  group = new THREE.Group();
  private bubbles: Bubble[] = [];

  add(ent: number, text: string, seconds: number, speech: boolean, now: number) {
    // one bubble of each kind per entity
    this.bubbles = this.bubbles.filter((b) => {
      if (b.ent === ent && b.speech === speech) {
        this.dispose(b);
        return false;
      }
      return true;
    });
    while (this.bubbles.length >= MAX_VISIBLE) this.dispose(this.bubbles.shift()!);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const font = speech ? '600 30px system-ui, sans-serif' : '56px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width) + (speech ? 28 : 12);
    const h = speech ? 52 : 68;
    canvas.width = w;
    canvas.height = h;
    ctx.font = font;
    if (speech) {
      ctx.fillStyle = 'rgba(255,252,240,0.95)';
      ctx.beginPath();
      ctx.roundRect(2, 2, w - 4, h - 4, 18);
      ctx.fill();
      ctx.fillStyle = '#2a2a33';
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2 + 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    const k = speech ? 0.011 : 0.009;
    sprite.scale.set(w * k, h * k, 1);
    sprite.renderOrder = 10;
    this.group.add(sprite);
    this.bubbles.push({ ent, sprite, until: now + seconds, born: now, speech });
  }

  private dispose(b: Bubble) {
    this.group.remove(b.sprite);
    b.sprite.material.map?.dispose();
    b.sprite.material.dispose();
  }

  update(now: number, positionOf: (id: number) => THREE.Vector3 | null, heightOf: (id: number) => number) {
    this.bubbles = this.bubbles.filter((b) => {
      const p = positionOf(b.ent);
      if (!p || now > b.until) {
        this.dispose(b);
        return false;
      }
      const rise = Math.min(1, (now - b.born) * 4) * 0.25;
      b.sprite.position.set(p.x, p.y + heightOf(b.ent) + (b.speech ? 0.75 : 0.45) + rise, p.z);
      const fade = Math.min(1, (b.until - now) * 2);
      b.sprite.material.opacity = fade;
      return true;
    });
  }
}
