#!/usr/bin/env node
// The arena's sandbox pipeline (src/arena/README.md): fork game files into src/arena/sandbox/, see what changed,
// pull the game's later changes in, and promote finished work back into the game.
//
//   npm run arena:fork    -- src/sim/combat.ts [...]   copy game files into the sandbox (the arena uses the copies)
//   npm run arena:status                               every sandbox file: edited? has the game moved on?
//   npm run arena:diff    -- [file]                    what promoting would change in the game
//   npm run arena:sync    -- [file]                    merge the game's changes since the fork into the sandbox copy
//   npm run arena:promote -- <file...> | --all         port into the game, typecheck + test, clear the sandbox copy
//   npm run arena:drop    -- <file...> --yes           throw a sandbox copy away
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const SANDBOX = path.join(SRC, 'arena', 'sandbox');
const BASE = path.join(SANDBOX, '.base');
const rel = (p) => path.relative(ROOT, p);
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
const c = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = (s) => c(31, s), green = (s) => c(32, s), yellow = (s) => c(33, s), bold = (s) => c(1, s), dim = (s) => c(2, s);

function die(msg) {
  console.error(red(msg));
  process.exit(1);
}

/** 'src/sim/combat.ts', 'sim/combat.ts' or a sandbox path → the path under src/ ('sim/combat.ts'). */
function key(arg) {
  let p = path.resolve(ROOT, arg);
  if (p.startsWith(BASE + path.sep)) p = path.join(SRC, path.relative(BASE, p));
  else if (p.startsWith(SANDBOX + path.sep)) p = path.join(SRC, path.relative(SANDBOX, p));
  else if (!p.startsWith(SRC + path.sep)) p = path.join(SRC, arg);
  const k = path.relative(SRC, p);
  if (k.startsWith('..') || k.startsWith(`arena${path.sep}`)) die(`${arg}: not a game file under src/ (src/arena/ itself can't be forked)`);
  return k;
}

const paths = (k) => ({ game: path.join(SRC, k), sand: path.join(SANDBOX, k), base: path.join(BASE, k) });

function forked() {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (p !== BASE) walk(p);
      } else if (!d.name.endsWith('.md')) out.push(path.relative(SANDBOX, p));
    }
  };
  walk(SANDBOX);
  return out.sort();
}

function state(k) {
  const { game, sand, base } = paths(k);
  const g = read(game), s = read(sand), b = read(base);
  return {
    k, g, s, b,
    edited: s !== b,
    gameMoved: g !== b,
    gameGone: g === null,
    conflicts: s !== null && /^<{7} /m.test(s),
  };
}

function write(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

function rmClean(p) {
  if (fs.existsSync(p)) fs.rmSync(p);
  // drop emptied directories up to the sandbox root
  for (let d = path.dirname(p); d !== SANDBOX && d.startsWith(SANDBOX) && fs.existsSync(d) && !fs.readdirSync(d).length; d = path.dirname(d)) fs.rmdirSync(d);
}

/** git merge-file: 3-way merge (ours, base, theirs) → { text, conflicts } */
function merge3(ours, base, theirs, labels) {
  const tmp = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.arena-merge-'));
  const [o, b, t] = ['ours', 'base', 'theirs'].map((n) => path.join(tmp, n));
  fs.writeFileSync(o, ours);
  fs.writeFileSync(b, base);
  fs.writeFileSync(t, theirs);
  const r = spawnSync('git', ['merge-file', '-L', labels[0], '-L', 'fork point', '-L', labels[1], o, b, t], { encoding: 'utf8' });
  const text = fs.readFileSync(o, 'utf8');
  fs.rmSync(tmp, { recursive: true });
  if (r.status < 0 || r.error) die(`git merge-file failed: ${r.error?.message ?? r.stderr}`);
  return { text, conflicts: r.status };
}

function diff(a, b, la, lb) {
  const r = spawnSync('git', ['diff', '--no-index', '--color=' + (process.stdout.isTTY ? 'always' : 'never'), `--src-prefix=${la}/`, `--dst-prefix=${lb}/`, a, b], { cwd: ROOT, encoding: 'utf8' });
  return r.stdout;
}

function run(cmd, args) {
  console.log(dim(`$ ${cmd} ${args.join(' ')}`));
  return spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' }).status === 0;
}

// ---------- commands ----------

function fork(args) {
  if (!args.length) die('usage: npm run arena:fork -- src/sim/combat.ts [...]');
  for (const a of args) {
    const k = key(a), { game, sand, base } = paths(k);
    if (!fs.existsSync(game)) die(`${rel(game)} doesn't exist`);
    if (fs.existsSync(sand)) {
      console.log(yellow(`${k}: already in the sandbox, left as it is`));
      continue;
    }
    const text = read(game);
    write(sand, text);
    write(base, text);
    console.log(`${green('forked')} ${k} → ${rel(sand)}`);
  }
  console.log(dim('The arena now runs the sandbox copies (restart `npm run arena` if it was running). The game never sees them.'));
}

function status() {
  const ks = forked();
  if (!ks.length) return console.log('The sandbox is empty: the arena runs exactly the game\'s code.');
  console.log(bold(`Sandbox: ${ks.length} file${ks.length > 1 ? 's' : ''} (the arena runs these instead of the game's)\n`));
  for (const k of ks) {
    const s = state(k);
    const flags = [];
    if (s.b === null) flags.push(red('no fork point (.base) — promote compares against the game as it is now'));
    if (s.conflicts) flags.push(red('merge conflicts to resolve'));
    if (s.gameGone) flags.push(red('gone from the game'));
    else if (s.gameMoved) flags.push(yellow('the game changed since the fork: `arena:sync` (promote merges it too)'));
    const what = s.edited ? green('edited') : dim('unchanged');
    const lines = s.edited && s.b !== null ? countChanges(s.b, s.s) : '';
    console.log(`  ${k.padEnd(36)} ${what}${lines}${flags.length ? '\n    ' + flags.join('\n    ') : ''}`);
  }
  console.log(dim('\n`npm run arena:diff` shows what promoting would change; `npm run arena:promote -- <file>` ports it.'));
}

function countChanges(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  const setA = new Map(), setB = new Map();
  for (const l of A) setA.set(l, (setA.get(l) ?? 0) + 1);
  for (const l of B) setB.set(l, (setB.get(l) ?? 0) + 1);
  let add = 0, del = 0;
  for (const [l, n] of setB) add += Math.max(0, n - (setA.get(l) ?? 0));
  for (const [l, n] of setA) del += Math.max(0, n - (setB.get(l) ?? 0));
  return dim(` (+${add} −${del})`);
}

function showDiff(args) {
  const ks = args.length ? args.map(key) : forked();
  if (!ks.length) return console.log('The sandbox is empty.');
  for (const k of ks) {
    const { game, sand } = paths(k);
    if (!fs.existsSync(sand)) {
      console.log(yellow(`${k}: not in the sandbox`));
      continue;
    }
    // what the game file would become: the sandbox copy, with the game's own later changes merged in
    const s = state(k);
    let after = s.s;
    if (s.gameMoved && s.b !== null && s.g !== null) {
      const m = merge3(s.s, s.b, s.g, ['arena', 'game']);
      after = m.text;
      if (m.conflicts) console.log(red(`${k}: the game's changes conflict with the arena's: \`npm run arena:sync -- ${k}\` first`));
    }
    const tmp = path.join(ROOT, 'node_modules', '.arena-diff.tmp');
    fs.writeFileSync(tmp, after);
    const out = diff(fs.existsSync(game) ? rel(game) : '/dev/null', rel(tmp), 'game', 'arena');
    fs.rmSync(tmp);
    console.log(out ? out.replaceAll(rel(tmp), rel(game)) : dim(`${k}: no difference from the game`));
  }
}

function sync(args) {
  const ks = args.length ? args.map(key) : forked();
  for (const k of ks) {
    const s = state(k), { sand, base } = paths(k);
    if (s.s === null) die(`${k}: not in the sandbox`);
    if (s.gameGone) die(`${k}: gone from the game; drop it or move it by hand`);
    if (!s.gameMoved) {
      console.log(dim(`${k}: the game hasn't changed since the fork`));
      continue;
    }
    if (s.b === null) die(`${k}: no fork point to merge from (.base missing)`);
    const m = merge3(s.s, s.b, s.g, ['arena', 'game']);
    write(sand, m.text);
    write(base, s.g);
    console.log(m.conflicts ? red(`${k}: merged with ${m.conflicts} conflict${m.conflicts > 1 ? 's' : ''}: resolve the <<<<<<< markers in ${rel(sand)}`) : `${green('synced')} ${k}: the game's changes are in the sandbox copy`);
  }
}

function promote(args) {
  const noTest = args.includes('--no-test');
  args = args.filter((a) => !a.startsWith('--') || a === '--all');
  const ks = args.includes('--all') ? forked() : args.map(key);
  if (!ks.length) die('usage: npm run arena:promote -- <file...> | --all   [--no-test]');
  const plan = [];
  for (const k of ks) {
    const s = state(k);
    if (s.s === null) die(`${k}: not in the sandbox`);
    if (s.conflicts) die(`${k}: resolve its merge conflicts first`);
    let text = s.s;
    if (s.gameMoved && s.b !== null && s.g !== null) {
      const m = merge3(s.s, s.b, s.g, ['arena', 'game']);
      if (m.conflicts) die(`${k}: the game changed in the same places since the fork. Run \`npm run arena:sync -- ${k}\`, resolve, then promote.`);
      text = m.text;
    }
    plan.push({ k, text, before: s.g });
  }
  const changed = plan.filter((p) => p.text !== p.before);
  for (const p of plan) if (p.text === p.before) console.log(dim(`${p.k}: no difference from the game`));
  for (const p of changed) write(paths(p.k).game, p.text);
  if (changed.length) console.log(`${green('ported')} ${changed.map((p) => p.k).join(', ')} into the game`);
  if (changed.length && !noTest) {
    // a long per-test timeout: the gate is for correctness, and a busy machine pushes the heavier tests past 5 s
    const ok = run('npx', ['tsc', '--noEmit']) && run('npx', ['vitest', 'run', '--testTimeout=30000']);
    if (!ok) {
      for (const p of changed) {
        if (p.before === null) rmClean(paths(p.k).game);
        else write(paths(p.k).game, p.before);
      }
      die('\nThe game failed its typecheck or tests with these changes: the game files are back as they were, and the sandbox copies are untouched. Fix them in the arena (`npm run arena:test` runs the suite against the sandbox) and promote again.');
    }
  }
  for (const p of plan) {
    rmClean(paths(p.k).sand);
    rmClean(paths(p.k).base);
  }
  if (changed.length) {
    console.log(green(`\nDone. ${changed.length} file${changed.length > 1 ? 's are' : ' is'} now in the game; the sandbox copies are gone.`));
    console.log(`Review and commit:  git diff -- ${changed.map((p) => `src/${p.k}`).join(' ')}`);
  }
}

function drop(args) {
  if (!args.includes('--yes')) die('arena:drop throws away sandbox work. Add --yes:  npm run arena:drop -- <file...> --yes');
  const ks = args.filter((a) => a !== '--yes').map(key);
  for (const k of ks) {
    const { sand, base } = paths(k);
    if (!fs.existsSync(sand)) {
      console.log(yellow(`${k}: not in the sandbox`));
      continue;
    }
    rmClean(sand);
    rmClean(base);
    console.log(`${yellow('dropped')} ${k}: the arena uses the game's version again`);
  }
}

const [cmd, ...args] = process.argv.slice(2);
const cmds = { fork, status, diff: showDiff, sync, promote, drop };
if (!cmds[cmd]) die(`usage: node scripts/arena.mjs <${Object.keys(cmds).join('|')}> [files]`);
cmds[cmd](args);
