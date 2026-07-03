import { describe, expect, it } from 'vitest';
import { formatTimestamp, isTarget, parseTargets, renderTable } from './util.js';

describe('parseTargets', () => {
  it('parses a comma-separated list', () => {
    expect(parseTargets('ts,zod,msw,openapi')).toEqual(['ts', 'zod', 'msw', 'openapi']);
  });
  it('accepts the model target', () => {
    expect(parseTargets('model')).toEqual(['model']);
    expect(parseTargets('ts,model')).toEqual(['ts', 'model']);
  });
  it('trims whitespace and dedupes', () => {
    expect(parseTargets(' ts , zod , ts ')).toEqual(['ts', 'zod']);
  });
  it('throws on unknown target', () => {
    expect(() => parseTargets('ts,bogus')).toThrow(/Unknown target "bogus"/);
  });
  it('throws when empty', () => {
    expect(() => parseTargets(' , ')).toThrow(/No valid targets/);
  });
});

describe('isTarget', () => {
  it('accepts valid targets', () => {
    expect(isTarget('ts')).toBe(true);
    expect(isTarget('openapi')).toBe(true);
  });
  it('rejects invalid', () => {
    expect(isTarget('json')).toBe(false);
  });
});

describe('renderTable', () => {
  it('aligns columns with padEnd', () => {
    const out = renderTable([
      { header: 'METHOD', values: ['GET', 'POST'] },
      { header: 'PATTERN', values: ['/api/users', '/api/users/:id'] },
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toContain('METHOD');
    expect(lines[0]).toContain('PATTERN');
    // separator line of dashes
    expect(lines[1]).toMatch(/^-+ \| -+$/);
    expect(lines[2]).toContain('GET');
    expect(lines[3]).toContain('POST');
    // column alignment: header PATTERN starts at same offset in all rows
    const offset = lines[0]!.indexOf('PATTERN');
    expect(lines[2]!.slice(offset)).toContain('/api/users');
  });
  it('returns empty string for no columns', () => {
    expect(renderTable([])).toBe('');
  });
});

describe('formatTimestamp', () => {
  it('formats epoch ms as ISO', () => {
    expect(formatTimestamp(0)).toBe('-');
    expect(formatTimestamp(1_700_000_000_000)).toBe('2023-11-14T22:13:20.000Z');
  });
  it('returns dash for undefined', () => {
    expect(formatTimestamp(undefined)).toBe('-');
  });
});
