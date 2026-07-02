import { describe, it, expect } from 'vitest';
import { mergeShapes, shapesEqual } from './merge.js';
import { inferShape } from './infer.js';
import type { ArrayShape, ObjectShape, PrimitiveShape, Shape, UnionShape } from './types.js';

const prim = (type: PrimitiveShape['type']): PrimitiveShape => ({ kind: 'primitive', type });

describe('shapesEqual', () => {
  it('equal primitives', () => {
    expect(shapesEqual(prim('string'), prim('string'))).toBe(true);
  });
  it('unequal primitive types', () => {
    expect(shapesEqual(prim('integer'), prim('number'))).toBe(false);
  });
  it('object key order insensitive', () => {
    const a: ObjectShape = { kind: 'object', fields: { x: { shape: prim('integer'), optional: false }, y: { shape: prim('string'), optional: false } } };
    const b: ObjectShape = { kind: 'object', fields: { y: { shape: prim('string'), optional: false }, x: { shape: prim('integer'), optional: false } } };
    expect(shapesEqual(a, b)).toBe(true);
  });
  it('object optional mismatch', () => {
    const a: ObjectShape = { kind: 'object', fields: { x: { shape: prim('integer'), optional: false } } };
    const b: ObjectShape = { kind: 'object', fields: { x: { shape: prim('integer'), optional: true } } };
    expect(shapesEqual(a, b)).toBe(false);
  });
  it('union order insensitive', () => {
    const a: UnionShape = { kind: 'union', variants: [prim('string'), { kind: 'null' }] };
    const b: UnionShape = { kind: 'union', variants: [{ kind: 'null' }, prim('string')] };
    expect(shapesEqual(a, b)).toBe(true);
  });
});

describe('mergeShapes primitives', () => {
  it('integer + number -> number', () => {
    expect(mergeShapes(prim('integer'), prim('number'))).toEqual(prim('number'));
  });
  it('integer + integer -> integer', () => {
    expect(mergeShapes(prim('integer'), prim('integer'))).toEqual(prim('integer'));
  });
  it('string vs boolean -> union', () => {
    const m = mergeShapes(prim('string'), prim('boolean')) as UnionShape;
    expect(m.kind).toBe('union');
    expect(m.variants).toHaveLength(2);
  });
  it('unknown merges to other side', () => {
    expect(mergeShapes({ kind: 'unknown' }, prim('string'))).toEqual(prim('string'));
  });
});

describe('mergeShapes string formats', () => {
  it('format survives only if every sample matched', () => {
    const withFmt = inferShape('a@b.com');
    const plain = inferShape('not-an-email-string');
    const m = mergeShapes(withFmt, plain) as PrimitiveShape;
    expect(m.type).toBe('string');
    expect(m.formats).toBeUndefined();
  });
  it('format retained when both match same format', () => {
    const a = inferShape('a@b.com');
    const b = inferShape('c@d.org');
    const m = mergeShapes(a, b) as PrimitiveShape;
    expect(m.formats).toEqual(['email']);
  });
  it('intersects differing formats to empty', () => {
    const email = inferShape('a@b.com');
    const uuid = inferShape('2b8f0a3e-9c1d-4a2b-8e7f-1a2b3c4d5e6f');
    const m = mergeShapes(email, uuid) as PrimitiveShape;
    expect(m.formats).toBeUndefined();
  });
});

describe('mergeShapes objects', () => {
  it('union of keys, missing side -> optional', () => {
    const a = inferShape({ id: 1, name: 'x' });
    const b = inferShape({ id: 2 });
    const m = mergeShapes(a, b) as ObjectShape;
    expect(m.fields.id?.optional).toBe(false);
    expect(m.fields.name?.optional).toBe(true);
  });
  it('preserves first-seen key order', () => {
    const a = inferShape({ a: 1, b: 2 });
    const b = inferShape({ c: 3, a: 1 });
    const m = mergeShapes(a, b) as ObjectShape;
    expect(Object.keys(m.fields)).toEqual(['a', 'b', 'c']);
  });
  it('recursive field merge', () => {
    const a = inferShape({ n: { x: 1 } });
    const b = inferShape({ n: { x: 2, y: 3 } });
    const m = mergeShapes(a, b) as ObjectShape;
    const nested = m.fields.n?.shape as ObjectShape;
    expect(nested.fields.y?.optional).toBe(true);
  });
});

describe('mergeShapes arrays', () => {
  it('empty + non-empty adopts element', () => {
    const empty: ArrayShape = { kind: 'array', element: null };
    const full: ArrayShape = { kind: 'array', element: prim('integer') };
    expect(mergeShapes(empty, full)).toEqual(full);
  });
  it('merges element shapes', () => {
    const a: ArrayShape = { kind: 'array', element: prim('integer') };
    const b: ArrayShape = { kind: 'array', element: prim('number') };
    const m = mergeShapes(a, b) as ArrayShape;
    expect(m.element).toEqual(prim('number'));
  });
});

describe('mergeShapes unions', () => {
  it('object vs string -> union', () => {
    const m = mergeShapes(inferShape({ a: 1 }), inferShape('x')) as UnionShape;
    expect(m.kind).toBe('union');
    expect(m.variants).toHaveLength(2);
  });
  it('null stays a separate variant', () => {
    const m = mergeShapes(inferShape('x'), inferShape(null)) as UnionShape;
    expect(m.kind).toBe('union');
    expect(m.variants.some((v) => v.kind === 'null')).toBe(true);
  });
  it('two objects inside a union merge into one object variant', () => {
    const u1: Shape = { kind: 'union', variants: [inferShape({ a: 1 }), { kind: 'null' }] };
    const obj2 = inferShape({ a: 2, b: 3 });
    const m = mergeShapes(u1, obj2) as UnionShape;
    expect(m.kind).toBe('union');
    const objectVariants = m.variants.filter((v) => v.kind === 'object');
    expect(objectVariants).toHaveLength(1);
    const merged = objectVariants[0] as ObjectShape;
    expect(merged.fields.b?.optional).toBe(true);
    expect(m.variants.some((v) => v.kind === 'null')).toBe(true);
  });
  it('flattens nested unions and dedupes', () => {
    const u: Shape = { kind: 'union', variants: [prim('string'), { kind: 'null' }] };
    const m = mergeShapes(u, prim('string'));
    // string + (string|null) -> string|null (deduped)
    const mu = m as UnionShape;
    expect(mu.kind).toBe('union');
    expect(mu.variants).toHaveLength(2);
  });
  it('commutative for objects', () => {
    const a = inferShape({ id: 1, name: 'x' });
    const b = inferShape({ id: 2 });
    expect(shapesEqual(mergeShapes(a, b), mergeShapes(b, a))).toBe(true);
  });
});
