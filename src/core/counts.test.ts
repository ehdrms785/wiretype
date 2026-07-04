import { describe, expect, it } from 'vitest';
import { inferShape, mergeShapes, shapesEqual } from './index.js';
import type { ObjectShape } from './index.js';

describe('sample counts (seen / samples)', () => {
  it('inferShape marks a single object sample', () => {
    const s = inferShape({ a: 1, b: 'x' }) as ObjectShape;
    expect(s.samples).toBe(1);
    expect(s.fields.a?.seen).toBe(1);
    expect(s.fields.b?.seen).toBe(1);
  });

  it('mergeShapes accumulates samples and per-field seen', () => {
    const s1 = inferShape({ a: 1, b: 'x' });
    const s2 = inferShape({ a: 2 }); // b absent
    const s3 = inferShape({ a: 3, b: 'y' });
    const merged = mergeShapes(mergeShapes(s1, s2), s3) as ObjectShape;

    expect(merged.samples).toBe(3);
    expect(merged.fields.a?.seen).toBe(3);
    expect(merged.fields.b?.seen).toBe(2);
    expect(merged.fields.b?.optional).toBe(true);
  });

  it('array elements count individually', () => {
    const s = inferShape([{ a: 1 }, { a: 2 }, { a: 3, extra: true }]);
    expect(s.kind).toBe('array');
    const el = (s as Extract<typeof s, { kind: 'array' }>).element as ObjectShape;
    expect(el.samples).toBe(3);
    expect(el.fields.a?.seen).toBe(3);
    expect(el.fields.extra?.seen).toBe(1);
    expect(el.fields.extra?.optional).toBe(true);
  });

  it('shapesEqual ignores counts', () => {
    const counted = inferShape({ a: 1 });
    const uncounted: ObjectShape = {
      kind: 'object',
      fields: { a: { shape: { kind: 'primitive', type: 'integer' }, optional: false } },
    };
    expect(shapesEqual(counted, uncounted)).toBe(true);
  });

  it('hand-built shapes without counts stay uncounted through merges', () => {
    const bare: ObjectShape = {
      kind: 'object',
      fields: { a: { shape: { kind: 'primitive', type: 'integer' }, optional: false } },
    };
    const merged = mergeShapes(bare, bare) as ObjectShape;
    expect(merged.samples).toBeUndefined();
    expect(merged.fields.a?.seen).toBeUndefined();
  });
});
