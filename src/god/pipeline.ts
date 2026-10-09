// The god's cycle (§8): idle → propose → choose → implement → validate → repair (≤2) → staged → active at dawn.
import { AiRateLimitError, type AiProvider } from './providers/ai-provider';
import { IMPLEMENT_SCHEMA, PROPOSE_SCHEMA, checkAgainstSchema, normalizeOmens, type Omen } from './schemas';
import { IMPLEMENT_SYSTEM, PROPOSE_SYSTEM, implementUser, proposeUser, repairUser } from './prompts';
import { emptyHistory, observe, type PlayerHistory } from './observe';
import type { SavedWorld } from '../sim/island';
import type { ChronicleEvent } from '../sim/types';
import type { Suspendable, ValidationReport, ValidationRequest } from '../sim/validator';

export const MAX_ATTEMPTS = 3;
const REST_MS = 10 * 60_000;
const PROPOSE_RETRY_MS = 60_000;

export interface Job {
  omen: Omen;
  id: string;
  chosenBy: 'player' | 'god';
  attempt: number; // 1..3
  phase: 'implement' | 'validate' | 'staged';
  source: string | null;
  notes: string;
  report: ValidationReport | null;
  messages: { role: 'user' | 'assistant'; content: string }[];
  providerFailures: number;
}

export interface PendingState {
  v: 1;
  omens: Omen[] | null;
  nextOmens: Omen[] | null;
  job: Job | null;
  usedIds: string[];
  history: PlayerHistory;
  usage: { input: number; output: number; calls: number };
}

export interface PipelineHost {
  provider: AiProvider;
  loadPending(): Promise<string | null>;
  savePending(json: string): Promise<void>;
  /** a fresh SavedWorld JSON of the live island */
  snapshotWorld(): Promise<string>;
  sources(): Record<string, string>;
  chronicle(): ChronicleEvent[];
  log(text: string, importance: number): void;
  validate(req: ValidationRequest, onStage: (s: string) => void): Promise<ValidationReport>;
  install(id: string, source: string): Promise<{ ok: boolean; error?: string }>;
  onActivated(job: Job): void;
  onChange(): void;
  isHidden(): boolean;
  pick(n: number): number; // "let the god decide"
}

export function slugId(title: string, used: string[]): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '') || 'work';
  let n = 1;
  while (used.includes(`${slug}-${n}`)) n++;
  return `${slug}-${n}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GodPipeline {
  state: PendingState = { v: 1, omens: null, nextOmens: null, job: null, usedIds: [], history: emptyHistory(), usage: { input: 0, output: 0, calls: 0 } };
  status = 'The god stirs…';
  /** 0 idle/choosing, 1 pondering/shaping, 2 testing, 3 ready */
  stage = 0;
  busy = false;
  private restingUntil = 0;
  private running = false;
  private stopped = false;

  constructor(private host: PipelineHost) {}

  async load() {
    const raw = await this.host.loadPending();
    if (raw) {
      try {
        const s = JSON.parse(raw) as PendingState;
        if (s.v === 1) this.state = { ...this.state, ...s, history: { ...emptyHistory(), ...s.history } };
      } catch {
        /* corrupt pending: start fresh */
      }
    }
    this.refreshStatus();
  }

  private async persist() {
    this.refreshStatus();
    this.host.onChange();
    await this.host.savePending(JSON.stringify(this.state));
  }

  private setStatus(status: string, stage: number) {
    this.status = status;
    this.stage = stage;
    this.host.onChange();
  }

  refreshStatus() {
    const j = this.state.job;
    if (this.restingUntil > Date.now()) this.setStatus('The god is resting…', 0);
    else if (!j) this.setStatus(this.state.omens ? 'The god awaits your choice.' : 'The god ponders…', this.state.omens ? 0 : 1);
    else if (j.phase === 'staged') this.setStatus(`The work is ready. It will be revealed at dawn.`, 3);
    else if (j.phase === 'validate') this.setStatus(j.attempt > 1 ? `The god tests… (${j.attempt}/${MAX_ATTEMPTS})` : 'The god tests…', 2);
    else this.setStatus(j.attempt > 1 ? `The god is displeased, tries again (${j.attempt}/${MAX_ATTEMPTS})` : 'The god shapes…', 1);
  }

  /** True when the omen cards should be up (and the simulation paused). */
  get choosing(): boolean {
    return !!this.state.omens && !this.state.job;
  }

  stop() {
    this.stopped = true;
  }

  /** Start (or continue) driving the cycle. Safe to call any time. */
  kick() {
    if (this.running || this.stopped) return;
    this.running = true;
    this.drive().finally(() => {
      this.running = false;
    });
  }

  private async drive() {
    for (;;) {
      if (this.stopped) return;
      if (this.host.isHidden()) {
        await sleep(1000);
        continue;
      }
      if (this.restingUntil > Date.now()) {
        this.refreshStatus();
        await sleep(Math.min(5000, this.restingUntil - Date.now()));
        continue;
      }
      const j = this.state.job;
      if (j?.phase === 'implement') await this.implement(j);
      else if (j?.phase === 'validate') await this.validate(j);
      else if (j?.phase === 'staged') {
        if (this.state.nextOmens) return; // wait for dawn
        const omens = await this.propose();
        if (omens) {
          this.state.nextOmens = omens;
          await this.persist();
        }
      } else if (this.state.omens) return; // wait for the petitioner
      else {
        const omens = await this.propose();
        if (omens) {
          this.state.omens = omens;
          await this.persist();
        }
      }
    }
  }

  private async world(): Promise<{ json: string; world: SavedWorld }> {
    const json = await this.host.snapshotWorld();
    return { json, world: JSON.parse(json) };
  }

  private track(u: { input: number; output: number }) {
    this.state.usage.input += u.input;
    this.state.usage.output += u.output;
    this.state.usage.calls++;
  }

  private rest(err: unknown): boolean {
    if (err instanceof AiRateLimitError) {
      this.restingUntil = Date.now() + REST_MS;
      this.host.log('The god is resting. It will return in a while.', 1);
      this.refreshStatus();
      return true;
    }
    return false;
  }

  private async propose(): Promise<Omen[] | null> {
    if (!this.state.job) this.setStatus('The god ponders…', 1);
    this.busy = true;
    try {
      const { world } = await this.world();
      const obs = observe(world, this.host.chronicle(), this.state.history);
      const r = await this.host.provider.complete({ role: 'propose', system: PROPOSE_SYSTEM, messages: [{ role: 'user', content: proposeUser(obs, this.state.history.whisper) }], schema: PROPOSE_SCHEMA, maxTokens: 2000 });
      this.track(r.usage);
      this.state.history.whisper = null;
      return normalizeOmens(r.data);
    } catch (err) {
      if (!this.rest(err)) {
        console.warn('[god] propose failed:', err);
        if (!this.state.job) this.setStatus('The god’s thoughts scatter… (retrying soon)', 1);
        await sleep(PROPOSE_RETRY_MS);
      }
      return null;
    } finally {
      this.busy = false;
    }
  }

  async choose(index: number | 'god', whisper?: string) {
    const omens = this.state.omens;
    if (!omens || this.state.job) return;
    const i = index === 'god' ? this.host.pick(omens.length) : index;
    const omen = omens[i];
    if (!omen) return;
    const id = slugId(omen.title, this.state.usedIds);
    this.state.usedIds.push(id);
    this.state.history.ignored.push(...omens.filter((_, k) => k !== i).map((o) => o.title));
    this.state.history.ignored = this.state.history.ignored.slice(-12);
    if (whisper?.trim()) this.state.history.whisper = whisper.trim().slice(0, 140);
    this.state.job = { omen, id, chosenBy: index === 'god' ? 'god' : 'player', attempt: 1, phase: 'implement', source: null, notes: '', report: null, messages: [], providerFailures: 0 };
    this.state.omens = null;
    this.host.log(`The petitioner ${index === 'god' ? 'left the choice to the god' : 'chose'}: ${omen.title}.`, 1);
    await this.persist();
    this.kick();
  }

  private async implement(j: Job) {
    this.refreshStatus();
    this.busy = true;
    try {
      if (!j.messages.length) {
        const { world } = await this.world();
        const obs = observe(world, this.host.chronicle(), this.state.history);
        const sources = this.host.sources();
        const buildsOn = j.omen.builds_on.filter((id) => sources[id]).slice(0, 2).map((id) => ({ id, source: sources[id] }));
        const others = world.manifest.filter((m) => !j.omen.builds_on.includes(m.id)).map((m) => ({ id: m.id, title: m.title, description: m.description }));
        j.messages.push({ role: 'user', content: implementUser(obs, j.omen, j.id, buildsOn, others) });
      }
      const r = await this.host.provider.complete({ role: j.attempt === 1 ? 'implement' : 'repair', system: IMPLEMENT_SYSTEM, messages: j.messages, schema: IMPLEMENT_SCHEMA, maxTokens: 16000 });
      this.track(r.usage);
      const bad = checkAgainstSchema(r.data, IMPLEMENT_SCHEMA);
      if (bad) throw new Error(`implementation did not match the schema: ${bad}`);
      const { source, notes } = r.data as { source: string; notes: string };
      j.source = source.replace(/^\s*```(?:js|javascript)?\s*\n([\s\S]*?)\n```\s*$/, '$1');
      j.notes = notes;
      j.messages.push({ role: 'assistant', content: `\`\`\`js\n${j.source}\n\`\`\`\nNotes: ${notes}` });
      j.phase = 'validate';
      await this.persist();
    } catch (err) {
      if (this.rest(err)) return;
      console.warn('[god] implement failed:', err);
      j.providerFailures++;
      if (j.providerFailures > 1) await this.abandon(j, `the god could not find the words (${(err as Error).message})`);
      else {
        await this.persist();
        await sleep(5000);
      }
    } finally {
      this.busy = false;
    }
  }

  private async validate(j: Job) {
    this.refreshStatus();
    this.busy = true;
    try {
      const { json } = await this.world();
      const report = await this.host.validate(
        { world: json, sources: this.host.sources(), candidate: { id: j.id, source: j.source! }, suspends: j.omen.suspends as Suspendable[] },
        (s) => this.setStatus(`The god tests… (${s})`, 2),
      );
      if (this.state.job !== j) return;
      j.report = report;
      if (report.ok) {
        j.phase = 'staged';
        this.host.log(`The god's work "${j.omen.title}" is ready. It will be revealed at dawn.`, 1);
        await this.persist();
        return;
      }
      console.info('[god] validation failed', JSON.stringify({ checks: report.checks, errors: report.errors, tests: report.tests }));
      if (j.attempt >= MAX_ATTEMPTS) {
        await this.abandon(j, report.checks.find((c) => !c.ok)?.message ?? 'it failed its trials');
        return;
      }
      j.attempt++;
      j.messages.push({ role: 'user', content: repairUser(report, j.attempt - 1) });
      j.phase = 'implement';
      await this.persist();
    } finally {
      this.busy = false;
    }
  }

  private async abandon(j: Job, why: string) {
    console.warn(`[god] abandoned ${j.id}: ${why}`);
    this.host.log(`The god's attempt at ${j.omen.title} crumbled to dust.`, 2);
    this.state.history.abandoned.push(j.omen.title);
    this.state.job = null;
    await this.persist();
  }

  /** Called at every dawn: activates a staged work. */
  async onDawn() {
    const j = this.state.job;
    if (!j || j.phase !== 'staged' || !j.source) return;
    const r = await this.host.install(j.id, j.source);
    if (!r.ok) {
      await this.abandon(j, `install failed at dawn: ${r.error}`);
      this.kick();
      return;
    }
    this.state.history.picked.push({ title: j.omen.title, day: 0, chosenBy: j.chosenBy });
    this.host.log(`The god has spoken: ${j.omen.title}.`, 3);
    this.state.job = null;
    this.state.omens = this.state.nextOmens;
    this.state.nextOmens = null;
    await this.persist();
    this.host.onActivated(j);
    this.kick();
  }
}
