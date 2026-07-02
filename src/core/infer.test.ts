import { describe, it, expect } from 'vitest';
import { inferShape, detectStringFormats } from './infer.js';
import type { ArrayShape, ObjectShape, PrimitiveShape } from './types.js';

describe('detectStringFormats', () => {
  it('detects uuid', () => {
    expect(detectStringFormats('2b8f0a3e-9c1d-4a2b-8e7f-1a2b3c4d5e6f')).toContain('uuid');
  });
  it('detects date-time and not date', () => {
    const f = detectStringFormats('2020-01-02T03:04:05Z');
    expect(f).toContain('date-time');
    expect(f).not.toContain('date');
  });
  it('detects plain date', () => {
    expect(detectStringFormats('2020-01-02')).toEqual(['date']);
  });
  it('detects email', () => {
    expect(detectStringFormats('a@b.com')).toContain('email');
  });
  it('detects uri', () => {
    expect(detectStringFormats('https://example.com/x')).toContain('uri');
  });
  it('returns empty for a plain string', () => {
    expect(detectStringFormats('hello world')).toEqual([]);
  });
});

describe('inferShape primitives', () => {
  it('integer for whole numbers', () => {
    expect(inferShape(42)).toEqual({ kind: 'primitive', type: 'integer' });
  });
  it('number for floats', () => {
    expect(inferShape(3.14)).toEqual({ kind: 'primitive', type: 'number' });
  });
  it('boolean', () => {
    expect(inferShape(true)).toEqual({ kind: 'primitive', type: 'boolean' });
  });
  it('null', () => {
    expect(inferShape(null)).toEqual({ kind: 'null' });
  });
  it('string with format', () => {
    const s = inferShape('a@b.com') as PrimitiveShape;
    expect(s.type).toBe('string');
    expect(s.formats).toContain('email');
  });
  it('plain string carries no formats key', () => {
    const s = inferShape('hi') as PrimitiveShape;
    expect(s.formats).toBeUndefined();
  });
});

describe('inferShape composites', () => {
  it('empty array -> element null', () => {
    expect(inferShape([])).toEqual<ArrayShape>({ kind: 'array', element: null });
  });
  it('array merges element shapes', () => {
    const s = inferShape([1, 2, 3]) as ArrayShape;
    expect(s.element).toEqual({ kind: 'primitive', type: 'integer' });
  });
  it('array of mixed int/float -> number element', () => {
    const s = inferShape([1, 2.5]) as ArrayShape;
    expect(s.element).toEqual({ kind: 'primitive', type: 'number' });
  });
  it('object preserves key order and marks non-optional', () => {
    const s = inferShape({ b: 1, a: 'x' }) as ObjectShape;
    expect(Object.keys(s.fields)).toEqual(['b', 'a']);
    expect(s.fields.b?.optional).toBe(false);
  });
});
