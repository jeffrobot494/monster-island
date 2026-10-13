// The arena's settings panel (shown while paused) and its status plate (always). src/arena/README.md.
import { h } from '../ui/ui';
import { ARCHETYPES } from '../sim/monsters-gen';
import { DEFAULT_CONFIG, type ArenaConfig, type ArenaRules, type ArenaStatus } from './rules';
import type { ArenaShape, Density } from './geometry';

export interface PanelCallbacks {
  /** rules changed (apply live) */
  rules(r: ArenaRules): void;
  /** shape changed and the player asked to rebuild */
  rebuild(s: ArenaShape): void;
  reset(): void;
  spawn(archetype: string | null, n: number): void;
  clear(): void;
  heal(): void;
  resume(): void;
}

const fmtS = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
/** short names: "Se'ir, goat-demon" → "Se'ir"; a long plain one ("Fiery flying serpent") → its id ("Saraph") */
const NAME = Object.fromEntries(ARCHETYPES.map((a) => {
  const n = a.display.split(',')[0];
  return [a.id, n.length > 12 ? a.id[0].toUpperCase() + a.id.slice(1) : n];
}));

export class ArenaPanel {
  root: HTMLElement;
  plate: HTMLElement;
  private statusLine = h('div', { class: 'ap-status' });
  private plateBody = h('div', {});
  private rebuildBtn!: HTMLButtonElement;

  constructor(parent: HTMLElement, private cfg: ArenaConfig, private cb: PanelCallbacks, sandbox: string[]) {
    this.plate = h('div', { class: 'arena-plate' }, this.plateBody);
    this.root = h('div', { class: 'arena-panel hidden' });
    this.root.addEventListener('keydown', (e) => e.stopPropagation()); // typing in a field isn't a game key
    this.build(sandbox);
    parent.append(this.plate, this.root);
  }

  /** the panel while paused; the plate (the same status, smaller) while fighting */
  show(on: boolean) {
    this.root.classList.toggle('hidden', !on);
    this.plate.classList.toggle('hidden', on);
  }

  private build(sandbox: string[]) {
    const r = this.cfg.rules, s = this.cfg.shape;
    const live = () => this.cb.rules({ ...r, monsters: [...r.monsters] });

    const range = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, unit = '', onChange = live) => {
      const out = h('output', {}, `${get()}${unit}`);
      const inp = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(get()) }) as HTMLInputElement;
      inp.addEventListener('input', () => {
        set(Number(inp.value));
        out.textContent = `${inp.value}${unit}`;
        onChange();
      });
      return h('label', { class: 'ap-row' }, h('span', {}, label), inp, out);
    };
    const check = (label: string, get: () => boolean, set: (v: boolean) => void, onChange = live) => {
      const inp = h('input', { type: 'checkbox', ...(get() ? { checked: true } : {}) }) as HTMLInputElement;
      inp.addEventListener('change', () => {
        set(inp.checked);
        onChange();
      });
      return h('label', { class: 'ap-row ap-check' }, h('span', {}, label), inp);
    };
    const btn = (label: string, fn: () => void, cls = '') => h('button', { class: `ap-btn ${cls}`, type: 'button', onclick: fn }, label);
    const section = (title: string, ...kids: (Node | null)[]) => h('section', {}, h('h3', {}, title), ...kids);

    // monsters
    const boxes = ARCHETYPES.map((a) => {
      const inp = h('input', { type: 'checkbox', ...(r.monsters.includes(a.id) ? { checked: true } : {}) }) as HTMLInputElement;
      inp.addEventListener('change', () => {
        r.monsters = ARCHETYPES.filter((x, k) => boxes[k].inp.checked).map((x) => x.id);
        live();
      });
      const one = h('button', { class: 'ap-mini', type: 'button', title: `Spawn a ${a.display} now`, onclick: () => this.cb.spawn(a.id, 1) }, '+1');
      return { inp, el: h('label', { class: 'ap-mon', title: `${a.display}: ${a.hp} HP, ${a.dmg} ${a.dmgType}, reach ${a.reach}${a.flies ? ', flies' : ''}. ${a.special}` }, inp, h('span', {}, NAME[a.id]), a.flies ? h('i', {}, 'flies') : null, one) };
    });
    const setAll = (on: boolean) => {
      for (const b of boxes) b.inp.checked = on;
      r.monsters = on ? ARCHETYPES.map((a) => a.id) : [];
      live();
    };

    // the hour: a slider, or the clock running
    const hourRow = range('Hour', 0, 24, 0.5, () => r.hour ?? 13, (v) => (r.hour = v), ':00');
    const hourInp = hourRow.querySelector('input')!;
    hourInp.disabled = r.hour === null;
    const clock = check('Clock runs (8-min days)', () => r.hour === null, (v) => {
      r.hour = v ? null : Number(hourInp.value);
      hourInp.disabled = v;
    });

    // the arena's shape: applied by rebuilding
    const shapeChanged = () => {
      this.rebuildBtn.classList.add('ap-hot');
      this.rebuildBtn.textContent = 'Rebuild arena (new layout)';
    };
    const density = h('select', {}) as HTMLSelectElement;
    for (const d of ['none', 'some', 'lots'] as Density[]) density.append(h('option', { value: d, ...(s.density === d ? { selected: true } : {}) }, d));
    density.addEventListener('change', () => {
      s.density = density.value as Density;
      shapeChanged();
    });
    const seedOut = h('output', {}, String(s.seed));
    this.rebuildBtn = btn('Rebuild arena', () => {
      this.rebuildBtn.classList.remove('ap-hot');
      this.rebuildBtn.textContent = 'Rebuild arena';
      this.cb.rebuild({ ...s });
    }) as HTMLButtonElement;

    const sandboxNote = sandbox.length
      ? h('div', { class: 'ap-sandbox' }, h('b', {}, `Sandbox: ${sandbox.length} file${sandbox.length > 1 ? 's' : ''} differ from the game`), h('ul', {}, ...sandbox.map((f) => h('li', {}, `src/${f}`))), h('p', {}, 'npm run arena:status · arena:diff · arena:promote'))
      : h('div', { class: 'ap-sandbox' }, h('b', {}, 'Sandbox empty: the arena runs the game\'s code as it is.'), h('p', {}, 'npm run arena:fork -- src/sim/combat.ts'));

    this.root.append(
      h('header', {},
        h('div', { class: 'ap-title' }, 'Combat Arena'),
        this.statusLine,
        h('div', { class: 'ap-actions' },
          btn('▶ Fight', () => this.cb.resume(), 'ap-go'),
          btn('Reset round (F2)', () => this.cb.reset()),
          btn('Spawn wave (F3)', () => this.cb.spawn(null, r.waveSize)),
          btn('Clear monsters (F4)', () => this.cb.clear()),
          btn('Heal (F6)', () => this.cb.heal()))),
      h('div', { class: 'ap-body' },
        section('Monsters',
          h('div', { class: 'ap-mons' }, ...boxes.map((b) => b.el)),
          h('div', { class: 'ap-inline' }, btn('All', () => setAll(true), 'ap-mini'), btn('None', () => setAll(false), 'ap-mini')),
          check('Spawn on a timer', () => r.autoSpawn, (v) => (r.autoSpawn = v)),
          range('Alive at once', 0, 30, 1, () => r.maxAlive, (v) => (r.maxAlive = v)),
          range('Every', 1, 120, 1, () => r.spawnEvery, (v) => (r.spawnEvery = v), ' s'),
          range('Per wave', 1, 10, 1, () => r.waveSize, (v) => (r.waveSize = v)),
          range('Level', 1, 20, 1, () => r.monsterLevel, (v) => (r.monsterLevel = v)),
          range('Round limit (0: none)', 0, 100, 1, () => r.roundLimit, (v) => (r.roundLimit = v))),
        section('Guards (followers)',
          range('Guards', 0, 16, 1, () => r.guards, (v) => (r.guards = v)),
          check('Follow me (off: hold posts)', () => r.guardsFollow, (v) => (r.guardsFollow = v)),
          range('Level', 1, 20, 1, () => r.guardLevel, (v) => (r.guardLevel = v)),
          range('Spear each', 0, 1, 1, () => r.guardSpears, (v) => (r.guardSpears = v)),
          range('Replaced after (0: never)', 0, 300, 5, () => r.guardRespawn, (v) => (r.guardRespawn = v), ' s')),
        section('Champion',
          range('Level', 1, 20, 1, () => r.championLevel, (v) => (r.championLevel = v)),
          range('Spears', 0, 3, 1, () => r.championSpears, (v) => (r.championSpears = v)),
          range('Back after', 1, 60, 1, () => r.championRespawn, (v) => (r.championRespawn = v), ' s'),
          check('Invincible (never below 1 HP)', () => r.invincible, (v) => (r.invincible = v)),
          h('p', { class: 'ap-note' }, 'Level and spears take effect when the champion next spawns (Reset round).')),
        section('World',
          hourRow,
          clock,
          range('Bodies linger (0: forever)', 0, 300, 5, () => r.bodiesLinger, (v) => (r.bodiesLinger = v), ' s')),
        section('Arena',
          range('Radius', 12, 50, 1, () => s.radius, (v) => (s.radius = v), ` tiles`, shapeChanged),
          range('Wall height', 20, 150, 5, () => s.wallH, (v) => (s.wallH = v), ' m', shapeChanged),
          h('label', { class: 'ap-row' }, h('span', {}, 'Obstacles'), density),
          h('label', { class: 'ap-row' }, h('span', {}, 'Layout'), seedOut, btn('New layout', () => {
            s.seed = 1 + Math.floor(Math.random() * 1e6);
            seedOut.textContent = String(s.seed);
            shapeChanged();
          }, 'ap-mini')),
          this.rebuildBtn,
          btn('Restore all defaults', () => {
            Object.assign(r, structuredClone(DEFAULT_CONFIG.rules));
            Object.assign(s, structuredClone(DEFAULT_CONFIG.shape));
            this.cb.rebuild({ ...s });
            this.cb.rules({ ...r });
            this.root.replaceChildren();
            this.build(sandbox);
          }, 'ap-quiet')),
        section('Porting to the game', sandboxNote)),
    );
  }

  status(st: ArenaStatus) {
    const parts = [`Round ${fmtS(st.roundSeconds)}`, `kills ${st.kills}`, `deaths ${st.deaths}`, `guards ${st.guards}${st.guardDeaths ? ` (${st.guardDeaths} lost)` : ''}`];
    if (st.respawn !== null) parts.push(`back in ${Math.ceil(st.respawn)} s`);
    else if (st.nextWave !== null) parts.push(`next wave ${Math.ceil(st.nextWave)} s`);
    const line = parts.join(' · ');
    this.statusLine.textContent = line;
    this.plateBody.replaceChildren(
      h('div', { class: 'arena-plate-line' }, line),
      ...st.alive.slice(0, 8).map((m) => h('div', { class: 'arena-mon' },
        h('span', {}, `${NAME[m.archetype] ?? m.archetype}${m.level > 1 ? ` ${m.level}` : ''}`),
        h('b', { class: m.state === 'downed' ? 'down' : '' }, h('i', { style: `width:${Math.round((100 * m.hp) / Math.max(1, m.max))}%` })))),
      ...(st.alive.length > 8 ? [h('div', { class: 'arena-plate-line' }, `+${st.alive.length - 8} more`)] : []),
      h('div', { class: 'arena-plate-hint' }, 'Esc: arena settings'),
    );
  }
}
