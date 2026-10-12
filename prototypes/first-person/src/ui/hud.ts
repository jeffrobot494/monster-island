// The first-person HUD (spec §8.1, F20, F22, F28): crosshair, target frame, prompts, compass, bars, wind-up arcs,
// hurt vignette, downed overlay, click-to-play, one-time hints.
import type { Hud } from '../protocol';
import { GAME_TIMESCALE, fmtClock } from '../sim/clock';
import { h } from './ui';
import { keyLabel, type Settings } from '../input/controls';

export interface CompassMarker {
  x: number; // tiles
  z: number;
  icon: string;
  cls?: string;
  label?: string;
}

export interface TargetInfo {
  name: string;
  title: string;
  hp: number | null;
  state: string;
  hostile: boolean;
  downed: boolean;
  /** the body part under the crosshair, for a hostile monster in reach */
  zone?: string | null;
}

const ZONE_LABEL: Record<string, string> = { head: 'head ×1.5', torso: 'body', armL: 'arm', armR: 'arm', legL: 'leg', legR: 'leg', sig: 'signature limb' };

const HINTS: Record<string, string> = {
  windup: 'A red ring means a blow is coming. C: dodge out of it · Right mouse: raise your shield.',
  downed: 'It is down! E: bind it and drag it home alive · F: finish it.',
  night: 'Night falls. T: light a torch (it takes your shield hand).',
  drag: 'Drag it to the altar in the village square, then press E on the altar to offer it.',
  scream: 'A scream! Follow the red ! on the compass. Strike the carrier and it drops its captive.',
  mount: 'You are on its body. WASD: climb over it · Shift + direction: lunge · Space, looking away: jump off · C: let go.',
  lair: 'You found a lair. Monsters rest here outside their hours: catch one asleep for double damage.',
};

export class HudView {
  root: HTMLDivElement;
  private xhair = h('div', { class: 'xhair' });
  private hitm = h('div', { class: 'hitm' });
  private hitTimer = 0;
  private target = h('div', { class: 'target hidden' });
  private prompt = h('div', { class: 'prompt hidden' });
  private compass = h('div', { class: 'compass' });
  private strip = h('div', { class: 'strip' });
  private tl = h('div', { class: 'hud-tl plate' });
  private tr = h('div', { class: 'hud-tr plate' });
  private bl = h('div', { class: 'hud-bl plate' });
  private fx = h('canvas', { class: 'fxcanvas' }) as HTMLCanvasElement;
  private hurt = h('div', { class: 'hurt' });
  private downed = h('div', { class: 'downed-msg hidden' });
  play = h('div', { class: 'play hidden' });
  private camBtn = h('button', { class: 'cam-toggle', type: 'button' }) as HTMLButtonElement;
  private hint = h('div', { class: 'hint hidden' });
  private hpI = h('i');
  private stI = h('i');
  private xpI = h('i');
  private nameEl = h('div', { class: 'champ-name' });
  private stateEl = h('div', { class: 'champ-state' });
  private hurtUntil = 0;
  private hintTimer = 0;
  private seenHints = new Set<string>();
  onPlay: () => void = () => {};
  onCamera: () => void = () => {};

  constructor(parent: HTMLElement, private settings: Settings) {
    this.root = h('div', { class: 'hud' });
    this.compass.append(this.strip, h('div', { class: 'compass-tick' }));
    this.bl.append(this.nameEl, h('div', { class: 'bar hp' }, this.hpI), h('div', { class: 'bar st' }, this.stI), h('div', { class: 'bar xpb' }, this.xpI), this.stateEl);
    this.root.append(this.fx, this.hurt, this.compass, this.tl, this.tr, this.bl, this.xhair, this.hitm, this.target, this.prompt, this.downed, this.hint, this.play, this.camBtn);
    parent.prepend(this.root);
    try {
      for (const k of JSON.parse(localStorage.getItem('hmfp:hints') ?? '[]')) this.seenHints.add(k);
    } catch {
      /* storage unavailable */
    }
    this.play.addEventListener('click', () => this.onPlay());
    this.camBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onCamera();
    });
    this.setCamera(settings.thirdPerson);
    window.addEventListener('resize', () => this.resizeFx());
    this.resizeFx();
  }

  /** Label the camera button with the view it switches to. */
  setCamera(third: boolean) {
    this.camBtn.textContent = `${third ? 'First person' : 'Third person'} (${keyLabel(this.settings.bindings.camera)})`;
    this.xhair.classList.toggle('third', third);
  }

  private resizeFx() {
    this.fx.width = innerWidth;
    this.fx.height = innerHeight;
  }

  showPlay(on: boolean, firstTime: boolean) {
    this.play.classList.toggle('hidden', !on);
    if (!on) return;
    const b = this.settings.bindings;
    const row = (k: string, v: string) => h('div', { class: 'ctl' }, h('kbd', {}, k), h('span', {}, v));
    this.play.replaceChildren(h('div', { class: 'play-card' },
      h('div', { class: 'play-title' }, firstTime ? 'Island Humans and Monsters' : 'Paused view — the island does not wait'),
      firstTime ? h('p', { class: 'serif' }, 'You are the champion of a small village. Six monsters hide in the hills. Hunt them, bring them home alive, and burn them on the altar of the Most High.') : null,
      h('div', { class: 'ctls' },
        row(`${keyLabel(b.forward)} ${keyLabel(b.left)} ${keyLabel(b.back)} ${keyLabel(b.right)}`, 'move'),
        row('Mouse', 'look'),
        row(keyLabel(b.sprint), 'sprint'),
        row('Left click', 'swing — aim high for the head, low for the legs'),
        row('Right mouse', 'shield'),
        row(keyLabel(b.jump), 'jump'),
        row(keyLabel(b.dodge), 'dodge'),
        row(keyLabel(b.interact), 'bind · drag · drop · altar'),
        row(keyLabel(b.finish), 'finish a downed monster'),
        row(keyLabel(b.throw), 'throw a spear (pick it up again after)'),
        row(keyLabel(b.torch), 'torch'),
        row(keyLabel(b.inspect), 'inspect'),
        row(keyLabel(b.map), 'map'),
        row(keyLabel(b.camera), 'first / third person'),
        row(`${keyLabel(b.journal)} / Esc`, 'journal'),
      ),
      h('div', { class: 'play-go' }, 'Click to play'),
    ));
  }

  /** A one-time contextual hint (F28). */
  hintOnce(key: keyof typeof HINTS | string) {
    if (this.seenHints.has(key) || !HINTS[key]) return;
    this.seenHints.add(key);
    try {
      localStorage.setItem('hmfp:hints', JSON.stringify([...this.seenHints]));
    } catch {
      /* ignore */
    }
    this.hint.textContent = HINTS[key];
    this.hint.classList.remove('hidden');
    clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => this.hint.classList.add('hidden'), 9000);
  }

  /** An X at the crosshair when a blow lands; bigger and gold for the head, red for a severing. */
  hitMarker(zone: string | null, severed = false) {
    this.hitm.className = 'hitm';
    void this.hitm.offsetWidth; // restart the animation
    this.hitm.className = `hitm on${severed ? ' sever' : zone === 'head' ? ' head' : ''}`;
    clearTimeout(this.hitTimer);
    this.hitTimer = window.setTimeout(() => (this.hitm.className = 'hitm'), 260);
  }

  flashHurt() {
    this.hurtUntil = performance.now() + 350;
  }

  setHud(hud: Hud, stamina: number, winded: boolean) {
    const night = hud.light < 0.5;
    const jm = Math.max(0, hud.judgmentInMs);
    const jmin = Math.floor(jm / 60_000), js = Math.floor((jm % 60_000) / 1000);
    const total = Math.max(1, hud.favor.human + hud.favor.monster);
    const raid = hud.raid ? [h('div', { class: 'raid' }, 'RAID: the monsters are attacking the village')] : [];
    this.tl.replaceChildren(
      h('div', { class: 'clock' }, `${night ? '☾' : '☀'} Day ${hud.day} · ${fmtClock(hud.clockMs)}${hud.timescale !== GAME_TIMESCALE ? ` ×${hud.timescale}` : ''}`),
      h('div', { class: 'favor' }, h('span', { class: 'fh' }, `☀ ${hud.favor.human}`), h('span', { class: 'fbar' }, h('i', { style: `width:${(hud.favor.human / total) * 100}%` })), h('span', { class: 'fm' }, `${hud.favor.monster} ☾`)),
      h('div', { class: 'muted-l' }, `Judgment in ${jmin}:${String(js).padStart(2, '0')}`),
      ...raid,
    );
    const slain = 6 - hud.monstersAlive;
    this.tr.replaceChildren(
      h('span', { title: 'Villagers' }, `👥 ${hud.pop}`),
      h('span', { title: `${hud.monstersAlive} monsters alive` }, '👹'.repeat(hud.monstersAlive) + '✝'.repeat(Math.max(0, slain))),
      h('span', { class: hud.food < 60 ? 'low' : '', title: 'Food' }, `🌾 ${Math.round(hud.food)}`),
      h('span', { title: 'Lambs in the fold' }, `🐑 ${hud.fold}`),
    );
    const c = hud.champion;
    this.bl.classList.toggle('hidden', !c);
    if (c) {
      this.nameEl.textContent = `${c.name.split(' ')[0]} · level ${c.level}`;
      this.hpI.style.width = `${(c.hp / c.maxHp) * 100}%`;
      this.xpI.style.width = `${(c.xp / c.xpNext) * 100}%`;
      const bits: string[] = [];
      bits.push(`Spears ${c.spears}/${c.spearCap}`);
      if (c.dragging) bits.push(`Dragging ${c.dragging.name.split(' ')[0]} (${c.dragging.value} favor)`);
      if (c.torch) bits.push('Torch lit');
      if (winded) bits.push('Winded!');
      if (c.state === 'downed') bits.push('Beaten down');
      this.stateEl.textContent = bits.join(' · ');
    }
    this.stI.style.width = `${stamina}%`;
    this.stI.parentElement!.classList.toggle('winded', winded);
  }

  setTarget(t: TargetInfo | null, prompt: string) {
    this.target.classList.toggle('hidden', !t);
    if (t) {
      const kids: HTMLElement[] = [h('div', { class: 'tname' }, t.name), h('div', { class: 'ttitle' }, `${t.title}${t.state ? ` · ${t.state}` : ''}`)];
      if (t.zone) kids.push(h('div', { class: `tzone${t.zone === 'head' ? ' head' : t.zone === 'sig' ? ' sig' : ''}` }, ZONE_LABEL[t.zone] ?? t.zone));
      if (t.hp !== null) kids.push(h('div', { class: 'bar thp' }, h('i', { style: `width:${t.hp * 100}%` })));
      this.target.replaceChildren(...kids);
    }
    this.xhair.className = `xhair${t?.downed ? ' downed' : t?.hostile ? ' hostile' : ''}`;
    this.prompt.classList.toggle('hidden', !prompt);
    this.prompt.textContent = prompt;
  }

  setDowned(text: string | null) {
    this.downed.classList.toggle('hidden', !text);
    if (text) this.downed.textContent = text;
  }

  /** Compass: yaw = camera yaw (rad); markers in tiles relative to (cx, cz). */
  setCompass(yaw: number, cx: number, cz: number, markers: CompassMarker[]) {
    const W = 520, FOV = Math.PI; // ±90° visible
    const items: HTMLElement[] = [];
    const place = (bearing: number, el: HTMLElement) => {
      let d = bearing - yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      if (Math.abs(d) > FOV / 2) return;
      // yaw increases to the left (counter-clockwise from above), so a positive offset is left of center
      el.style.left = `${W / 2 - (d / (FOV / 2)) * (W / 2)}px`;
      items.push(el);
    };
    const cards: [string, number][] = [['S', 0], ['E', Math.PI / 2], ['N', Math.PI], ['W', -Math.PI / 2]];
    for (const [l, b] of cards) place(b, h('span', { class: 'cdir' }, l));
    for (let k = 0; k < 24; k++) if (k % 6) place((k / 24) * Math.PI * 2, h('span', { class: 'cminor' }, '·'));
    for (const m of markers) {
      const b = Math.atan2(m.x - cx, m.z - cz);
      const dist = Math.hypot(m.x - cx, m.z - cz) * 8;
      place(b, h('span', { class: `cmark ${m.cls ?? ''}`, title: m.label ?? '' }, h('b', {}, m.icon), h('small', {}, dist < 1000 ? `${Math.round(dist)}m` : `${(dist / 1000).toFixed(1)}km`)));
    }
    this.strip.replaceChildren(...items);
  }

  /** Wind-up arcs at the screen edge toward attackers (F20); bearings relative to the view, progress 0..1. */
  drawFx(arcs: { rel: number; prog: number }[], hpFrac: number) {
    const ctx = this.fx.getContext('2d')!;
    const W = this.fx.width, H = this.fx.height;
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.42;
    for (const a of arcs) {
      // rel: 0 = straight ahead, + = to the left; screen angle: up is ahead
      const ang = -Math.PI / 2 - a.rel;
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(255,40,20,0.25)';
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.arc(cx, cy, R, ang - 0.28, ang + 0.28);
      ctx.stroke();
      ctx.strokeStyle = `rgba(255,${Math.round(80 - 60 * a.prog)},20,${0.6 + 0.4 * a.prog})`;
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.arc(cx, cy, R, ang - 0.28 * a.prog, ang + 0.28 * a.prog);
      ctx.stroke();
    }
    const hurt = Math.max(0, (this.hurtUntil - performance.now()) / 350);
    const low = hpFrac < 0.35 ? (0.35 - hpFrac) * 1.6 : 0;
    this.hurt.style.opacity = String(Math.min(1, hurt * 0.9 + low * (0.75 + 0.25 * Math.sin(performance.now() / 180))));
  }
}
