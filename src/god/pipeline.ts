// The creation cycle (§11.1, R23, R30): pending Judgment → decree → implement → validate → repair (≤2) → install.
import { AiRateLimitError, type AiProvider, type AiRequest, type AiResponse } from './providers/ai-provider';
import { DECREE_SCHEMA, IMPLEMENT_SCHEMA, checkAgainstSchema, normalizeDecree, type Decree } from './schemas';
import { IMPLEMENT_SYSTEM, decreeSystem, decreeUser, implementUser, repairUser } from './prompts';
import { observe } from './observe';
import type { SavedWorld } from '../sim/island';
import type { ChronicleEvent, CreationRecord, CreationRequest, Faction } from '../sim/types';
import type { ValidationReport, ValidationRequest } from '../sim/validator';

export const MAX_ATTEMPTS = 3;
const REST_MS = 10 * 60_000;
const DOMAINS = ['creatures', 'weather', 'sky', 'land', 'plants', 'bodies', 'laws'];
export const GOD_NAME: Record<Faction, string> = { human: 'The Most High', monster: 'Dagon' };

export interface Job {
  req: CreationRequest;
  id: string;
  allowed: string[];
  decree: Decree | null;
  attempt: number;
  phase: 'decree' | 'implement' | 'validate' | 'install';
  source: string | null;
  notes: string;
  report: ValidationReport | null;
  messages: { role: 'user' | 'assistant'; content: string }[];
  providerFailures: number;
  decreeRetries: number;
}

export interface PendingState {
  v: 2;
  job: Job | null;
  usedIds: string[];
  usage: { input: number; output: number; calls: number };
}

export interface TraceEntry {
  t: number;
  level: 'info' | 'ok' | 'warn' | 'error';
  text: string;
  detail?: string;
}

export interface LiveCall {
  label: string;
  startedAt: number;
  status: string;
  thinking: string;
  thinkingTokens: number;
  output: string;
}

export interface PipelineHost {
  provider: AiProvider;
  loadPending(): Promise<string | null>;
  savePending(json: string): Promise<void>;
  snapshotWorld(): Promise<string>;
  sources(): Record<string, string>;
  chronicle(): ChronicleEvent[];
  /** the live sim's pending creation queue and domain history (from the HUD) */
  pending(): CreationRequest[];
  domainHistory(): Record<Faction, { night: number; domain: string }[]>;
  log(text: string, importance: number): void;
  validate(req: ValidationRequest, onStage: (s: string) => void): Promise<ValidationReport>;
  install(id: string, source: string, record: CreationRecord, night: number): Promise<{ ok: boolean; error?: string }>;
  failed(night: number): void;
  onCreated(record: CreationRecord): void;
  onChange(): void;
  isHidden(): boolean;
}

export function slugId(title: string, used: string[]): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '') || 'creation';
  let n = 1;
  while (used.includes(`${slug}-${n}`)) n++;
  return `${slug}-${n}`;
}

/** Variety rule, computed when the job starts (R23). */
export function domainsFor(history: Record<Faction, { night: number; domain: string }[]>, god: Faction, night: number, scale: number): string[] {
  const recent = new Set(history[god].filter((d) => d.night >= night - 3 && d.night < night).map((d) => d.domain));
  const out = DOMAINS.filter((d) => !recent.has(d));
  if (scale >= 4 && !recent.has('fundamental')) out.push('fundamental');
  return out.length ? out : [...DOMAINS];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class CreationPipeline {
  state: PendingState = { v: 2, job: null, usedIds: [], usage: { input: 0, output: 0, calls: 0 } };
  status = '';
  trace: TraceEntry[] = [];
  live: LiveCall | null = null;
  traceVersion = 0;
  private restingUntil = 0;
  private running = false;
  private stopped = false;
  /** nights finished in this session (the HUD's pending list lags a moment behind) */
  private done = new Set<number>();

  constructor(private host: PipelineHost) {}

  async load() {
    const raw = await this.host.loadPending();
    if (raw) {
      try {
        const s = JSON.parse(raw) as PendingState;
        if (s.v === 2) this.state = { ...this.state, ...s };
      } catch {
        /* corrupt: start fresh */
      }
    }
    this.refreshStatus();
  }

  note(text: string, level: TraceEntry['level'] = 'info', detail?: string) {
    this.trace.push({ t: Date.now(), level, text, detail });
    console.info(`[god] ${text}`);
    if (this.trace.length > 300) this.trace.splice(0, this.trace.length - 300);
    this.traceVersion++;
  }

  private async call(label: string, req: Omit<AiRequest, 'onProgress'>): Promise<AiResponse> {
    const live: LiveCall = { label, startedAt: Date.now(), status: 'sending the petition', thinking: '', thinkingTokens: 0, output: '' };
    this.live = live;
    this.traceVersion++;
    const kb = (req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0)) / 1024;
    this.note(`${label}: asking ${this.host.provider.name} (${kb.toFixed(1)} KB prompt)`);
    try {
      const r = await this.host.provider.complete({
        ...req,
        onProgress: (p) => {
          if (p.kind === 'status') {
            live.status = p.text;
            this.note(`${label}: ${p.text}`);
          } else if (p.kind === 'thinking') live.thinkingTokens = p.tokens;
          else if (p.channel === 'thinking') live.thinking += p.text;
          else {
            live.output += p.text;
            live.status = 'writing the answer';
          }
          this.traceVersion++;
        },
      });
      const secs = r.seconds ?? (Date.now() - live.startedAt) / 1000;
      this.note(`${label}: answered in ${secs.toFixed(0)}s${r.model ? ` by ${r.model}` : ''}`, 'ok');
      return r;
    } catch (err) {
      this.note(`${label}: ${err instanceof AiRateLimitError ? 'usage limit reached' : 'call failed'}: ${(err as Error).message}`, 'error');
      throw err;
    } finally {
      if (this.live === live) this.live = null;
      this.traceVersion++;
    }
  }

  private async persist() {
    this.refreshStatus();
    await this.host.savePending(JSON.stringify(this.state));
  }

  refreshStatus() {
    const j = this.state.job;
    const god = j ? GOD_NAME[j.req.god] : '';
    if (this.restingUntil > Date.now()) this.status = 'The gods are resting…';
    else if (!j) this.status = '';
    else if (j.phase === 'decree') this.status = `${god} ponders tonight's creation…`;
    else if (j.phase === 'validate') this.status = `${god} tests the work${j.attempt > 1 ? ` (${j.attempt}/${MAX_ATTEMPTS})` : ''}…`;
    else this.status = `${god} is shaping the world${j.attempt > 1 ? ` (again, ${j.attempt}/${MAX_ATTEMPTS})` : ''}…`;
    this.host.onChange();
  }

  stop() {
    this.stopped = true;
  }

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
      let j = this.state.job;
      if (j && !this.host.pending().some((r) => r.night === j!.req.night)) {
        // the sim no longer wants this night (installed elsewhere, or dropped from the cap)
        this.state.job = null;
        await this.persist();
        continue;
      }
      if (!j) {
        const req = this.host.pending().find((r) => !this.done.has(r.night));
        if (!req) return;
        const allowed = domainsFor(this.host.domainHistory(), req.god, req.night, req.scale);
        j = { req, id: '', allowed, decree: null, attempt: 1, phase: 'decree', source: null, notes: '', report: null, messages: [], providerFailures: 0, decreeRetries: 0 };
        this.state.job = j;
        this.note(`Night ${req.night}: ${GOD_NAME[req.god]} won ${req.tallies.human}–${req.tallies.monster} (favor ${req.favor}, scale ${req.scale}). Allowed: ${allowed.join(', ')}`, 'info');
        await this.persist();
      }
      if (j.phase === 'decree') await this.decree(j);
      else if (j.phase === 'implement') await this.implement(j);
      else if (j.phase === 'validate') await this.validate(j);
      else if (j.phase === 'install') await this.install(j);
    }
  }

  private async world(): Promise<SavedWorld> {
    return JSON.parse(await this.host.snapshotWorld());
  }

  private track(u: { input: number; output: number }) {
    this.state.usage.input += u.input;
    this.state.usage.output += u.output;
    this.state.usage.calls++;
  }

  private rest(err: unknown): boolean {
    if (err instanceof AiRateLimitError) {
      this.restingUntil = Date.now() + REST_MS;
      this.note(`Usage limit reached; resting ${REST_MS / 60000} minutes`, 'warn');
      this.refreshStatus();
      return true;
    }
    return false;
  }

  private async failProvider(j: Job, err: unknown) {
    if (this.rest(err)) return;
    j.providerFailures++;
    this.note(j.providerFailures > 2 ? 'The god could not find the words three times; giving up' : 'Call failed; retrying in 10s', 'warn', (err as Error).message);
    if (j.providerFailures > 2) await this.abandon(j, `the god could not find the words (${(err as Error).message})`);
    else {
      await this.persist();
      await sleep(10_000);
    }
  }

  private async decree(j: Job) {
    try {
      const obs = observe(await this.world(), this.host.chronicle());
      const r = await this.call(`${GOD_NAME[j.req.god]} decrees`, {
        role: 'propose', system: decreeSystem(j.req.god), messages: [{ role: 'user', content: decreeUser(obs, j.req, j.allowed) }],
        schema: DECREE_SCHEMA, maxTokens: 2000, jobKey: `decree:${j.req.night}:${j.req.god}:${j.decreeRetries}`,
      });
      this.track(r.usage);
      const d = normalizeDecree(r.data);
      if (!j.allowed.includes(d.domain)) {
        j.decreeRetries++;
        this.note(`Decree used a forbidden domain (${d.domain})`, 'warn');
        if (j.decreeRetries > 1) return this.abandon(j, `it broke the variety rule (${d.domain})`);
        return this.persist();
      }
      j.decree = d;
      j.id = slugId(d.title, this.state.usedIds);
      this.state.usedIds.push(j.id);
      j.phase = 'implement';
      this.note(`Decree: "${d.title}" (${d.domain})`, 'ok', `${d.announcement}\n\n${d.mechanic}`);
      this.host.log(`${GOD_NAME[j.req.god]} begins to shape: ${d.title}.`, 1);
      await this.persist();
    } catch (err) {
      await this.failProvider(j, err);
    }
  }

  private async implement(j: Job) {
    try {
      if (!j.messages.length) {
        const world = await this.world();
        const obs = observe(world, this.host.chronicle());
        j.messages.push({ role: 'user', content: implementUser(obs, j.req, j.decree!, j.id, world.manifest.map((m) => ({ id: m.id, title: m.title, description: m.description }))) });
      }
      const label = j.attempt === 1 ? `Write "${j.decree!.title}"` : `Repair "${j.decree!.title}" (${j.attempt}/${MAX_ATTEMPTS})`;
      const r = await this.call(label, { role: j.attempt === 1 ? 'implement' : 'repair', system: IMPLEMENT_SYSTEM, messages: j.messages, schema: IMPLEMENT_SCHEMA, maxTokens: 16000, jobKey: `impl:${j.id}:${j.attempt}` });
      this.track(r.usage);
      const bad = checkAgainstSchema(r.data, IMPLEMENT_SCHEMA);
      if (bad) throw new Error(`implementation did not match the schema: ${bad}`);
      const { source, notes } = r.data as { source: string; notes: string };
      j.source = source.replace(/^\s*```(?:js|javascript)?\s*\n([\s\S]*?)\n```\s*$/, '$1');
      j.notes = notes;
      this.note(`Module written: ${j.source.split('\n').length} lines`, 'ok', notes);
      j.messages.push({ role: 'assistant', content: `\`\`\`js\n${j.source}\n\`\`\`\nNotes: ${notes}` });
      j.phase = 'validate';
      await this.persist();
    } catch (err) {
      await this.failProvider(j, err);
    }
  }

  private async validate(j: Job) {
    const json = await this.host.snapshotWorld();
    this.note(`Validating attempt ${j.attempt}/${MAX_ATTEMPTS}`);
    const t0 = Date.now();
    const report = await this.host.validate({ world: json, sources: this.host.sources(), candidate: { id: j.id, source: j.source! }, suspends: [] }, (s) => {
      this.status = `${GOD_NAME[j.req.god]} tests the work (${s})…`;
      this.host.onChange();
    });
    if (this.state.job !== j) return;
    j.report = report;
    const lines = [
      ...report.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.check}${c.ok ? '' : `: ${c.message}`}`),
      ...report.tests.map((t) => `${t.ok ? '✓' : '✗'} test "${t.name}"${t.ok ? '' : `: ${t.message}`}`),
      ...report.errors.map((e) => `! threw in ${e.hook}${e.line ? ` (line ${e.line})` : ''}: ${e.error}`),
    ];
    this.note(`Validation ${report.ok ? 'passed' : 'FAILED'} in ${((Date.now() - t0) / 1000).toFixed(1)}s`, report.ok ? 'ok' : 'error', lines.join('\n'));
    if (report.ok) {
      j.phase = 'install';
      await this.persist();
      return;
    }
    if (j.attempt >= MAX_ATTEMPTS) return this.abandon(j, report.checks.find((c) => !c.ok)?.message ?? 'it failed its trials');
    j.attempt++;
    j.messages.push({ role: 'user', content: repairUser(report, j.attempt - 1) });
    j.phase = 'implement';
    await this.persist();
  }

  private async install(j: Job) {
    const d = j.decree!;
    const record: CreationRecord = { id: j.id, title: d.title, god: j.req.god, domain: d.domain, scale: j.req.scale, day: j.req.day, announcement: d.announcement };
    const r = await this.host.install(j.id, j.source!, record, j.req.night);
    if (!r.ok) return this.abandon(j, `install failed: ${r.error}`);
    this.done.add(j.req.night);
    this.note(`"${d.title}" is now part of the world`, 'ok');
    this.state.job = null;
    await this.persist();
    this.host.onCreated(record);
  }

  private async abandon(j: Job, why: string) {
    this.note(`Abandoned "${j.decree?.title ?? 'tonight\'s creation'}"`, 'error', why);
    this.host.log(`${GOD_NAME[j.req.god]}'s creation crumbled to dust (${why.slice(0, 120)}).`, 2);
    this.done.add(j.req.night);
    this.host.failed(j.req.night);
    this.state.job = null;
    await this.persist();
  }
}
