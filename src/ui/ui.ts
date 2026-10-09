// DOM overlay: HUD, omen cards, shrine status, banner, chronicle, inspector, dev panel.
import type { Omen } from '../god/schemas';
import type { InspectInfo, ModuleStat } from '../protocol';
import type { ChronicleEvent } from '../sim/types';
import { timeInfo } from '../sim/time';

type Attrs = Record<string, string | boolean | ((ev: any) => void)>;
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string | null | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false) el.setAttribute(k, v);
  }
  for (const c of kids) if (c !== null && c !== false) el.append(c);
  return el;
}

const TONE_ICON: Record<string, string> = { cozy: '☕', eerie: '🌫', chaotic: '🌀', social: '🎉', wild: '🌿' };
const SUSPEND_TEXT: Record<string, string> = { eat: 'some days nobody may eat', sleep: 'some nights nobody may sleep', 'faction-survival': 'a whole people may perish' };

export interface UiCallbacks {
  onSpeed(speed: number): void;
  onPause(): void;
  onChoose(i: number | 'god', whisper: string): void;
  onShowMe(): void;
  onCloseInspector(): void;
  onToggleModule(id: string, active: boolean): void;
  onDevInstall(name: string): void;
  onPanelChange(): void;
}

export class Ui {
  root = document.getElementById('ui')!;
  private clock = h('span', { class: 'clock' });
  private pops = h('span', { class: 'pops' });
  private speedBtns: HTMLButtonElement[] = [];
  private pauseBtn: HTMLButtonElement;
  private shrine = h('div', { class: 'shrine-status' });
  private cards = h('div', { class: 'omens hidden' });
  private banner = h('div', { class: 'banner hidden' });
  private chronicle = h('aside', { class: 'panel chronicle hidden' });
  private chronicleList = h('ol', { class: 'chronicle-list' });
  private inspector = h('aside', { class: 'panel inspector hidden' });
  private dev = h('aside', { class: 'panel dev hidden' });
  private devMods = h('div');
  private manual = h('div', { class: 'manual hidden' });
  private bannerTimer = 0;
  private shownOmens: Omen[] | null = null;

  constructor(private cb: UiCallbacks, badge: string, devMode: boolean) {
    this.pauseBtn = h('button', { class: 'btn', title: 'Pause (space)', onclick: () => cb.onPause() }, '⏸');
    for (const s of [1, 2]) {
      const b = h('button', { class: 'btn', onclick: () => cb.onSpeed(s) }, `${s}×`);
      this.speedBtns.push(b);
    }
    const chronBtn = h('button', { class: 'btn wide', onclick: () => this.togglePanel(this.chronicle) }, '📜 Chronicle');
    const hud = h('header', { class: 'hud' },
      h('div', { class: 'hud-left' }, h('strong', { class: 'title' }, 'Monster Island'), this.clock, this.pops),
      h('div', { class: 'hud-right' }, this.pauseBtn, ...this.speedBtns, chronBtn,
        devMode ? h('button', { class: 'btn wide', onclick: () => this.togglePanel(this.dev) }, '🛠 Dev') : null,
        h('span', { class: 'badge', title: 'platform · AI provider' }, badge)),
    );
    this.chronicle.append(h('div', { class: 'panel-head' }, h('h2', {}, 'Chronicle'), h('button', { class: 'x', onclick: () => this.togglePanel(this.chronicle) }, '×')), this.chronicleList);
    this.dev.append(
      h('div', { class: 'panel-head' }, h('h2', {}, 'Dev'), h('button', { class: 'x', onclick: () => this.togglePanel(this.dev) }, '×')),
      h('p', { class: 'muted' }, 'Install a reference module directly (skips the god and validation):'),
      h('div', { class: 'row' }, h('button', { class: 'btn wide', onclick: () => cb.onDevInstall('fireflies') }, 'fireflies'), h('button', { class: 'btn wide', onclick: () => cb.onDevInstall('wading') }, 'wading')),
      h('h3', {}, 'Modules'),
      this.devMods,
    );
    this.root.append(hud, this.shrine, this.banner, this.cards, this.chronicle, this.inspector, this.dev, this.manual);
    this.setSpeed(1, false);
  }

  isPanelOpen() {
    return [this.chronicle, this.inspector, this.dev].some((p) => !p.classList.contains('hidden')) || !this.manual.classList.contains('hidden');
  }

  private togglePanel(p: HTMLElement) {
    p.classList.toggle('hidden');
    this.cb.onPanelChange();
  }

  setSpeed(speed: number, paused: boolean) {
    this.speedBtns.forEach((b, i) => b.classList.toggle('on', !paused && speed === i + 1));
    this.pauseBtn.classList.toggle('on', paused);
    this.pauseBtn.textContent = paused ? '▶' : '⏸';
  }

  setTime(tick: number) {
    const t = timeInfo(tick);
    this.clock.textContent = `Day ${t.day + 1} · ${String(t.hour).padStart(2, '0')}:00 ${t.isNight ? '☾' : '☀'}`;
  }

  setPops(monsters: number, humans: number) {
    this.pops.textContent = `👹 ${monsters}  🧑 ${humans}`;
  }

  setShrine(text: string, stage: number) {
    this.shrine.textContent = text;
    this.shrine.dataset.stage = String(stage);
  }

  showOmens(omens: Omen[] | null) {
    if (omens === this.shownOmens) return;
    this.shownOmens = omens;
    this.cards.replaceChildren();
    if (!omens) {
      this.cards.classList.add('hidden');
      return;
    }
    const whisper = h('input', { class: 'whisper', maxlength: '140', placeholder: 'Whisper a wish to the god (optional)…' }) as HTMLInputElement;
    const list = h('div', { class: 'cards' });
    omens.forEach((o, i) => {
      list.append(h('button', { class: `card tone-${o.tone}`, onclick: () => this.cb.onChoose(i, whisper.value) },
        h('div', { class: 'card-tone' }, `${TONE_ICON[o.tone] ?? '✦'} ${o.tone}`),
        h('h3', {}, o.title),
        h('p', { class: 'omen-line' }, `“${o.omen}”`),
        h('p', { class: 'change' }, o.change),
        h('p', { class: 'visible' }, h('b', {}, 'You will see: '), o.visible),
        o.suspends.length ? h('p', { class: 'warn' }, `⚠ This bends the island's laws: ${o.suspends.map((s) => SUSPEND_TEXT[s] ?? s).join('; ')}.`) : null,
      ));
    });
    this.cards.append(
      h('div', { class: 'omens-head' }, h('h2', {}, 'The god offers three omens'), h('span', { class: 'muted' }, 'The island holds its breath while you choose.')),
      list,
      h('div', { class: 'omens-foot' }, whisper, h('button', { class: 'btn wide', onclick: () => this.cb.onChoose('god', whisper.value) }, '🎲 Let the god decide')),
    );
    this.cards.classList.remove('hidden');
  }

  showBanner(text: string, showMe: boolean, seconds = 7) {
    clearTimeout(this.bannerTimer);
    this.banner.replaceChildren(h('span', {}, text), ...(showMe ? [h('button', { class: 'btn wide', onclick: () => this.cb.onShowMe() }, 'Show me')] : []));
    this.banner.classList.remove('hidden');
    this.bannerTimer = window.setTimeout(() => this.banner.classList.add('hidden'), seconds * 1000);
  }

  setChronicle(events: ChronicleEvent[]) {
    this.chronicleList.replaceChildren(...events.slice().reverse().map((e) => h('li', { class: `imp-${e.importance} src-${e.source === 'core' ? 'core' : e.source === 'god' ? 'god' : 'mod'}` }, h('span', { class: 'day' }, `Day ${e.day + 1}`), e.text)));
  }

  setInspector(info: InspectInfo | null) {
    if (!info) {
      this.inspector.classList.add('hidden');
      return;
    }
    const bar = (v: number, max: number, cls: string) => h('div', { class: `bar ${cls}` }, h('i', { style: `width:${Math.max(0, Math.min(100, (v / max) * 100))}%` }));
    const mods = Object.entries(info.data).filter(([, d]) => d && Object.keys(d as object).length);
    this.inspector.replaceChildren(...([
      h('div', { class: 'panel-head' }, h('h2', {}, info.name ?? info.kind), h('button', { class: 'x', onclick: () => this.cb.onCloseInspector() }, '×')),
      h('p', { class: 'muted' }, info.faction ? `${info.faction} · ${info.behavior || 'idle'}` : info.kind),
      info.faction ? h('div', { class: 'stat' }, h('span', {}, `Hunger ${Math.round(info.hunger)}`), bar(info.hunger, 100, 'hunger')) : null,
      info.faction ? h('div', { class: 'stat' }, h('span', {}, `HP ${Math.ceil(info.hp)} / ${Math.round(info.maxHp)}`), bar(info.hp, info.maxHp, 'hp')) : null,
      info.tags.length ? h('p', {}, h('b', {}, 'Tags: '), info.tags.join(', ')) : null,
      ...mods.map(([id, d]) => h('details', { open: true }, h('summary', {}, id), h('pre', {}, JSON.stringify(d, null, 1).slice(0, 600)))),
    ] as (HTMLElement | null)[]).filter((x): x is HTMLElement => !!x));
    if (this.inspector.classList.contains('hidden')) {
      this.inspector.classList.remove('hidden');
      this.cb.onPanelChange();
    }
  }

  setModuleStats(stats: ModuleStat[], titles: Record<string, string>) {
    if (this.dev.classList.contains('hidden')) return;
    this.devMods.replaceChildren(
      ...(stats.length ? stats : []).map((s) => h('div', { class: `devmod ${s.status}` },
        h('div', {}, h('b', {}, titles[s.id] ?? s.id), h('div', { class: 'muted' }, `${s.id} · ${s.status} · ${s.msPerTick.toFixed(2)} ms/tick · faults today ${s.faultsToday}`)),
        h('button', { class: 'btn wide', onclick: () => this.cb.onToggleModule(s.id, s.status !== 'active') }, s.status === 'active' ? 'Disable' : 'Enable'),
      )),
      stats.length ? '' : h('p', { class: 'muted' }, 'No modules installed yet.'),
    );
  }

  /** ManualProvider: ask a human to paste module source. */
  askSource(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      const ta = h('textarea', { spellcheck: 'false', placeholder: 'export default { id: …, title: …, define(api) {}, tests: [...] }' }) as HTMLTextAreaElement;
      this.manual.replaceChildren(
        h('h2', {}, 'Manual god: paste a module'),
        h('pre', { class: 'manual-prompt' }, prompt.slice(-1500)),
        ta,
        h('button', { class: 'btn wide', onclick: () => {
          this.manual.classList.add('hidden');
          this.cb.onPanelChange();
          resolve(ta.value);
        } }, 'Offer it to the island'),
      );
      this.manual.classList.remove('hidden');
      this.cb.onPanelChange();
    });
  }
}
