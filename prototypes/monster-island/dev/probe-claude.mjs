// Milestone 1 probe (§8): verifies how `claude -p` behaves for ClaudeCodeProvider.
// Usage: node dev/probe-claude.mjs [--implement]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const schema = {
  type: 'object',
  properties: { title: { type: 'string' }, count: { type: 'number' } },
  required: ['title', 'count'],
  additionalProperties: false,
};

function run(args, stdin) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err, ms: Date.now() - t0 }));
    p.stdin.end(stdin);
  });
}

const dir = mkdtempSync(join(tmpdir(), 'mi-probe-'));
const sysFile = join(dir, 'system.txt');
writeFileSync(sysFile, 'You are a terse test oracle. Answer only via the requested structure.');

const base = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(schema),
  '--tools', '', '--safe-mode', '--no-session-persistence', '--model', 'sonnet'];

console.log('--- probe A: --system-prompt-file + json-schema + tools off + safe-mode');
const a = await run([...base, '--system-prompt-file', sysFile], 'Give title "hello" and count 3.');
console.log('exit', a.code, 'ms', a.ms, 'stderr', a.err.slice(0, 300));
let envelope;
try { envelope = JSON.parse(a.out); } catch { console.log('stdout not JSON:', a.out.slice(0, 500)); }
if (envelope) {
  console.log('envelope keys:', Object.keys(envelope));
  console.log('structured_output:', JSON.stringify(envelope.structured_output));
  console.log('result:', String(envelope.result).slice(0, 300));
  console.log('is_error:', envelope.is_error, 'subtype:', envelope.subtype);
}

if (a.code !== 0) {
  console.log('--- probe B: --system-prompt instead of file');
  const b = await run([...base, '--system-prompt', 'You are a terse test oracle.'], 'Give title "hello" and count 3.');
  console.log('exit', b.code, 'ms', b.ms, b.out.slice(0, 800), b.err.slice(0, 300));
}

if (process.argv.includes('--implement')) {
  console.log('--- probe C: opus latency for a ~5K-token code output');
  const codeSchema = { type: 'object', properties: { source: { type: 'string' }, notes: { type: 'string' } }, required: ['source', 'notes'], additionalProperties: false };
  const c = await run(['-p', '--output-format', 'json', '--json-schema', JSON.stringify(codeSchema),
    '--tools', '', '--safe-mode', '--no-session-persistence', '--model', 'opus', '--system-prompt-file', sysFile],
    'Write a ~250-line JavaScript ES module implementing a small particle system class with comments. Put it in source.');
  const env = JSON.parse(c.out || '{}');
  console.log('exit', c.code, 'ms', c.ms, 'source chars', env.structured_output?.source?.length, 'usage', JSON.stringify(env.usage));
}
