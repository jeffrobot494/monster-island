// Source rules for generated modules (§4). Parses with acorn so comments/strings never match.
import { parse } from 'acorn';

export const ALLOWED_GLOBALS = new Set([
  'Math', 'JSON', 'Object', 'Array', 'Number', 'String', 'Boolean', 'Map', 'Set',
  'Infinity', 'NaN', 'undefined', 'isFinite', 'isNaN', 'parseInt', 'parseFloat',
  // harmless additions so common idioms don't burn a repair round
  'Error', 'TypeError', 'RangeError', 'console',
]);

const ROOTS_NO_COMPUTED = new Set(['Math', 'Object', 'globalThis', 'self', 'window', 'JSON']);
const BANNED_PROPS = new Set(['constructor', '__proto__']);
const BANNED_MATH = new Set(['random']);

export interface AstIssue {
  rule: string;
  message: string;
  line: number;
}

type Node = { type: string; start: number; end: number; loc?: { start: { line: number } }; [k: string]: any };

function walk(node: Node, parent: Node | null, fn: (n: Node, p: Node | null) => void) {
  fn(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c.type === 'string') walk(c, node, fn);
    } else if (v && typeof v.type === 'string') {
      walk(v, node, fn);
    }
  }
}

function collectPatternNames(p: Node | null, out: Set<string>) {
  if (!p) return;
  switch (p.type) {
    case 'Identifier': out.add(p.name); break;
    case 'ObjectPattern': for (const prop of p.properties) collectPatternNames(prop.type === 'RestElement' ? prop.argument : prop.value, out); break;
    case 'ArrayPattern': for (const el of p.elements) collectPatternNames(el, out); break;
    case 'RestElement': collectPatternNames(p.argument, out); break;
    case 'AssignmentPattern': collectPatternNames(p.left, out); break;
  }
}

export function checkSource(source: string): AstIssue[] {
  const issues: AstIssue[] = [];
  let ast: Node;
  try {
    ast = parse(source, { ecmaVersion: 2022, sourceType: 'module', locations: true }) as unknown as Node;
  } catch (e: any) {
    return [{ rule: 'syntax', message: `Syntax error: ${e.message}`, line: e.loc?.line ?? 0 }];
  }
  const line = (n: Node) => n.loc?.start.line ?? 0;
  const add = (rule: string, message: string, n: Node) => issues.push({ rule, message, line: line(n) });

  // declared names (lenient: whole-module set)
  const declared = new Set<string>();
  walk(ast, null, (n) => {
    if (n.type === 'VariableDeclarator') collectPatternNames(n.id, declared);
    if ((n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ClassDeclaration' || n.type === 'ClassExpression') && n.id) declared.add(n.id.name);
    if (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') for (const p of n.params) collectPatternNames(p, declared);
    if (n.type === 'CatchClause' && n.param) collectPatternNames(n.param, declared);
  });

  let defaults = 0;
  walk(ast, null, (n, p) => {
    switch (n.type) {
      case 'ImportDeclaration':
      case 'ImportExpression':
        add('no-import', 'Imports are not allowed; everything you need is on `api`.', n);
        break;
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
        add('single-default-export', 'Only a single `export default { ... }` is allowed.', n);
        break;
      case 'ExportDefaultDeclaration':
        defaults++;
        break;
      case 'WithStatement':
        add('no-with', '`with` is not allowed.', n);
        break;
      case 'AwaitExpression':
        add('no-async', '`await` is not allowed; all hooks are synchronous.', n);
        break;
      case 'TaggedTemplateExpression':
        add('no-tagged-template', 'Tagged templates are not allowed.', n);
        break;
      case 'MetaProperty':
        add('no-meta', '`import.meta` / `new.target` are not allowed.', n);
        break;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        if (n.async) add('no-async', 'async functions are not allowed; all hooks are synchronous.', n);
        if (n.generator) add('no-generator', 'Generators are not allowed.', n);
        break;
      case 'MemberExpression': {
        const prop = !n.computed ? n.property.name : n.property.type === 'Literal' ? String(n.property.value) : null;
        if (prop && BANNED_PROPS.has(prop)) add('no-constructor', `Access to \`.${prop}\` is not allowed.`, n);
        if (n.object.type === 'Identifier' && n.object.name === 'Math' && prop && BANNED_MATH.has(prop)) {
          add('no-random', '`Math.random` is not allowed: use `api.rand()`, `api.randInt(a,b)`, `api.pick(arr)` or `api.chance(p)` so the sim stays deterministic.', n);
        }
        if (n.computed && n.object.type === 'Identifier' && ROOTS_NO_COMPUTED.has(n.object.name)) {
          add('no-computed-global', `Computed member access on \`${n.object.name}\` is not allowed.`, n);
        }
        break;
      }
      case 'Identifier': {
        if (!p) break;
        if (p.type === 'MemberExpression' && p.property === n && !p.computed) break;
        if ((p.type === 'Property' || p.type === 'MethodDefinition' || p.type === 'PropertyDefinition') && p.key === n && !p.computed && !p.shorthand) break;
        if ((p.type === 'LabeledStatement' || p.type === 'BreakStatement' || p.type === 'ContinueStatement') && p.label === n) break;
        if (declared.has(n.name) || ALLOWED_GLOBALS.has(n.name)) break;
        const hint: Record<string, string> = {
          Date: 'use `api.time` instead',
          performance: 'timing is not available',
          setTimeout: 'use hooks (onTick) or `api.schedule(ticks, type)` instead',
          setInterval: 'use hooks (onTick) or `api.schedule(ticks, type)` instead',
          eval: 'eval is never allowed',
          Function: '`new Function` is never allowed',
          fetch: 'network access is not available',
          globalThis: 'globals are not available', self: 'globals are not available', window: 'globals are not available',
          Promise: 'all hooks are synchronous',
          crypto: 'use `api.rand()` instead',
        };
        add('no-free-identifier', `\`${n.name}\` is not defined and is not an allowed global${hint[n.name] ? ` (${hint[n.name]})` : ''}. Allowed: ${[...ALLOWED_GLOBALS].join(', ')}.`, n);
        break;
      }
    }
  });
  if (defaults !== 1) issues.push({ rule: 'single-default-export', message: 'The module must have exactly one `export default { ... }`.', line: 0 });
  // de-duplicate repeated identifier complaints
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = i.rule + i.message;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
