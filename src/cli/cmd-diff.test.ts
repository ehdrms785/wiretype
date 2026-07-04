import { describe, expect, it } from 'vitest';
import { resolveDiffSides } from './cmd-diff.js';

describe('resolveDiffSides', () => {
  it('resolves positionals in order', () => {
    expect(resolveDiffSides({ a: 'x', b: 'y' })).toEqual({ a: 'x', b: 'y' });
  });

  it('resolves --claims/--observed regardless of flag order', () => {
    expect(resolveDiffSides({ claims: 'code', observed: 'wire' })).toEqual({
      a: 'code',
      b: 'wire',
    });
  });

  it('rejects mixing positionals and flags', () => {
    expect(() => resolveDiffSides({ a: 'x', observed: 'wire' })).toThrow(/not both/);
    expect(() => resolveDiffSides({ a: 'x', b: 'y', claims: 'code' })).toThrow(/not both/);
  });

  it('rejects a lone flag', () => {
    expect(() => resolveDiffSides({ claims: 'code' })).toThrow(/Both --claims/);
    expect(() => resolveDiffSides({ observed: 'wire' })).toThrow(/Both --claims/);
  });

  it('rejects a lone positional and empty input', () => {
    expect(() => resolveDiffSides({ a: 'x' })).toThrow(/two sides/);
    expect(() => resolveDiffSides({})).toThrow(/two sides/);
  });
});
