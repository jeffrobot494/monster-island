// DOM overlay (§14): HUD, champion card, actions, alerts, inspector, sheets (village, monsters, book, chronicle, god,
// settings), altar, Judgment/Genesis cards, away panel, game over.
import type { Action, Hud, InspectInfo, MonsterCard, VillagerInfo } from '../protocol';
import type { ChronicleEvent, CreationRecord, Job } from '../sim/types';
import type { AwaySummary } from '../sim/offline';
import type { LiveCall, TraceEntry } from '../god/pipeline';
import { GAME_TIMESCALE, fmtClock } from '../sim/clock';
import { JOBS } from '../sim/types';

type Attrs = Record<string, string | boolean | ((ev: any) => void)>;
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false) el.setAttribute(k, v);
  }
  for (const c of kids) if (c !== null && c !== false && c !== undefined) el.append(c);
  return el;
}

function fill(el: HTMLElement, ...kids: (Node | string | null | false | undefined)[]) {
  el.replaceChildren(...kids.filter((k): k is Node | string => !!k));
}

export interface UiCallbacks {
  action(a: Action): void;
  /** the Settings tab's controls/video/audio block */
  settingsPanel(): HTMLElement;
  closeInspector(): void;
  newIsland(): void;
  showCreation(): void;
  dev(cmd: string): void;
  panelChanged(open: boolean): void;
}

const GOD = { human: 'the Most High', monster: 'Dagon' } as const;
const STATE_TEXT: Record<string, string> = {
  idle: 'Standing ready', walk: 'Walking', fight: 'Fighting', drag: 'Dragging', downed: 'Beaten down!', captive: 'Being carried off!',
};

export class Ui {
  root = document.getElementById('ui')!;
  private top = h('header', { class: 'top' });
  private clock = h('div', { class: 'clock' });
  private favor = h('div', { class: 'favor' });
  private pop = h('div', { class: 'pop' });
  private skulls = h('div', { class: 'skulls' });
  private foodBar = h('div', { class: 'foodbar' }, h('i'));
  private champ = h('div', { class: 'champ' });
  private actions = h('div', { class: 'actions' });
  private finishBtn: HTMLButtonElement;
  private dropBtn: HTMLButtonElement;
  private altarBtn: HTMLButtonElement;
  private toasts = h('div', { class: 'toasts' });
  private status = h('div', { class: 'godstatus hidden' });
  private ready = h('button', { class: 'ready hidden' }, '✦ A creation is ready');
  private inspector = h('div', { class: 'card inspector hidden' });
  private sheet = h('div', { class: 'sheet hidden' });
  private sheetBody = h('div', { class: 'sheet-body' });
  private tabs: Record<string, HTMLButtonElement> = {};
  private tab = 'village';
  private modal = h('div', { class: 'modal hidden' });
  private arrow = h('div', { class: 'arrow hidden' }, '➤');
  private fallen = h('div', { class: 'fallen hidden' });
  private hud: Hud | null = null;
  private villagers: VillagerInfo[] = [];
  private monsters: MonsterCard[] = [];
  private chronicle: ChronicleEvent[] = [];
  private god: { trace: TraceEntry[]; live: LiveCall | null; version: number; status: string } = { trace: [], live: null, version: 0, status: '' };
  private renderedTab = '';
  private altarOpen = false;

  constructor(readonly cb: UiCallbacks, private devMode: boolean) {
    this.top.append(
      h('div', { class: 'top-row' }, this.clock, this.pop, this.skulls),
      h('div', { class: 'top-row' }, this.favor, this.foodBar),
    );
    this.finishBtn = h('button', { class: 'act hidden' });
    this.dropBtn = h('button', { class: 'act hidden' });
    this.altarBtn = h('button', { class: 'act hidden' });
    this.ready.addEventListener('click', () => cb.showCreation());
    const head = h('div', { class: 'sheet-head' });
    head.append(h('div', { class: 'journal-title' }, 'Journal'));
    for (const [k, label] of [['village', 'Village'], ['monsters', 'Monsters'], ['book', 'Book of Creation'], ['chronicle', 'Chronicle'], ['god', 'Gods'], ['settings', 'Settings']] as const) {
      const b = h('button', { class: 'tab', onclick: () => this.showTab(k) }, label);
      this.tabs[k] = b;
      head.append(b);
    }
    head.append(h('button', { class: 'x', onclick: () => this.closeSheet() }, '×'));
    this.sheet.append(head, this.sheetBody);
    // first person: the HUD (hud.ts) replaces the mobile top bar, champion card and buttons
    this.root.append(this.toasts, this.status, this.ready, this.inspector, this.sheet, this.modal, this.fallen);
  }

  isBusy(): boolean {
    return !this.sheet.classList.contains('hidden') || !this.modal.classList.contains('hidden');
  }

  // ---------- HUD ----------

  setHud(hud: Hud) {
    this.hud = hud;
    const night = hud.light < 0.5;
    this.clock.textContent = `${night ? '☾' : '☀'} Day ${hud.day} · ${fmtClock(hud.clockMs)}${hud.timescale !== GAME_TIMESCALE ? ` ×${hud.timescale}` : ''}`;
    const total = Math.max(1, hud.favor.human + hud.favor.monster);
    this.favor.innerHTML = '';
    this.favor.append(
      h('span', { class: 'fh' }, `☀ ${hud.favor.human}`),
      h('span', { class: 'fbar' }, h('i', { style: `width:${(hud.favor.human / total) * 100}%` })),
      h('span', { class: 'fm' }, `${hud.favor.monster} ☾`),
    );
    this.favor.title = 'Favor today: the Most High vs Dagon. Judgment at midnight.';
    this.pop.textContent = `👥 ${hud.pop}`;
    this.pop.title = 'Villagers';
    const slain = 6 - hud.monstersAlive;
    this.skulls.textContent = '👹'.repeat(hud.monstersAlive) + '✝'.repeat(Math.max(0, slain));
    this.skulls.title = `${hud.monstersAlive} monsters alive`;
    (this.foodBar.firstChild as HTMLElement).style.width = `${(hud.food / hud.foodCap) * 100}%`;
    this.foodBar.title = `Food ${Math.round(hud.food)} / ${hud.foodCap}`;
    this.foodBar.dataset.label = `🌾 ${Math.round(hud.food)}`;
    this.foodBar.classList.toggle('low', hud.food < 60);

    const c = hud.champion;
    this.champ.classList.toggle('hidden', !c);
    if (c) {
      this.champ.innerHTML = '';
      this.champ.append(
        h('div', { class: 'champ-name' }, `${c.name.split(' ')[0]} · Lv ${c.level}`),
        h('div', { class: 'hp' }, h('i', { style: `width:${(c.hp / c.maxHp) * 100}%` }), h('span', {}, `${Math.ceil(c.hp)} / ${Math.round(c.maxHp)}`)),
        h('div', { class: 'xp' }, h('i', { style: `width:${(c.xp / c.xpNext) * 100}%` })),
        h('div', { class: 'champ-state' }, c.dragging ? `Dragging ${c.dragging.name.split(' ')[0]} (${c.dragging.value} favor)` : STATE_TEXT[c.state] ?? c.state),
      );
      this.finishBtn.classList.toggle('hidden', !c.downedTarget);
      if (c.downedTarget) this.finishBtn.textContent = `⚔ Finish ${c.downedTarget.name}`;
      this.dropBtn.classList.toggle('hidden', !c.dragging);
      this.altarBtn.classList.toggle('glow', c.nearAltar || !!c.dragging);
    }
    this.fallen.classList.toggle('hidden', !hud.championPendingDawn || !!hud.gameOver);
    if (hud.championPendingDawn) this.fallen.textContent = `Your champion has fallen. A new champion will rise at dawn. (WASD + mouse: look around${this.devMode ? ' · dev: F8 for a new champion now' : ''})`;
    if (this.altarOpen) this.renderAltar();
    if (!this.sheet.classList.contains('hidden') && (this.tab === 'book' || this.tab === 'god')) this.renderTab();
  }

  setGodStatus(text: string, trace: TraceEntry[], live: LiveCall | null, version: number) {
    this.god = { trace, live, version, status: text };
    this.status.classList.toggle('hidden', !text);
    this.status.textContent = text;
    if (!this.sheet.classList.contains('hidden') && this.tab === 'god') this.renderTab();
  }

  setCreationReady(on: boolean) {
    this.ready.classList.toggle('hidden', !on);
  }

  setVillagers(v: VillagerInfo[], m: MonsterCard[]) {
    this.villagers = v;
    this.monsters = m;
    if (!this.sheet.classList.contains('hidden') && (this.tab === 'village' || this.tab === 'monsters')) this.renderTab();
    if (this.altarOpen) this.renderAltar();
  }

  setChronicle(c: ChronicleEvent[]) {
    this.chronicle = c;
    if (!this.sheet.classList.contains('hidden') && this.tab === 'chronicle') this.renderTab();
  }

  // ---------- alerts ----------

  toast(text: string, kind = 'info', seconds = 6) {
    const t = h('div', { class: `toast ${kind}` }, text);
    t.addEventListener('click', () => t.remove());
    this.toasts.prepend(t);
    while (this.toasts.children.length > 4) this.toasts.lastElementChild!.remove();
    setTimeout(() => t.classList.add('out'), seconds * 1000);
    setTimeout(() => t.remove(), seconds * 1000 + 600);
  }

  /** Big centered banner (Judgment, lair found, etc.). */
  banner(title: string, text: string, kind = 'judgment', seconds = 7) {
    const b = h('div', { class: `banner ${kind}` }, h('div', { class: 'banner-title' }, title), h('div', {}, text));
    b.addEventListener('click', () => b.remove());
    this.root.append(b);
    setTimeout(() => b.classList.add('out'), seconds * 1000);
    setTimeout(() => b.remove(), seconds * 1000 + 800);
  }

  setArrow(x: number, y: number, angle: number, on: boolean, label = '') {
    this.arrow.classList.toggle('hidden', !on);
    if (!on) return;
    this.arrow.style.left = `${x}px`;
    this.arrow.style.top = `${y}px`;
    this.arrow.style.transform = `translate(-50%, -50%) rotate(${angle}rad)`;
    this.arrow.title = label;
  }

  // ---------- inspector ----------

  setInspector(info: InspectInfo | null) {
    this.inspector.classList.toggle('hidden', !info);
    if (!info) return;
    fill(this.inspector, 
      h('button', { class: 'x', onclick: () => this.cb.closeInspector() }, '×'),
      h('div', { class: 'card-title' }, info.title),
      info.maxHp ? h('div', { class: 'hp small' }, h('i', { style: `width:${((info.hp ?? 0) / info.maxHp) * 100}%` }), h('span', {}, `${Math.ceil(info.hp ?? 0)} / ${Math.round(info.maxHp)}`)) : null,
      ...info.lines.map((l) => h('p', {}, l)),
    );
  }

  // ---------- sheets ----------

  openSheet(tab = this.tab) {
    this.sheet.classList.remove('hidden');
    this.cb.panelChanged(true);
    this.showTab(tab);
  }

  closeSheet() {
    this.sheet.classList.add('hidden');
    this.cb.panelChanged(false);
  }

  isSheetOpen() {
    return !this.sheet.classList.contains('hidden');
  }

  isModalOpen() {
    return !this.modal.classList.contains('hidden');
  }

  refreshSettings() {
    if (this.tab === 'settings' && this.isSheetOpen()) {
      this.renderedTab = '';
      this.renderTab();
    }
  }

  showTab(k: string) {
    this.tab = k;
    for (const [n, b] of Object.entries(this.tabs)) b.classList.toggle('on', n === k);
    this.renderedTab = '';
    this.renderTab();
  }

  private renderTab() {
    const hud = this.hud;
    const body = this.sheetBody;
    const scroll = body.scrollTop;
    if (this.tab === 'village') {
      const key = JSON.stringify(this.villagers.map((v) => [v.id, v.job, v.nextJob, Math.round(v.hp), v.state, v.level]));
      if (key === this.renderedTab) return;
      this.renderedTab = key;
      fill(body, 
        h('p', { class: 'muted' }, `${this.villagers.length} villagers · food ${Math.round(hud?.food ?? 0)}/${hud?.foodCap ?? 500} · ${hud?.fold ?? 0} lambs in the fold. Job changes take effect at the next shift (06:00 or 18:00).`),
        ...this.villagers.map((v) => {
          const sel = h('select', { onchange: (ev: Event) => this.cb.action({ kind: 'setJob', id: v.id, job: (ev.target as HTMLSelectElement).value as Job }) });
          for (const j of JOBS) sel.append(h('option', { value: j, ...(j === (v.nextJob ?? v.job) ? { selected: true } : {}) }, j));
          return h('div', { class: 'row-card' },
            h('div', { class: 'rc-main' },
              h('div', { class: 'rc-name' }, `${v.name}${v.elder ? ' (elder)' : ''}`),
              h('div', { class: 'muted' }, `Lv ${v.level} · ${Math.ceil(v.hp)}/${Math.round(v.maxHp)} HP · ${v.shift} shift · ${v.state}${v.nextJob ? ` → ${v.nextJob}` : ''}`),
              h('div', { class: 'bio' }, v.bio)),
            sel);
        }),
      );
    } else if (this.tab === 'monsters') {
      const key = JSON.stringify(this.monsters);
      if (key === this.renderedTab) return;
      this.renderedTab = key;
      fill(body, 
        h('p', { class: 'muted' }, 'Six monsters hide in six lairs. Learn their hours; strike while they rest.'),
        ...this.monsters.map((m) => h('div', { class: `row-card ${m.dead ? 'dead' : ''}` },
          h('div', { class: 'rc-main' },
            h('div', { class: 'rc-name' }, m.dead ? `✝ ${m.name}` : m.name),
            h('div', { class: 'muted' }, `${m.display} · ${m.region}${m.lairFound ? ' · lair found' : ' · lair hidden'}${m.level ? ` · Lv ${m.level}` : ''}${m.enraged ? ' · ENRAGED' : ''}`),
            m.seen && !m.dead ? h('div', { class: 'bio' }, m.special) : null,
            m.seenHours.length ? h('div', { class: 'bio' }, `Seen active at ${m.seenHours.map((x) => `${x}:00`).join(', ')}`) : null,
            m.hp !== null && m.maxHp ? h('div', { class: 'hp small' }, h('i', { style: `width:${(m.hp / m.maxHp) * 100}%` })) : null))),
      );
    } else if (this.tab === 'book') {
      const key = JSON.stringify([hud?.creations, hud?.pendingCreations, hud?.missingSystems]);
      if (key === this.renderedTab) return;
      this.renderedTab = key;
      const list = hud?.creations ?? [];
      fill(body, 
        h('h3', { class: 'serif' }, 'The Book of Creation'),
        list.length ? null : h('p', { class: 'muted' }, 'Nothing has been added to the world yet. Each midnight, the god whose followers offered more favor shapes it.'),
        ...[...list].reverse().map((c) => h('div', { class: `creation ${c.god}` },
          h('div', { class: 'rc-name' }, `Day ${c.day} · ${c.title}`),
          h('div', { class: 'muted' }, `${c.god === 'human' ? 'The Most High' : 'Dagon'} · ${c.domain} · scale ${c.scale}`),
          h('p', { class: 'serif' }, c.announcement))),
        hud?.pendingCreations.length ? h('p', { class: 'muted' }, `Awaiting: ${hud.pendingCreations.map((r) => `${GOD[r.god]} (day ${r.day}, scale ${r.scale})`).join(', ')}`) : null,
        h('p', { class: 'muted' }, `The world still lacks: ${(hud?.missingSystems ?? []).join(', ')}.`),
      );
    } else if (this.tab === 'chronicle') {
      const key = String(this.chronicle.length);
      if (key === this.renderedTab) return;
      this.renderedTab = key;
      fill(body, h('ol', { class: 'chron' }, ...[...this.chronicle].reverse().slice(0, 150).map((e) =>
        h('li', { class: `imp${e.importance} src-${e.source === 'core' ? 'core' : e.source === 'god' ? 'god' : 'mod'}` }, h('span', { class: 'when' }, `D${e.day} ${fmtClock(e.clockMs)}`), ' ', e.text))));
    } else if (this.tab === 'god') {
      const key = `${this.god.version}:${this.god.status}`;
      if (key === this.renderedTab) return;
      this.renderedTab = key;
      const live = this.god.live;
      fill(body, 
        h('p', {}, this.god.status || 'The gods wait for midnight.'),
        live ? h('div', { class: 'live' }, h('div', { class: 'muted' }, `${live.label} · ${live.status} · ${Math.round((Date.now() - live.startedAt) / 1000)}s${live.thinkingTokens ? ` · ~${live.thinkingTokens} thinking tokens` : ''}`), h('pre', {}, live.output.slice(-1500))) : null,
        h('ol', { class: 'chron' }, ...[...this.god.trace].reverse().slice(0, 80).map((t) => h('li', { class: `lvl-${t.level}` }, h('span', { class: 'when' }, new Date(t.t).toLocaleTimeString()), ' ', t.text, t.detail ? h('pre', { class: 'detail' }, t.detail) : null))),
      );
    } else if (this.tab === 'settings') {
      if (this.renderedTab === 'settings') return;
      this.renderedTab = 'settings';
      fill(body, 
        this.cb.settingsPanel(),
        h('button', { class: 'btn wide danger', onclick: () => { if (confirm('Abandon this island and start a new one?')) this.cb.newIsland(); } }, 'New island'),
        this.devMode ? h('div', { class: 'dev' },
          h('h3', {}, 'Dev'),
          ...[['crown', 'New champion now (F8)'], ['kill-champion', 'Kill the champion'], ['judge-human', 'Judgment: Most High 300'], ['judge-monster', 'Judgment: Dagon 300'], ['skip-8', 'Away 8 hours'], ['raid', 'Start a raid now'], ['fly', 'Fly mode (F9)'], ['install-war-hounds', 'Install war-hounds'], ['install-poison-fog', 'Install poison fog'], ['reveal', 'Toggle fog of war']].map(([c, l]) => h('button', { class: 'btn wide', onclick: () => this.cb.dev(c) }, l))) : null,
      );
    }
    body.scrollTop = scroll;
  }

  // ---------- altar ----------

  openAltar() {
    this.altarOpen = true;
    this.modal.classList.remove('hidden');
    this.cb.panelChanged(true);
    this.renderAltar(true);
  }

  closeModal() {
    this.altarOpen = false;
    this.modal.classList.add('hidden');
    this.cb.panelChanged(false);
  }

  private altarKey = '';
  private renderAltar(force = false) {
    const hud = this.hud;
    const c = hud?.champion;
    const key = JSON.stringify([hud?.fold, c?.dragging, c?.nearAltar, hud?.favor, hud?.prayer, this.villagers.filter((v) => v.inVillage).length]);
    if (!force && key === this.altarKey) return;
    this.altarKey = key;
    const prayer = h('textarea', { maxlength: '200', placeholder: 'Pray for what the Most High should make tonight…' }) as HTMLTextAreaElement;
    prayer.value = hud?.prayer ?? '';
    const near = !!c?.nearAltar;
    const forbidden = h('details', { class: 'forbidden' }, h('summary', {}, '⚠ The forbidden offering'),
      h('p', { class: 'muted' }, 'You may burn one of your own people. The elder will condemn you, and Dagon drinks the same blood: his favor rises by the same amount.'),
      ...this.villagers.filter((v) => v.inVillage).map((v) => h('button', { class: 'btn wide danger', onclick: () => {
        if (confirm(`Burn ${v.name} on the altar? (+${Math.round(v.maxHp)} favor to BOTH gods)`) && confirm('The elder will curse you. Are you certain?')) this.cb.action({ kind: 'offerVillager', id: v.id });
      } }, `${v.name.split(' ')[0]} (${Math.round(v.maxHp)})`)));
    fill(this.modal, h('div', { class: 'card altar' },
      h('button', { class: 'x', onclick: () => this.closeModal() }, '×'),
      h('div', { class: 'card-title' }, 'Altar of the Most High'),
      h('p', { class: 'muted' }, `Favor today: the Most High ${hud?.favor.human ?? 0}, Dagon ${hud?.favor.monster ?? 0}. Judgment at midnight.`),
      near ? null : h('p', { class: 'warn' }, 'You must stand at the altar to make offerings.'),
      h('button', { class: 'btn wide', ...(near && (hud?.fold ?? 0) > 0 ? {} : { disabled: true }), onclick: () => this.cb.action({ kind: 'offerLamb' }) }, `🐑 Offer a lamb (+40) · ${hud?.fold ?? 0} in the fold`),
      c?.dragging ? h('button', { class: 'btn wide gold', ...(near && c.dragging.value > 0 ? {} : { disabled: true }), onclick: () => this.cb.action({ kind: 'offerDragged' }) }, `🔥 Burn ${c.dragging.name.split(' ')[0]} (+${c.dragging.value})`) : h('p', { class: 'muted' }, 'Drag a crippled monster (or a fresh carcass) here for a far greater offering.'),
      h('div', { class: 'pray' }, prayer, h('button', { class: 'btn wide', onclick: () => this.cb.action({ kind: 'pray', text: prayer.value }) }, '🙏 Pray')),
      forbidden,
    ));
  }

  // ---------- cards ----------

  genesis(rec: CreationRecord) {
    fill(this.modal, h('div', { class: `card genesis ${rec.god}` },
      h('div', { class: 'muted' }, `Day ${rec.day} · ${rec.god === 'human' ? 'The Most High' : 'Dagon'} · ${rec.domain} · scale ${rec.scale}`),
      h('div', { class: 'card-title big' }, rec.title),
      h('p', { class: 'serif scripture' }, rec.announcement),
      h('button', { class: 'btn wide', onclick: () => this.closeModal() }, 'And it was so.'),
    ));
    this.modal.classList.remove('hidden');
    this.cb.panelChanged(true);
  }

  away(s: AwaySummary) {
    const hrs = s.hours >= 48 ? `${Math.round(s.hours / 24)} days` : `${Math.round(s.hours)} hours`;
    fill(this.modal, h('div', { class: 'card away' },
      h('div', { class: 'card-title' }, `While you were away (${hrs})`),
      s.deaths.length ? h('ul', {}, ...s.deaths.map((d) => h('li', {}, d))) : h('p', {}, 'No one was taken.'),
      ...s.events.map((e) => h('p', { class: 'muted' }, e)),
      ...s.judgments.map((j) => h('p', { class: 'serif' }, j)),
      h('p', { class: 'muted' }, `Food ${s.foodBefore} → ${s.foodAfter}.`),
      h('button', { class: 'btn wide', onclick: () => this.closeModal() }, 'To the walls'),
    ));
    this.modal.classList.remove('hidden');
    this.cb.panelChanged(true);
  }

  gameOver(winner: 'human' | 'monster', hud: Hud) {
    fill(this.modal, h('div', { class: `card gameover ${winner}` },
      h('div', { class: 'card-title big' }, winner === 'human' ? 'The island is yours' : 'The island belongs to the beasts'),
      h('p', { class: 'serif' }, winner === 'human' ? 'The last monster is dead. The hills are quiet, and the Most High rests.' : 'The last of the village is gone. Dagon feasts on the High Place.'),
      h('p', { class: 'muted' }, `Day ${hud.gameOver?.day ?? hud.day} · monsters slain ${hud.stats.monsterKills} · villagers lost ${hud.stats.villagerDeaths} · creations ${hud.creations.length}`),
      h('button', { class: 'btn wide gold', onclick: () => this.cb.newIsland() }, 'A new island'),
    ));
    this.modal.classList.remove('hidden');
  }

  askSource(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      const ta = h('textarea', { spellcheck: 'false', class: 'code', placeholder: 'export default { id: …, title: …, define(api) {}, tests: [...] }' }) as HTMLTextAreaElement;
      fill(this.modal, h('div', { class: 'card' },
        h('div', { class: 'card-title' }, 'Manual god: paste a module'),
        h('pre', { class: 'detail' }, prompt.slice(-1200)),
        ta,
        h('button', { class: 'btn wide', onclick: () => { this.closeModal(); resolve(ta.value); } }, 'Offer it to the world'),
      ));
      this.modal.classList.remove('hidden');
    });
  }
}
