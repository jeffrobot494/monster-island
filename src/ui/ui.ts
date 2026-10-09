// DOM overlay: HUD, omen cards, shrine status, banner, chronicle, inspector, dev panel.
import type { Omen } from '../god/schemas';
import type { LiveCall, TraceEntry } from '../god/pipeline';
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

/**
 * Make a streamed, still-incomplete JSON answer readable: string values are unescaped and shown under their key
 * (so a module's "source" reads as code), everything else is dropped.
 */
export function readablePartialJson(raw: string): string {
  let out = '';
  let lastKey = '';
  const stack: ('{' | '[')[] = [];
  let expectKey = false; // in an object, the next string is a key
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '{' || c === '[') {
      stack.push(c);
      expectKey = c === '{';
    } else if (c === '}' || c === ']') {
      stack.pop();
      expectKey = false;
    } else if (c === ',') expectKey = stack[stack.length - 1] === '{';
    else if (c === '"') {
      let v = '';
      let done = false;
      for (i++; i < raw.length; i++) {
        const ch = raw[i];
        if (ch === '"') {
          done = true;
          break;
        }
        if (ch !== '\\') {
          v += ch;
          continue;
        }
        const n = raw[++i];
        if (n === undefined) break;
        if (n === 'n') v += '\n';
        else if (n === 't') v += '\t';
        else if (n === 'u') {
          const hex = raw.slice(i + 1, i + 5);
          if (hex.length < 4) break;
          v += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else if (n !== 'r') v += n;
      }
      if (expectKey) {
        lastKey = v;
        expectKey = false;
      } else out += lastKey === 'source' ? `${v}${done ? '\n' : ''}` : `${lastKey}: ${v}${done ? '\n' : ''}`;
      if (!done) break;
    }
  }
  return out;
}

const fmtClock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

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
  private godlog = h('aside', { class: 'panel godlog hidden' });
  private godLive = h('div', { class: 'god-live hidden' });
  private godLiveHead = h('div', { class: 'god-live-head' });
  private godThinking = h('pre', { class: 'god-stream thinking' });
  private godThinkingBox = h('details', { class: 'hidden' }, h('summary', {}, 'Thinking'), this.godThinking);
  private godOutput = h('pre', { class: 'god-stream' });
  private godList = h('ol', { class: 'god-list' });
  private godVersion = -1;
  private godLast: TraceEntry | null = null;
  private bannerTimer = 0;
  private shownOmens: Omen[] | null = null;

  constructor(readonly cb: UiCallbacks, badge: string, devMode: boolean) {
    this.pauseBtn = h('button', { class: 'btn', title: 'Pause (space)', onclick: () => cb.onPause() }, '⏸');
    for (const s of [1, 2]) {
      const b = h('button', { class: 'btn', onclick: () => cb.onSpeed(s) }, `${s}×`);
      this.speedBtns.push(b);
    }
    const chronBtn = h('button', { class: 'btn wide', onclick: () => this.togglePanel(this.chronicle) }, '📜 Chronicle');
    const godBtn = h('button', { class: 'btn wide', title: 'What the god is doing', onclick: () => this.togglePanel(this.godlog) }, '🔮 God');
    this.shrine.addEventListener('click', () => this.togglePanel(this.godlog));
    this.shrine.title = 'Show what the god is doing';
    const hud = h('header', { class: 'hud' },
      h('div', { class: 'hud-left' }, h('strong', { class: 'title' }, 'Monster Island'), this.clock, this.pops),
      h('div', { class: 'hud-right' }, this.pauseBtn, ...this.speedBtns, chronBtn, godBtn,
        devMode ? h('button', { class: 'btn wide', onclick: () => this.togglePanel(this.dev) }, '🛠 Dev') : null,
        h('span', { class: 'badge', title: 'platform · AI provider' }, badge)),
    );
    this.chronicle.append(h('div', { class: 'panel-head' }, h('h2', {}, 'Chronicle'), h('button', { class: 'x', onclick: () => this.togglePanel(this.chronicle) }, '×')), this.chronicleList);
    this.dev.append(
      h('div', { class: 'panel-head' }, h('h2', {}, 'Dev'), h('button', { class: 'x', onclick: () => this.togglePanel(this.dev) }, '×')),
      h('p', { class: 'muted' }, 'Install a reference module directly (skips the god and validation):'),
      h('div', { class: 'row' }, ...['fireflies', 'wading', 'thrower', 'hang'].map((n) => h('button', { class: 'btn wide', onclick: () => cb.onDevInstall(n) }, n))),
      h('h3', {}, 'Modules'),
      this.devMods,
    );
    this.godLive.append(this.godLiveHead, this.godThinkingBox, this.godOutput);
    this.godlog.append(
      h('div', { class: 'panel-head' }, h('h2', {}, 'The god at work'), h('button', { class: 'x', onclick: () => this.togglePanel(this.godlog) }, '×')),
      this.godLive,
      h('h3', {}, 'Activity'),
      this.godList,
    );
    this.root.append(hud, this.shrine, this.banner, this.cards, this.chronicle, this.inspector, this.dev, this.godlog, this.manual);
    this.setSpeed(1, false);
  }

  isPanelOpen() {
    return [this.chronicle, this.inspector, this.dev, this.godlog].some((p) => !p.classList.contains('hidden')) || !this.manual.classList.contains('hidden');
  }

  private togglePanel(p: HTMLElement) {
    const opening = p.classList.contains('hidden');
    // right-hand panels share a slot
    if (opening) for (const o of [this.chronicle, this.dev, this.godlog]) if (o !== p) o.classList.add('hidden');
    p.classList.toggle('hidden');
    if (p === this.godlog) {
      this.godVersion = -1;
      this.godLast = null;
    }
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
        h('p', { class: 'change' }, o.change),
        h('div', { class: 'card-more' },
          h('p', { class: 'omen-line' }, `“${o.omen}”`),
          h('p', { class: 'visible' }, h('b', {}, 'You will see: '), o.visible),
        ),
        o.suspends.length ? h('p', { class: 'warn' }, `⚠ This bends the island's laws: ${o.suspends.map((s) => SUSPEND_TEXT[s] ?? s).join('; ')}.`) : null,
      ));
    });
    this.cards.append(
      h('div', { class: 'omens-head' }, h('h2', {}, 'The god offers three omens'), h('span', { class: 'muted' }, 'Choose whenever you like. Hover a card for more.')),
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

  openGodLog() {
    if (this.godlog.classList.contains('hidden')) this.togglePanel(this.godlog);
  }

  /** The god panel; cheap to call often (redraws only when open and something changed). */
  setGodActivity(trace: TraceEntry[], live: LiveCall | null, version: number) {
    if (this.godlog.classList.contains('hidden')) return;
    if (live) {
      const secs = Math.floor((Date.now() - live.startedAt) / 1000);
      const out = live.output.length;
      this.godLiveHead.replaceChildren(
        h('b', {}, live.label),
        h('span', { class: 'muted' }, ` · ${live.status}${live.thinkingTokens ? ` (~${live.thinkingTokens.toLocaleString()} thinking tokens)` : ''} · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}${out ? ` · ${(out / 1024).toFixed(1)} KB written` : ''}`),
      );
    }
    if (version === this.godVersion) return;
    this.godVersion = version;
    this.godLive.classList.toggle('hidden', !live);
    if (live) {
      this.godThinkingBox.classList.toggle('hidden', !live.thinking);
      this.godThinking.textContent = live.thinking.slice(-4000);
      const stick = this.godOutput.scrollTop + this.godOutput.clientHeight >= this.godOutput.scrollHeight - 30;
      this.godOutput.textContent = live.output ? readablePartialJson(live.output) : live.thinkingTokens ? 'The god is thinking. Its words appear here as it writes…' : 'Waiting for the first words…';
      if (stick) this.godOutput.scrollTop = this.godOutput.scrollHeight;
    }
    const last = this.godLast ? trace.lastIndexOf(this.godLast) : -1;
    if (last === trace.length - 1 && this.godLast) return;
    const stick = this.godlog.scrollTop + this.godlog.clientHeight >= this.godlog.scrollHeight - 40;
    const row = (e: TraceEntry) => h('li', { class: `lvl-${e.level}` },
      h('span', { class: 'time' }, fmtClock(e.t)),
      e.detail ? h('details', {}, h('summary', {}, e.text), h('pre', {}, e.detail)) : h('span', {}, e.text),
    );
    // append only what's new so expanded details stay open; rebuild if the start of the log was trimmed
    if (last < 0 || this.godList.children.length > 400) this.godList.replaceChildren(...trace.map(row));
    else this.godList.append(...trace.slice(last + 1).map(row));
    if (!trace.length) this.godList.replaceChildren(h('li', { class: 'muted' }, 'Nothing yet. Activity appears here as the god works.'));
    this.godLast = trace[trace.length - 1] ?? null;
    if (stick) this.godlog.scrollTop = this.godlog.scrollHeight;
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
