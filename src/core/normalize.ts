import type {
  ApiModel,
  BuildModelOptions,
  Endpoint,
  EndpointResponse,
  Exchange,
  JsonValue,
  PathParam,
  PrimitiveShape,
  Recording,
  Shape,
} from './types.js';
import { inferShape, detectStringFormats } from './infer.js';
import { mergeShapes, shapesEqual as shapesEqualLocal } from './merge.js';

/* ------------------------------------------------------------------ */
/* Segment detection                                                   */
/* ------------------------------------------------------------------ */

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ALL_DIGITS_RE = /^\d+$/;
const HEXISH_RE = /^[0-9a-fA-F]+$/;
const BASE64ISH_RE = /^[A-Za-z0-9_-]+$/;

type SegKind = 'integer' | 'uuid' | 'string' | 'literal';

function classifySegment(seg: string, force: Set<string>): SegKind {
  if (force.has(seg)) return 'string';
  if (ALL_DIGITS_RE.test(seg)) return 'integer';
  if (UUID_RE.test(seg)) return 'uuid';
  if (seg.length >= 16 && (HEXISH_RE.test(seg) || BASE64ISH_RE.test(seg))) {
    return 'string';
  }
  return 'literal';
}

/** Naive singularization: posts -> post, categories -> category, users -> user. */
export function singularize(word: string): string {
  if (word.endsWith('ies') && word.length > 3) {
    return `${word.slice(0, -3)}y`;
  }
  if (word.endsWith('s') && word.length > 1) {
    return word.slice(0, -1);
  }
  return word;
}

export interface NormalizedPath {
  pattern: string;
  params: Array<{ name: string; index: number; format: PathParam['format']; value: string }>;
}

/** Normalize a concrete path into an express-style pattern + param descriptors. */
export function normalizePath(path: string, opts?: BuildModelOptions): NormalizedPath {
  const force = new Set(opts?.forceParamSegments ?? []);
  const raw = path.split('/');
  // Drop the leading empty segment produced by a leading slash.
  const parts = raw[0] === '' ? raw.slice(1) : raw.slice();
  const outSegments: string[] = [];
  const params: NormalizedPath['params'] = [];
  const usedNames = new Set<string>();
  let paramCounter = 0;

  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i] ?? '';
    const kind = classifySegment(seg, force);
    if (kind === 'literal') {
      outSegments.push(seg);
      continue;
    }
    // It is a param.
    const format: PathParam['format'] = kind === 'integer' ? 'integer' : kind === 'uuid' ? 'uuid' : 'string';
    const prev = i > 0 ? parts[i - 1] : undefined;
    let name: string;
    if (prev !== undefined && /^[a-zA-Z]/.test(prev) && classifySegment(prev, force) === 'literal') {
      name = `${singularize(sanitizeName(prev))}Id`;
    } else {
      name = `param${paramCounter}`;
    }
    // De-dupe param names within one pattern.
    let unique = name;
    let suffix = 1;
    while (usedNames.has(unique)) {
      unique = `${name}${suffix}`;
      suffix++;
    }
    usedNames.add(unique);
    params.push({ name: unique, index: i, format, value: seg });
    outSegments.push(`:${unique}`);
    paramCounter++;
  }

  const pattern = `/${outSegments.join('/')}`;
  return { pattern, params };
}

function sanitizeName(seg: string): string {
  // Keep only alphanumerics for a valid identifier fragment.
  const cleaned = seg.replace(/[^a-zA-Z0-9]/g, '');
  return cleaned.length > 0 ? cleaned : 'param';
}

/* ------------------------------------------------------------------ */
/* operationName                                                       */
/* ------------------------------------------------------------------ */

function pascalCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Derive operationId + typeName from method and normalized pattern. */
export function operationName(
  method: string,
  pattern: string,
): { operationId: string; typeName: string } {
  const verb = method.toLowerCase();
  const parts = pattern.split('/').filter((p) => p.length > 0);
  const words: string[] = [];
  for (const part of parts) {
    if (part.startsWith(':')) {
      const paramName = part.slice(1);
      words.push('By');
      words.push(pascalCase(sanitizeToken(paramName)));
    } else {
      words.push(pascalCase(sanitizeToken(part)));
    }
  }
  const typeName = pascalCase(verb) + words.join('');
  const operationId = verb + words.join('');
  return { operationId, typeName };
}

function sanitizeToken(s: string): string {
  // Split on non-alphanumeric, PascalCase each fragment, join.
  const fragments = s.split(/[^a-zA-Z0-9]+/).filter((f) => f.length > 0);
  return fragments.map((f) => pascalCase(f)).join('');
}

/* ------------------------------------------------------------------ */
/* Query coercion                                                      */
/* ------------------------------------------------------------------ */

const INT_RE = /^-?\d+$/;
const FLOAT_RE = /^-?\d+\.\d+$/;

function coerceQueryValue(v: string): JsonValue {
  if (INT_RE.test(v)) return Number(v);
  if (FLOAT_RE.test(v)) return Number(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

/* ------------------------------------------------------------------ */
/* Enum detection                                                      */
/* ------------------------------------------------------------------ */

/**
 * Walk a merged shape in parallel with all raw JSON samples that produced it,
 * collecting distinct primitive values at each leaf position, and attach
 * `enum` where the sample/distinct thresholds hold.
 */
/** Token-like strings that plausibly form a closed set: `admin`, `in_progress`, `v1.2`. */
const ENUM_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;

function applyEnumDetection(shape: Shape, samples: JsonValue[], opts?: BuildModelOptions): Shape {
  const maxValues = opts?.enumMaxValues ?? 8;
  const minSamples = opts?.enumMinSamples ?? 4;
  return walk(shape, samples);

  function walk(s: Shape, vals: JsonValue[]): Shape {
    switch (s.kind) {
      case 'primitive': {
        // Enums are only inferred for token-like strings (e.g. "admin",
        // "in_progress"). Free-form strings and numbers are far more likely
        // to be plain data (ids, titles, counts) than closed sets.
        if (s.type !== 'string') return s;
        if (s.formats && s.formats.length > 0) return s; // never with formats
        const present = vals.filter((v) => typeof v === 'string');
        if (present.length < minSamples) return s;
        if (!present.every((v) => ENUM_TOKEN_RE.test(v))) return s;
        const distinct: string[] = [];
        const seen = new Set<string>();
        for (const v of present) {
          if (!seen.has(v)) {
            seen.add(v);
            distinct.push(v);
          }
        }
        if (distinct.length === 0 || distinct.length > maxValues) return s;
        // Require repetition: a closed set is only believable when values
        // recur. distinct == samples means every sample was unique.
        if (distinct.length > Math.ceil(present.length / 2)) return s;
        const out: PrimitiveShape = { kind: 'primitive', type: s.type };
        out.enum = distinct;
        return out;
      }
      case 'object': {
        const fields: typeof s.fields = {};
        for (const key of Object.keys(s.fields)) {
          const f = s.fields[key];
          if (f === undefined) continue;
          const childVals: JsonValue[] = [];
          for (const v of vals) {
            if (v !== null && typeof v === 'object' && !Array.isArray(v) && key in v) {
              childVals.push(v[key] as JsonValue);
            }
          }
          fields[key] = { shape: walk(f.shape, childVals), optional: f.optional };
        }
        return { kind: 'object', fields };
      }
      case 'record': {
        const childVals: JsonValue[] = [];
        for (const v of vals) {
          if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
            for (const k of Object.keys(v)) childVals.push(v[k] as JsonValue);
          }
        }
        return { kind: 'record', value: walk(s.value, childVals) };
      }
      case 'array': {
        if (s.element === null) return s;
        const childVals: JsonValue[] = [];
        for (const v of vals) {
          if (Array.isArray(v)) for (const item of v) childVals.push(item as JsonValue);
        }
        return { kind: 'array', element: walk(s.element, childVals) };
      }
      case 'union': {
        // Do not descend into union variants for enum detection; ambiguous.
        return s;
      }
      default:
        return s;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Record detection                                                    */
/* ------------------------------------------------------------------ */

function applyRecordDetection(shape: Shape, opts?: BuildModelOptions): Shape {
  const minKeys = opts?.recordMinKeys ?? 12;
  return walk(shape);

  function walk(s: Shape): Shape {
    switch (s.kind) {
      case 'object': {
        const keys = Object.keys(s.fields);
        // First recurse into children.
        const fields: typeof s.fields = {};
        for (const key of keys) {
          const f = s.fields[key];
          if (f === undefined) continue;
          fields[key] = { shape: walk(f.shape), optional: f.optional };
        }
        const rebuilt: Shape = { kind: 'object', fields };
        if (keys.length >= minKeys) {
          const valueShapes = keys.map((k) => fields[k]?.shape).filter((x): x is Shape => x !== undefined);
          if (valueShapes.length === keys.length && allEqual(valueShapes)) {
            const first = valueShapes[0];
            if (first !== undefined) return { kind: 'record', value: first };
          }
        }
        return rebuilt;
      }
      case 'array':
        return { kind: 'array', element: s.element === null ? null : walk(s.element) };
      case 'record':
        return { kind: 'record', value: walk(s.value) };
      case 'union':
        return { kind: 'union', variants: s.variants.map(walk) };
      default:
        return s;
    }
  }
}

function allEqual(shapes: Shape[]): boolean {
  if (shapes.length <= 1) return true;
  const first = shapes[0];
  if (first === undefined) return true;
  return shapes.every((s) => shapesEqualLocal(first, s));
}

/* ------------------------------------------------------------------ */
/* buildApiModel                                                       */
/* ------------------------------------------------------------------ */

interface EndpointAccumulator {
  method: string;
  pattern: string;
  paramInfo: Map<number, { name: string; format: PathParam['format']; samples: string[] }>;
  querySamples: Record<string, string[][]>; // key -> list of value-arrays per exchange
  requestSamples: JsonValue[];
  requestSampleLatest?: JsonValue;
  responsesByStatus: Map<
    number,
    {
      bodySamples: JsonValue[];
      latestSample?: JsonValue;
      contentTypes: Map<string, number>;
      count: number;
    }
  >;
  exchangeIds: string[];
}

function jsonContentType(ct?: string): boolean {
  if (!ct) return false;
  return /\bjson\b/i.test(ct);
}

/**
 * Group a recording's exchanges into endpoints and infer their models.
 */
export function buildApiModel(recording: Recording, opts?: BuildModelOptions): ApiModel {
  const accs = new Map<string, EndpointAccumulator>();

  for (const ex of recording.exchanges) {
    const norm = normalizePath(ex.request.path, opts);
    const key = `${ex.request.method} ${norm.pattern}`;
    let acc = accs.get(key);
    if (acc === undefined) {
      acc = {
        method: ex.request.method,
        pattern: norm.pattern,
        paramInfo: new Map(),
        querySamples: {},
        requestSamples: [],
        responsesByStatus: new Map(),
        exchangeIds: [],
      };
      accs.set(key, acc);
    }
    acc.exchangeIds.push(ex.id);

    // Params
    for (const p of norm.params) {
      let info = acc.paramInfo.get(p.index);
      if (info === undefined) {
        info = { name: p.name, format: p.format, samples: [] };
        acc.paramInfo.set(p.index, info);
      }
      if (info.samples.length < 10 && !info.samples.includes(p.value)) {
        info.samples.push(p.value);
      }
    }

    // Query
    const q = ex.request.query;
    for (const k of Object.keys(q)) {
      const values = q[k];
      if (values === undefined) continue;
      if (acc.querySamples[k] === undefined) acc.querySamples[k] = [];
      acc.querySamples[k].push(values);
    }

    // Request body
    if (ex.request.bodyJson !== undefined) {
      acc.requestSamples.push(ex.request.bodyJson);
      acc.requestSampleLatest = ex.request.bodyJson;
    }

    // Response body per status
    const status = ex.response.status;
    let rs = acc.responsesByStatus.get(status);
    if (rs === undefined) {
      rs = { bodySamples: [], contentTypes: new Map(), count: 0 };
      acc.responsesByStatus.set(status, rs);
    }
    rs.count++;
    const ct = ex.response.headers['content-type'];
    if (ct) rs.contentTypes.set(ct, (rs.contentTypes.get(ct) ?? 0) + 1);
    if (ex.response.bodyJson !== undefined) {
      rs.bodySamples.push(ex.response.bodyJson);
      rs.latestSample = ex.response.bodyJson;
    }
  }

  const endpoints: Endpoint[] = [];
  for (const acc of accs.values()) {
    const { operationId, typeName } = operationName(acc.method, acc.pattern);

    // Params sorted by index.
    const params: PathParam[] = [...acc.paramInfo.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, info]) => ({
        name: info.name,
        index,
        format: info.format,
        samples: info.samples.slice(0, 10),
      }));

    // Query shape
    const queryShape = buildQueryShape(acc.querySamples, opts);

    // Request body shape
    let requestBodyShape: Shape | null = null;
    if (acc.requestSamples.length > 0) {
      requestBodyShape = mergeSamples(acc.requestSamples, opts);
    }

    // Responses
    const responses: EndpointResponse[] = [];
    for (const [status, rs] of acc.responsesByStatus.entries()) {
      let bodyShape: Shape | null = null;
      if (rs.bodySamples.length > 0) {
        bodyShape = mergeSamples(rs.bodySamples, opts);
      }
      const resp: EndpointResponse = { status, bodyShape, count: rs.count };
      if (rs.latestSample !== undefined) resp.sampleBody = rs.latestSample;
      const dominantCt = dominant(rs.contentTypes);
      if (dominantCt !== undefined) resp.contentType = dominantCt;
      responses.push(resp);
    }
    responses.sort((a, b) => a.status - b.status);

    const endpoint: Endpoint = {
      method: acc.method,
      pattern: acc.pattern,
      params,
      queryShape,
      requestBodyShape,
      responses,
      exchangeIds: acc.exchangeIds,
      operationId,
      typeName,
    };
    if (acc.requestSampleLatest !== undefined) endpoint.requestSample = acc.requestSampleLatest;
    endpoints.push(endpoint);
  }

  endpoints.sort((a, b) => {
    if (a.pattern < b.pattern) return -1;
    if (a.pattern > b.pattern) return 1;
    return a.method < b.method ? -1 : a.method > b.method ? 1 : 0;
  });

  return {
    name: recording.meta.name,
    target: recording.meta.target,
    generatedAt: Date.now(),
    endpoints,
  };
}

/** Merge many JSON samples into one shape, then apply record + enum passes. */
function mergeSamples(samples: JsonValue[], opts?: BuildModelOptions): Shape {
  let shape: Shape = { kind: 'unknown' };
  for (const s of samples) {
    shape = mergeShapes(shape, inferShape(s, opts), opts);
  }
  shape = applyRecordDetection(shape, opts);
  shape = applyEnumDetection(shape, samples, opts);
  return shape;
}

function dominant(counts: Map<string, number>): string | undefined {
  let best: string | undefined;
  let bestN = -1;
  for (const [ct, n] of counts.entries()) {
    if (n > bestN) {
      bestN = n;
      best = ct;
    }
  }
  return best;
}

/**
 * Build the query object shape from collected per-exchange value arrays.
 * Multi-valued keys -> array of coerced; single -> coerced scalar. Keys not
 * present in every exchange become optional.
 */
function buildQueryShape(
  querySamples: Record<string, string[][]>,
  opts?: BuildModelOptions,
): Shape | null {
  const keys = Object.keys(querySamples);
  if (keys.length === 0) return null;

  // A key is optional unless it appeared in as many exchanges as the most
  // frequent key (our best proxy for "present in every request with a query").
  let maxPresence = 0;
  for (const k of keys) {
    const arr = querySamples[k];
    if (arr) maxPresence = Math.max(maxPresence, arr.length);
  }

  const fields: Record<string, { shape: Shape; optional: boolean }> = {};
  for (const k of keys) {
    const occurrences = querySamples[k];
    if (occurrences === undefined) continue;
    const coercedSamples: JsonValue[] = [];
    for (const values of occurrences) {
      if (values.length > 1) {
        coercedSamples.push(values.map((v) => coerceQueryValue(v)) as JsonValue);
      } else if (values.length === 1) {
        coercedSamples.push(coerceQueryValue(values[0] ?? ''));
      }
    }
    const shape = mergeSamples(coercedSamples, opts);
    fields[k] = { shape, optional: occurrences.length < maxPresence };
  }
  return { kind: 'object', fields };
}

// Re-export helpers used by tests.
export { coerceQueryValue, detectStringFormats };
