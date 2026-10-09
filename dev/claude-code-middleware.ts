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

function runClaude(req: Req, model: string): Promise<{ data: unknown; usage: { input: number; output: number } }> {
  const dir = mkdtempSync(join(tmpdir(), 'mi-god-'));
  const sysFile = join(dir, 'system.txt');
  writeFileSync(sysFile, req.system);
  const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(req.schema), '--system-prompt-file', sysFile,
    '--model', model, '--tools', '', '--safe-mode', '--no-session-persistence'];
  return new Promise((resolve, reject) => {
    const p = spawn('claude', args, { env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error('claude -p timed out after 15 minutes'));
    }, TIMEOUT_MS);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      let env: any;
      try {
        env = JSON.parse(out);
      } catch {
        return reject(new Error(`claude -p exited ${code} without JSON: ${(err || out).slice(0, 400)}`));
      }
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
    name: 'monster-island-claude-code',
    apply: 'serve',
    configureServer(server) {
      const v = spawnSync('claude', ['--version'], { env: childEnv(), encoding: 'utf8' });
      version = v.status === 0 ? v.stdout.trim() : null;
      if (!version) server.config.logger.warn('[god] `claude` CLI not found; the game will fall back to ManualProvider.');
      else server.config.logger.info(`[god] ClaudeCodeProvider ready (${version})`);
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
        if (!version) return send(res, 503, { error: 'claude CLI not available' });
        let body: Req;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return send(res, 400, { error: 'bad JSON' });
        }
        const model = body.role === 'propose' ? models.propose : models.implement;
        const t0 = Date.now();
        const job = queue.then(() => runClaude(body, model));
        queue = job.catch(() => undefined);
        try {
          const result = await job;
          server.config.logger.info(`[god] ${body.role} via ${model}: ${((Date.now() - t0) / 1000).toFixed(1)}s, ${result.usage.input} in / ${result.usage.output} out`);
          send(res, 200, result);
        } catch (err: any) {
          server.config.logger.warn(`[god] ${body.role} failed: ${err.message}`);
          send(res, err.rateLimit ? 429 : 502, { error: err.message });
        }
      });
    },
  };
}
