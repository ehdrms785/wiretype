import type {
  BuildModelOptions,
  JsonValue,
  ObjectShape,
  PrimitiveShape,
  Shape,
  StringFormat,
} from './types.js';
import { mergeShapes } from './merge.js';

/* ------------------------------------------------------------------ */
/* String format detection                                             */
/* ------------------------------------------------------------------ */

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URI_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s]+$/;

/** Detect the string formats a given string value satisfies. */
export function detectStringFormats(value: string): StringFormat[] {
  const out: StringFormat[] = [];
  if (UUID_RE.test(value)) out.push('uuid');
  if (DATE_TIME_RE.test(value)) out.push('date-time');
  else if (DATE_RE.test(value)) out.push('date');
  if (EMAIL_RE.test(value)) out.push('email');
  if (URI_RE.test(value)) out.push('uri');
  return out;
}

/* ------------------------------------------------------------------ */
/* inferShape                                                          */
/* ------------------------------------------------------------------ */

/** Infer the Shape of a single JSON value. Never returns a union with duplicates. */
export function inferShape(value: JsonValue, opts?: BuildModelOptions): Shape {
  if (value === null) {
    return { kind: 'null' };
  }
  const t = typeof value;
  if (t === 'string') {
    const s = value as string;
    const formats = detectStringFormats(s);
    const prim: PrimitiveShape = { kind: 'primitive', type: 'string' };
    if (formats.length > 0) prim.formats = formats;
    return prim;
  }
  if (t === 'number') {
    const n = value as number;
    return {
      kind: 'primitive',
      type: Number.isInteger(n) ? 'integer' : 'number',
    };
  }
  if (t === 'boolean') {
    return { kind: 'primitive', type: 'boolean' };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return { kind: 'array', element: null };
    }
    let element: Shape | undefined;
    for (const item of value) {
      const itemShape = inferShape(item, opts);
      element = element === undefined ? itemShape : mergeShapes(element, itemShape, opts);
    }
    return { kind: 'array', element: element ?? null };
  }
  // object
  const obj = value as { [key: string]: JsonValue };
  const fields: ObjectShape['fields'] = {};
  for (const key of Object.keys(obj)) {
    fields[key] = {
      shape: inferShape(obj[key] as JsonValue, opts),
      optional: false,
    };
  }
  return { kind: 'object', fields };
}
