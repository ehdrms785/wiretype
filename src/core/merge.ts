import type {
  ArrayShape,
  BuildModelOptions,
  FieldShape,
  ObjectShape,
  PrimitiveShape,
  RecordShape,
  Shape,
  StringFormat,
  UnionShape,
} from './types.js';

/* ------------------------------------------------------------------ */
/* Structural equality                                                 */
/* ------------------------------------------------------------------ */

/** Structural equality (order-insensitive for union variants and object keys). */
export function shapesEqual(a: Shape, b: Shape): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'null':
    case 'unknown':
      return true;
    case 'primitive': {
      const bp = b as PrimitiveShape;
      if (a.type !== bp.type) return false;
      if (!sameStringArray(a.formats, bp.formats)) return false;
      if (!sameEnum(a.enum, bp.enum)) return false;
      return true;
    }
    case 'array':
      return arrayElementEqual(a.element, (b as ArrayShape).element);
    case 'record':
      return shapesEqual(a.value, (b as RecordShape).value);
    case 'object': {
      const bo = b as ObjectShape;
      const ak = Object.keys(a.fields);
      const bk = Object.keys(bo.fields);
      if (ak.length !== bk.length) return false;
      for (const k of ak) {
        const af = a.fields[k];
        const bf = bo.fields[k];
        if (af === undefined || bf === undefined) return false;
        if (af.optional !== bf.optional) return false;
        if (!shapesEqual(af.shape, bf.shape)) return false;
      }
      return true;
    }
    case 'union': {
      const bu = b as UnionShape;
      if (a.variants.length !== bu.variants.length) return false;
      // order-insensitive: every a-variant matches a distinct b-variant
      const used = new Array<boolean>(bu.variants.length).fill(false);
      for (const av of a.variants) {
        let found = false;
        for (let i = 0; i < bu.variants.length; i++) {
          const bv = bu.variants[i];
          if (!used[i] && bv !== undefined && shapesEqual(av, bv)) {
            used[i] = true;
            found = true;
            break;
          }
        }
        if (!found) return false;
      }
      return true;
    }
  }
}

function arrayElementEqual(a: Shape | null, b: Shape | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return shapesEqual(a, b);
}

function sameStringArray(a?: string[], b?: string[]): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  const sa = [...aa].sort();
  const sb = [...bb].sort();
  return sa.every((v, i) => v === sb[i]);
}

function sameEnum(a?: (string | number)[], b?: (string | number)[]): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  const sa = [...aa].map(String).sort();
  const sb = [...bb].map(String).sort();
  return sa.every((v, i) => v === sb[i]);
}

/* ------------------------------------------------------------------ */
/* mergeShapes                                                         */
/* ------------------------------------------------------------------ */

/** Merge two shapes into one that accepts both. Commutative, associative-enough. */
export function mergeShapes(a: Shape, b: Shape, opts?: BuildModelOptions): Shape {
  // unknown is absorbing-neutral: unknown merges to the other side.
  if (a.kind === 'unknown') return b;
  if (b.kind === 'unknown') return a;

  // Either is a union -> flatten & merge variant-wise.
  if (a.kind === 'union' || b.kind === 'union') {
    const variants = [...variantsOf(a), ...variantsOf(b)];
    return unionFromVariants(variants, opts);
  }

  // Same-kind structural merges.
  if (a.kind === 'primitive' && b.kind === 'primitive') {
    return mergePrimitive(a, b);
  }
  if (a.kind === 'null' && b.kind === 'null') {
    return { kind: 'null' };
  }
  if (a.kind === 'array' && b.kind === 'array') {
    return mergeArray(a, b, opts);
  }
  if (
    (a.kind === 'object' || a.kind === 'record') &&
    (b.kind === 'object' || b.kind === 'record')
  ) {
    return mergeObjectLike(a, b, opts);
  }

  // Different kinds (e.g. string vs object, null vs object) -> union.
  return unionFromVariants([a, b], opts);
}

function mergePrimitive(a: PrimitiveShape, b: PrimitiveShape): Shape {
  // integer + number -> number
  const numeric = new Set(['integer', 'number']);
  if (numeric.has(a.type) && numeric.has(b.type)) {
    const type = a.type === b.type ? a.type : 'number';
    return { kind: 'primitive', type };
  }
  if (a.type !== b.type) {
    // e.g. string vs boolean -> union of the two primitives
    return { kind: 'union', variants: [stripPrimitive(a), stripPrimitive(b)] };
  }
  // Same type. For strings, intersect formats (a format survives only if
  // every sample matched it).
  if (a.type === 'string') {
    const formats = intersectFormats(a.formats, b.formats);
    const out: PrimitiveShape = { kind: 'primitive', type: 'string' };
    if (formats.length > 0) out.formats = formats;
    return out;
  }
  return { kind: 'primitive', type: a.type };
}

function stripPrimitive(p: PrimitiveShape): PrimitiveShape {
  // A bare primitive variant (drop formats/enum for union membership clarity
  // is NOT desired — keep as-is). Return a shallow clone.
  const out: PrimitiveShape = { kind: 'primitive', type: p.type };
  if (p.formats) out.formats = [...p.formats];
  if (p.enum) out.enum = [...p.enum];
  return out;
}

function intersectFormats(a?: StringFormat[], b?: StringFormat[]): StringFormat[] {
  if (!a || !b) return [];
  const setB = new Set(b);
  return a.filter((f) => setB.has(f));
}

function mergeArray(a: ArrayShape, b: ArrayShape, opts?: BuildModelOptions): ArrayShape {
  if (a.element === null && b.element === null) {
    return { kind: 'array', element: null };
  }
  if (a.element === null) return { kind: 'array', element: b.element };
  if (b.element === null) return { kind: 'array', element: a.element };
  return { kind: 'array', element: mergeShapes(a.element, b.element, opts) };
}

function mergeObjectLike(
  a: ObjectShape | RecordShape,
  b: ObjectShape | RecordShape,
  opts?: BuildModelOptions,
): Shape {
  // Normalize both to objects for merge; records collapse to a single value
  // shape but we merge conservatively by treating record.value as applying to
  // all keys of the other side.
  if (a.kind === 'record' && b.kind === 'record') {
    return { kind: 'record', value: mergeShapes(a.value, b.value, opts) };
  }
  const ao = toObject(a);
  const bo = toObject(b);
  const fields: Record<string, FieldShape> = {};
  const orderedKeys: string[] = [];
  const seen = new Set<string>();
  for (const k of Object.keys(ao.fields)) {
    if (!seen.has(k)) {
      seen.add(k);
      orderedKeys.push(k);
    }
  }
  for (const k of Object.keys(bo.fields)) {
    if (!seen.has(k)) {
      seen.add(k);
      orderedKeys.push(k);
    }
  }
  for (const k of orderedKeys) {
    const af = ao.fields[k];
    const bf = bo.fields[k];
    if (af !== undefined && bf !== undefined) {
      fields[k] = {
        shape: mergeShapes(af.shape, bf.shape, opts),
        optional: af.optional || bf.optional,
      };
      const seen = sumCounts(af.seen, bf.seen);
      if (seen !== undefined) fields[k]!.seen = seen;
    } else if (af !== undefined) {
      fields[k] = { shape: af.shape, optional: true };
      if (af.seen !== undefined) fields[k]!.seen = af.seen;
    } else if (bf !== undefined) {
      fields[k] = { shape: bf.shape, optional: true };
      if (bf.seen !== undefined) fields[k]!.seen = bf.seen;
    }
  }
  const out: ObjectShape = { kind: 'object', fields };
  const samples = sumCounts(ao.samples, bo.samples);
  if (samples !== undefined) out.samples = samples;
  return out;
}

/**
 * Sum two sample counts, treating "absent" as 1 when the OTHER side has a
 * count (hand-built shapes merged into counted ones stay roughly honest) and
 * keeping the result absent when neither side was counted.
 */
function sumCounts(a?: number, b?: number): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 1) + (b ?? 1);
}

function toObject(s: ObjectShape | RecordShape): ObjectShape {
  if (s.kind === 'object') return s;
  // A record has no explicit keys; represent as empty object for merge purposes.
  return { kind: 'object', fields: {} };
}

/* ------------------------------------------------------------------ */
/* Union handling                                                      */
/* ------------------------------------------------------------------ */

function variantsOf(s: Shape): Shape[] {
  if (s.kind === 'union') return s.variants;
  return [s];
}

/**
 * Build a shape from a flat list of variants: flatten nested unions, merge
 * compatible variants (same kind that can structurally merge), dedupe via
 * shapesEqual, keep null as its own variant. Returns a single shape when only
 * one variant remains.
 */
function unionFromVariants(input: Shape[], opts?: BuildModelOptions): Shape {
  // Flatten
  const flat: Shape[] = [];
  for (const v of input) {
    if (v.kind === 'union') flat.push(...v.variants);
    else flat.push(v);
  }

  const merged: Shape[] = [];
  for (const v of flat) {
    if (v.kind === 'unknown') continue;
    let placed = false;
    for (let i = 0; i < merged.length; i++) {
      const m = merged[i];
      if (m === undefined) continue;
      if (canMergeVariants(m, v)) {
        merged[i] = mergeShapes(m, v, opts);
        placed = true;
        break;
      }
    }
    if (!placed) merged.push(v);
  }

  // Dedupe via shapesEqual (post-merge, structurally-identical variants).
  const deduped: Shape[] = [];
  for (const m of merged) {
    if (!deduped.some((d) => shapesEqual(d, m))) {
      deduped.push(m);
    }
  }

  if (deduped.length === 0) return { kind: 'unknown' };
  if (deduped.length === 1) {
    const only = deduped[0];
    return only as Shape;
  }
  return { kind: 'union', variants: deduped };
}

/**
 * Two variants should merge (rather than sit side-by-side) when they are the
 * same structural family: two objects/records merge into one, two arrays
 * merge, numeric primitives merge. Null stays separate; unlike primitives
 * (string vs boolean) stay separate.
 */
function canMergeVariants(a: Shape, b: Shape): boolean {
  if (a.kind === 'null' || b.kind === 'null') return false;
  if (a.kind === 'object' || a.kind === 'record') {
    return b.kind === 'object' || b.kind === 'record';
  }
  if (a.kind === 'array') return b.kind === 'array';
  if (a.kind === 'primitive' && b.kind === 'primitive') {
    if (a.type === b.type) return true;
    const numeric = new Set(['integer', 'number']);
    return numeric.has(a.type) && numeric.has(b.type);
  }
  return false;
}
