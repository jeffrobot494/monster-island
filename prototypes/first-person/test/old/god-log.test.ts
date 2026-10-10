import { describe, expect, it } from 'vitest';
import { readablePartialJson } from '../src/ui/ui';

describe('readablePartialJson (live god output)', () => {
  const full = JSON.stringify({ source: 'export default {\n  id: "a\\b",\n}', notes: 'tests "fire"' });

  it('decodes a complete answer: source as code, other fields labelled', () => {
    expect(readablePartialJson(full)).toBe('export default {\n  id: "a\\b",\n}\nnotes: tests "fire"\n');
  });

  it('never throws on any prefix and only grows', () => {
    let prev = '';
    for (let n = 0; n <= full.length; n++) {
      const r = readablePartialJson(full.slice(0, n));
      expect(r.startsWith(prev.replace(/\n$/, '')) || prev === '').toBe(true);
      prev = r;
    }
  });

  it('labels omen fields and array items', () => {
    const om = JSON.stringify({ omens: [{ title: 'Fire', tone: 'wild', builds_on: ['x-1'] }] });
    expect(readablePartialJson(om)).toBe('title: Fire\ntone: wild\nbuilds_on: x-1\n');
  });
});
