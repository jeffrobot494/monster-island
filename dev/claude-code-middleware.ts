// Dev-only Vite middleware: POST /dev-ai/claude-code → spawns `claude -p` with structured output (§8).
// Verified flags/envelope: see docs/probe-results.md.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { checkAgainstSchema } from '../src/god/schemas';

const TIMEOUT_MS = 15 * 60 * 1000;

interface Req {
  role: 'propose' | 'implement' | 'repair';
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  schema: Record<string, unknown>;
}

/** Child env: never inherit ANTHROPIC_API_KEY (it would override the subscription) or the parent session's vars. */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
  return env;
}

function transcript(messages: Req['messages']): string {
  if (messages.length === 1) return messages[0].content;
  return messages
    .map((m, i) => (m.role === 'user' ? `${i ? '\n\n' : ''}=== PETITION ${Math.ceil((i + 1) / 2)} ===\n${m.content}` : `\n\n=== YOUR PREVIOUS ANSWER ===\n${m.content}`))
    .join('') + '\n\nAnswer the latest petition.';
}

let queue: Promise<unknown> = Promise.resolve();
interface Job { lines: unknown[]; listeners: Set<(o: any) => void>; final: any; at: number }
const jobs = new Map<string, Job>();
setInterval(() => {
  for (const [k, j] of jobs) if (Date.now() - j.at > 24 * 3600_000) jobs.delete(k);
}, 3600_000).unref?.();

/** Per-boot token for LAN clients (R32); localhost needs none. */
export const LAN_TOKEN = Math.random().toString(36).slice(2, 10);
function allowed(req: IncomingMessage): boolean {
  const ip = req.socket.remoteAddress ?? '';
  if (ip === '127.0.0.1' || ip === '::1' || ip.startsWith('::ffff:127.')) return true;
  const hdr = req.headers['x-dev-ai-token'];
  return hdr === LAN_TOKEN;
}
let inFlight = 0;

/** Live progress forwarded to the browser while claude -p runs. */
type Progress = { kind: 'status'; text: string } | { kind: 'delta'; channel: 'thinking' | 'output'; text: string } | { kind: 'thinking'; tokens: number };

function runClaude(req: Req, model: string, onProgress: (p: Progress) => void, signal: AbortSignal): Promise<{ data: unknown; usage: { input: number; output: number } }> {
  const dir = mkdtempSync(join(tmpdir(), 'mi-god-'));
  const sysFile = join(dir, 'system.txt');
  writeFileSync(sysFile, req.system);
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--json-schema', JSON.stringify(req.schema),
    '--system-prompt-file', sysFile, '--model', model, '--tools', '', '--safe-mode', '--no-session-persistence'];
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('the page went away before the call started'));
    const p = spawn('claude', args, { env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    // the page went away (reload, closed tab): stop spending usage on an answer nobody will read
    const abort = () => p.kill('SIGTERM');
    signal.addEventListener('abort', abort, { once: true });
    let buf = '', err = '', env: any = null;
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error('claude -p timed out after 15 minutes'));
    }, TIMEOUT_MS);
    const onLine = (line: string) => {
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      if (e.type === 'result') env = e;
      // thinking text is not exposed by claude -p, only a running estimate of its length
      else if (e.type === 'system' && e.subtype === 'thinking_tokens') onProgress({ kind: 'thinking', tokens: Number(e.estimated_tokens) || 0 });
      else if (e.type === 'system' && e.subtype === 'init') onProgress({ kind: 'status', text: `connected (${e.model ?? model})` });
      else if (e.type === 'stream_event') {
        const ev = e.event;
        if (ev?.type === 'message_start') onProgress({ kind: 'status', text: 'Claude is responding' });
        else if (ev?.type === 'content_block_start' && ev.content_block?.type === 'thinking') onProgress({ kind: 'status', text: 'thinking' });
        else if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') onProgress({ kind: 'status', text: 'writing the answer' });
        else if (ev?.type === 'content_block_delta') {
          const d = ev.delta;
          if (d?.type === 'thinking_delta' && d.thinking) onProgress({ kind: 'delta', channel: 'thinking', text: d.thinking });
          else if (d?.type === 'input_json_delta' && d.partial_json) onProgress({ kind: 'delta', channel: 'output', text: d.partial_json });
          else if (d?.type === 'text_delta' && d.text) onProgress({ kind: 'delta', channel: 'output', text: d.text });
        }
      }
    };
    p.stdout.on('data', (d) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (signal.aborted) return reject(new Error('cancelled: the page went away'));
      rmSync(dir, { recursive: true, force: true });
      if (buf.trim()) onLine(buf);
      if (!env) return reject(new Error(`claude -p exited ${code} without a result: ${err.slice(0, 400)}`));
      if (env.is_error) {
        const msg = String(env.result ?? env.subtype ?? 'error');
        const e: any = new Error(msg);
        if (/limit|rate|quota|429|overloaded/i.test(msg) || env.api_error_status === 429) e.rateLimit = true;
        return reject(e);
      }
      let data = env.structured_output;
      if (data === undefined && typeof env.result === 'string') {
        const m = env.result.match(/```(?:json)?\s*([\s\S]*?)```/);
        try {
          data = JSON.parse(m ? m[1] : env.result);
        } catch {
          return reject(new Error('claude -p returned no structured output'));
        }
      }
      const bad = checkAgainstSchema(data, req.schema);
      if (bad) return reject(new Error(`output did not match the schema: ${bad}`));
      const u = env.usage ?? {};
      resolve({ data, usage: { input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0 } });
    });
    p.stdin.end(transcript(req.messages));
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (d) => (s += d));
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

export function claudeCodePlugin(): Plugin {
  let version: string | null = null;
  return {
    name: 'humans-monsters-claude-code',
    apply: 'serve',
    configureServer(server) {
      const v = spawnSync('claude', ['--version'], { env: childEnv(), encoding: 'utf8' });
      version = v.status === 0 ? v.stdout.trim() : null;
      if (!version) server.config.logger.warn('[god] `claude` CLI not found; the game will fall back to ManualProvider.');
      else server.config.logger.info(`[god] ClaudeCodeProvider ready (${version}). LAN token: ?token=${LAN_TOKEN}`);
      const env = server.config.env;
      const models = {
        propose: process.env.CLAUDE_CODE_PROPOSE_MODEL ?? env.CLAUDE_CODE_PROPOSE_MODEL ?? 'sonnet',
        implement: process.env.CLAUDE_CODE_IMPLEMENT_MODEL ?? env.CLAUDE_CODE_IMPLEMENT_MODEL ?? 'opus',
      };
      // holds a request open (headless screenshots wait for the page's load event)
      server.middlewares.use('/dev-ai/delay', (req, res) => {
        const ms = Math.min(900000, Number(new URL(req.url ?? '', 'http://x').searchParams.get('ms')) || 0);
        setTimeout(() => {
          res.setHeader('content-type', 'image/svg+xml');
          res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
        }, ms);
      });
      server.middlewares.use('/dev-ai/status', (_req, res) => send(res, 200, { ok: !!version, version, models }));
      server.middlewares.use('/dev-ai/claude-code', async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
        if (!allowed(req)) return send(res, 403, { error: 'LAN clients need ?token= (printed in the dev server log)' });
        if (!version) return send(res, 503, { error: 'claude CLI not available' });
        let body: Req & { jobKey?: string };
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return send(res, 400, { error: 'bad JSON' });
        }
        const model = body.role === 'propose' ? models.propose : models.implement;
        // NDJSON stream: {type:'progress',...} lines while it runs, then one {type:'result'} or {type:'error'} line
        res.statusCode = 200;
        res.setHeader('content-type', 'application/x-ndjson');
        res.setHeader('cache-control', 'no-cache');
        const line = (o: unknown) => res.writableEnded || res.write(JSON.stringify(o) + '\n');
        // server-side jobs (R30): a job keeps running when the page goes away; a page that comes back with the same
        // jobKey re-attaches to it (or gets its cached result) instead of paying for a second call
        const key = body.jobKey ?? `anon-${Date.now()}-${Math.random()}`;
        let job = jobs.get(key);
        if (job) line({ type: 'progress', kind: 'status', text: job.final ? 'answer was ready (cached)' : 're-attached to the running call' });
        else {
          job = { lines: [], listeners: new Set(), final: null, at: Date.now() };
          jobs.set(key, job);
          const j = job;
          const emit = (o: any) => {
            if (o.type === 'progress' && o.kind !== 'delta') j.lines.push(o);
            for (const l of j.listeners) l(o);
          };
          const t0 = Date.now();
          if (inFlight > 0) emit({ type: 'progress', kind: 'status', text: 'queued behind another god call' });
          inFlight++;
          const run = queue.then(() => {
            emit({ type: 'progress', kind: 'status', text: `starting claude -p (${model})` });
            return runClaude(body, model, (p) => emit({ type: 'progress', ...p }), new AbortController().signal);
          });
          queue = run.catch(() => undefined);
          run.finally(() => inFlight--).catch(() => undefined);
          run.then((result) => {
            const secs = (Date.now() - t0) / 1000;
            server.config.logger.info(`[god] ${body.role} via ${model}: ${secs.toFixed(1)}s, ${result.usage.input} in / ${result.usage.output} out`);
            j.final = { type: 'result', ...result, model, seconds: secs };
            emit(j.final);
          }, (err: any) => {
            server.config.logger.warn(`[god] ${body.role} failed: ${err.message}`);
            j.final = { type: 'error', error: err.message, rateLimit: !!err.rateLimit };
            emit(j.final);
            setTimeout(() => jobs.delete(key), 1000); // errors are not cached
          });
        }
        for (const l of job.lines) line(l);
        if (job.final) {
          line(job.final);
          return res.end();
        }
        await new Promise<void>((resolve) => {
          const l = (o: any) => {
            line(o);
            if (o.type === 'result' || o.type === 'error') done();
          };
          const done = () => {
            job!.listeners.delete(l);
            resolve();
          };
          job!.listeners.add(l);
          res.on('close', done);
        });
        res.end();
      });
    },
  };
}
