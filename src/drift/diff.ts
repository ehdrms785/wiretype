/**
 * wiretype drift — deterministic diff engine.
 *
 * Compares two ApiModels ("a" → "b") and reports schema drift findings.
 * "a" = what consumers currently believe; "b" = newly observed reality.
 * A finding is BREAKING when code written against "a" can break under "b".
 *
 * The whole module is pure and deterministic (a CI gate depends on it):
 * given the same inputs it MUST produce a deep-equal report every time.
 * No LLM judgment, no Date.now(), no iteration over unordered structures
 * without an explicit sort.
 *
 * Location-in-path convention (so DriftFinding stays flat):
 *  - Response body findings use plain body paths (`author.name`) and set the
 *    `status` field to the HTTP status they apply to.
 *  - Request body findings prefix their path with `request` (whole shape) or
 *    `request.<path>` (nested); `status` is omitted.
 *  - Query findings prefix with `query` / `query.<path>`; `status` omitted.
 *  This is also spelled out in each finding's human-readable message.
 */

import type {
  ApiModel,
  Endpoint,
  EndpointResponse,
  PathParam,
  Shape,
} from '../core/index.js';
import { renderShapeAsTs } from '../codegen/index.js';
import type {
  DiffOptions,
  DriftFinding,
  DriftReport,
  DriftSeverity,
  DriftSideInfo,
} from './types.js';

/* ------------------------------------------------------------------ */
/* Public: diffModels                                                  */
/* ------------------------------------------------------------------ */

/** Compare two models endpoint-by-endpoint. Deterministic, pure. */
export function diffModels(a: ApiModel, b: ApiModel, opts: DiffOptions = {}): DriftReport {
  const ignoreUnmatched = opts.ignoreUnmatchedEndpoints ?? false;

  const aByKey = new Map<string, Endpoint>();
  const bByKey = new Map<string, Endpoint>();
  for (const ep of a.endpoints) aByKey.set(endpointIdentity(ep), ep);
  for (const ep of b.endpoints) bByKey.set(endpointIdentity(ep), ep);

  const findings: DriftFinding[] = [];
  let endpointsCompared = 0;
  let endpointsOnlyInA = 0;
  let endpointsOnlyInB = 0;

  // Endpoints only in a → removed. Sort keys for determinism.
  for (const key of [...aByKey.keys()].sort()) {
    if (!bByKey.has(key)) {
      endpointsOnlyInA += 1;
      if (!ignoreUnmatched) {
        findings.push({
          severity: 'breaking',
          kind: 'endpoint-removed',
          endpoint: key,
          message: `Endpoint ${key} was removed (present in a, absent in b).`,
        });
      }
    }
  }

  // Endpoints only in b → added.
  for (const key of [...bByKey.keys()].sort()) {
    if (!aByKey.has(key)) {
      endpointsOnlyInB += 1;
      if (!ignoreUnmatched) {
        findings.push({
          severity: 'info',
          kind: 'endpoint-added',
          endpoint: key,
          message: `Endpoint ${key} was added (absent in a, present in b).`,
        });
      }
    }
  }

  // Endpoints present on both sides → deep compare.
  for (const key of [...aByKey.keys()].sort()) {
    const epA = aByKey.get(key);
    const epB = bByKey.get(key);
    if (!epA || !epB) continue;
    endpointsCompared += 1;
    findings.push(...diffEndpoint(key, epA, epB));
  }

  const sorted = sortFindings(findings);

  const summary = {
    breaking: sorted.filter((f) => f.severity === 'breaking').length,
    risky: sorted.filter((f) => f.severity === 'risky').length,
    info: sorted.filter((f) => f.severity === 'info').length,
    endpointsCompared,
    endpointsOnlyInA,
    endpointsOnlyInB,
  };

  return {
    a: sideInfo(a),
    b: sideInfo(b),
    findings: sorted,
    summary,
  };
}

function sideInfo(model: ApiModel): DriftSideInfo {
  return {
    name: model.name,
    target: model.target,
    generatedAt: model.generatedAt,
    endpointCount: model.endpoints.length,
  };
}

/** Endpoint identity = method + pattern, e.g. "GET /api/users/:userId". */
function endpointIdentity(ep: Endpoint): string {
  return `${ep.method.toUpperCase()} ${ep.pattern}`;
}

/* ------------------------------------------------------------------ */
/* Endpoint-level diff                                                 */
/* ------------------------------------------------------------------ */

function diffEndpoint(endpoint: string, a: Endpoint, b: Endpoint): DriftFinding[] {
  const findings: DriftFinding[] = [];

  findings.push(...diffResponses(endpoint, a.responses, b.responses));
  findings.push(...diffRequest(endpoint, a.requestBodyShape, b.requestBodyShape));
  findings.push(...diffQuery(endpoint, a.queryShape, b.queryShape));
  findings.push(...diffParams(endpoint, a.params, b.params));

  return findings;
}

/** Response variants matched by exact status. */
function diffResponses(
  endpoint: string,
  a: EndpointResponse[],
  b: EndpointResponse[],
): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const aByStatus = new Map<number, EndpointResponse>();
  const bByStatus = new Map<number, EndpointResponse>();
  for (const r of a) aByStatus.set(r.status, r);
  for (const r of b) bByStatus.set(r.status, r);

  const allStatuses = [...new Set([...aByStatus.keys(), ...bByStatus.keys()])].sort(
    (x, y) => x - y,
  );

  for (const status of allStatuses) {
    const rA = aByStatus.get(status);
    const rB = bByStatus.get(status);
    if (rA && !rB) {
      findings.push({
        severity: 'risky',
        kind: 'status-removed',
        endpoint,
        status,
        message: `Response status ${status} was removed (present in a, absent in b).`,
      });
    } else if (!rA && rB) {
      findings.push({
        severity: 'risky',
        kind: 'status-added',
        endpoint,
        status,
        message: `Response status ${status} was added (absent in a, present in b).`,
      });
    } else if (rA && rB) {
      // Same status on both sides: compare body shapes. The observed
      // response count seeds the confidence (bSamples) propagation.
      findings.push(
        ...diffShapes(rA.bodyShape, rB.bodyShape, { endpoint, status, bSeen: rB.count }),
      );
    }
  }
  return findings;
}

/**
 * Request body drift. When the whole shape appears/disappears we emit an
 * endpoint-level `request-changed`; otherwise we recurse with basePath
 * 'request'. Per ARCHITECTURE: request required in b but absent in a →
 * breaking; removed (present in a, absent in b) → info.
 */
function diffRequest(endpoint: string, a: Shape | null, b: Shape | null): DriftFinding[] {
  if (a === null && b === null) return [];
  if (a === null && b !== null) {
    return [
      {
        severity: 'breaking',
        kind: 'request-changed',
        endpoint,
        path: 'request',
        before: 'none',
        after: renderShapeAsTs(b),
        message:
          'Request body is now required in b but was absent in a (path prefix "request").',
      },
    ];
  }
  if (a !== null && b === null) {
    return [
      {
        severity: 'info',
        kind: 'request-changed',
        endpoint,
        path: 'request',
        before: renderShapeAsTs(a),
        after: 'none',
        message:
          'Request body was removed in b (present in a) (path prefix "request").',
      },
    ];
  }
  // Both present: shape-level rules, rooted at 'request'.
  return diffShapes(a, b, { endpoint, basePath: 'request' });
}

/**
 * Query drift. Query params are usually caller-controlled, so a whole-shape
 * removal is info, but a newly-required query shape appearing in b is risky.
 * Per ARCHITECTURE: query removed → info, query required-new → risky. Nested
 * changes recurse with basePath 'query'.
 */
function diffQuery(endpoint: string, a: Shape | null, b: Shape | null): DriftFinding[] {
  if (a === null && b === null) return [];
  if (a === null && b !== null) {
    return [
      {
        severity: 'risky',
        kind: 'query-changed',
        endpoint,
        path: 'query',
        before: 'none',
        after: renderShapeAsTs(b),
        message:
          'Query shape appeared in b (absent in a) (path prefix "query").',
      },
    ];
  }
  if (a !== null && b === null) {
    return [
      {
        severity: 'info',
        kind: 'query-changed',
        endpoint,
        path: 'query',
        before: renderShapeAsTs(a),
        after: 'none',
        message:
          'Query shape was removed in b (present in a) (path prefix "query").',
      },
    ];
  }
  return diffShapes(a, b, { endpoint, basePath: 'query' });
}

/**
 * Params drift: only param FORMAT changes matter (integer→uuid etc.) → risky.
 * Params are matched by name. Added/removed params are not reported here
 * (endpoint identity already covers pattern differences).
 */
function diffParams(endpoint: string, a: PathParam[], b: PathParam[]): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const bByName = new Map<string, PathParam>();
  for (const p of b) bByName.set(p.name, p);

  for (const pa of [...a].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
    const pb = bByName.get(pa.name);
    if (pb && pa.format !== pb.format) {
      findings.push({
        severity: 'risky',
        kind: 'params-changed',
        endpoint,
        path: pa.name,
        before: pa.format,
        after: pb.format,
        message: `Path param "${pa.name}" format changed from ${pa.format} to ${pb.format}.`,
      });
    }
  }
  return findings;
}

/* ------------------------------------------------------------------ */
/* Shape-level diff                                                    */
/* ------------------------------------------------------------------ */

interface ShapeCtx {
  endpoint: string;
  status?: number;
  basePath?: string;
  /**
   * Observed-side evidence at the current location: response count at the
   * root, ObjectShape.samples once inside an observed object, FieldShape.seen
   * when descending through a field. Attached to findings as bSamples.
   */
  bSeen?: number;
}

/**
 * Compare two shapes, reporting findings rooted at basePath. Exposed so agent
 * tooling can compare a single claimed shape against an observed one.
 *
 * A null shape argument means "no body / shape absent". null↔null is a no-op;
 * null↔shape and shape↔null at the ROOT are treated by callers (request/query
 * handle their own appear/disappear rules); within diffShapes a top-level null
 * vs non-null is reported as a type change.
 */
export function diffShapes(
  a: Shape | null,
  b: Shape | null,
  ctx: { endpoint: string; status?: number; basePath?: string; bSeen?: number },
): DriftFinding[] {
  if (a === null && b === null) return [];
  const path = ctx.basePath;
  if (a === null && b !== null) {
    return [
      finding(ctx, path, 'type-changed', 'breaking', 'none', b, 'Body appeared in b (absent in a).'),
    ];
  }
  if (a !== null && b === null) {
    return [
      finding(ctx, path, 'type-changed', 'breaking', a, 'none', 'Body was removed in b (present in a).'),
    ];
  }
  // Both non-null.
  return walkShapes(a as Shape, b as Shape, ctx, path);
}

/**
 * Core recursive walk. `path` is the current JSON path (undefined = root).
 * Nullability is peeled off first: a shape "allows null" when it is a
 * NullShape or a union containing a null variant. We compare the non-null
 * remainder recursively.
 */
function walkShapes(
  a: Shape,
  b: Shape,
  ctx: ShapeCtx,
  path: string | undefined,
): DriftFinding[] {
  const findings: DriftFinding[] = [];

  const aNull = allowsNull(a);
  const bNull = allowsNull(b);

  // Nullability change (only report when it actually flipped).
  if (bNull && !aNull) {
    findings.push(
      finding(ctx, path, 'nullability-changed', 'breaking', a, b, 'Became nullable in b (a did not allow null).'),
    );
  } else if (!bNull && aNull) {
    findings.push(
      finding(ctx, path, 'nullability-changed', 'info', a, b, 'Became non-nullable in b (a allowed null).'),
    );
  }

  const aCore = stripNull(a);
  const bCore = stripNull(b);

  // If either side collapsed to nothing (pure null shape), the nullability
  // finding above already captured the story; nothing more to recurse into.
  if (aCore === null || bCore === null) return findings;

  findings.push(...compareCore(aCore, bCore, ctx, path));
  return findings;
}

/**
 * Compare two non-nullable shapes of possibly-different kinds.
 */
function compareCore(
  a: Shape,
  b: Shape,
  ctx: ShapeCtx,
  path: string | undefined,
): DriftFinding[] {
  // unknown handling: a knew nothing → info; concrete a vs unknown b → risky.
  if (a.kind === 'unknown' && b.kind === 'unknown') return [];
  if (a.kind === 'unknown') {
    return [
      finding(ctx, path, 'type-changed', 'info', a, b, 'Type refined in b (a was unknown).'),
    ];
  }
  if (b.kind === 'unknown') {
    return [
      finding(ctx, path, 'type-changed', 'risky', a, b, 'Type became unknown in b (a was concrete).'),
    ];
  }

  // Unions beyond nullability.
  if (a.kind === 'union' || b.kind === 'union') {
    return compareUnions(a, b, ctx, path);
  }

  // Kind mismatch (object vs array, primitive vs object, etc.) → breaking.
  if (a.kind !== b.kind) {
    return [
      finding(ctx, path, 'type-changed', 'breaking', a, b, `Kind changed from ${a.kind} to ${b.kind}.`),
    ];
  }

  switch (a.kind) {
    case 'primitive':
      return comparePrimitive(a, b as Extract<Shape, { kind: 'primitive' }>, ctx, path);
    case 'object': {
      const bo = b as Extract<Shape, { kind: 'object' }>;
      const objCtx = bo.samples !== undefined ? { ...ctx, bSeen: bo.samples } : ctx;
      return compareObject(a, bo, objCtx, path);
    }
    case 'record':
      return diffShapes(
        (a as Extract<Shape, { kind: 'record' }>).value,
        (b as Extract<Shape, { kind: 'record' }>).value,
        {
          endpoint: ctx.endpoint,
          status: ctx.status,
          basePath: childPath(path, '{}'),
          bSeen: ctx.bSeen,
        },
      );
    case 'array': {
      const ea = (a as Extract<Shape, { kind: 'array' }>).element;
      const eb = (b as Extract<Shape, { kind: 'array' }>).element;
      return diffShapes(ea, eb, {
        endpoint: ctx.endpoint,
        status: ctx.status,
        basePath: childPath(path, '[]'),
        bSeen: ctx.bSeen,
      });
    }
    case 'null':
      // Both pure null: no drift (nullability handled upstream).
      return [];
  }
}

/** Primitive vs primitive: type, format, enum. */
function comparePrimitive(
  a: Extract<Shape, { kind: 'primitive' }>,
  b: Extract<Shape, { kind: 'primitive' }>,
  ctx: ShapeCtx,
  path: string | undefined,
): DriftFinding[] {
  const findings: DriftFinding[] = [];

  // Type change.
  if (a.type !== b.type) {
    const severity = primitiveTypeSeverity(a.type, b.type);
    findings.push(
      finding(ctx, path, 'type-changed', severity, a, b, `Primitive type changed from ${a.type} to ${b.type}.`),
    );
  }

  // Enum drift.
  const aEnum = a.enum ?? null;
  const bEnum = b.enum ?? null;
  if (aEnum && bEnum) {
    const added = bEnum.filter((v) => !aEnum.includes(v));
    const removed = aEnum.filter((v) => !bEnum.includes(v));
    if (added.length > 0) {
      findings.push(
        finding(ctx, path, 'enum-values-changed', 'risky', a, b, `Enum values added in b: ${added.map(String).join(', ')}.`),
      );
    }
    if (removed.length > 0 && added.length === 0) {
      // Only-removed → info. (If both added & removed, the added risky finding dominates.)
      findings.push(
        finding(ctx, path, 'enum-values-changed', 'info', a, b, `Enum values removed in b: ${removed.map(String).join(', ')}.`),
      );
    } else if (removed.length > 0 && added.length > 0) {
      findings.push(
        finding(ctx, path, 'enum-values-changed', 'info', a, b, `Enum values removed in b: ${removed.map(String).join(', ')}.`),
      );
    }
  } else if (aEnum && !bEnum) {
    // Closed set became open primitive → risky.
    findings.push(
      finding(ctx, path, 'enum-values-changed', 'risky', a, b, 'Enum in a became an open primitive in b (closed set opened).'),
    );
  }
  // !aEnum && bEnum: a was open, b closed → tightening, not a consumer break; no finding.

  // Format drift (only when the underlying type is still a string on both,
  // or generally when formats differ). Report lost/changed as risky, gained
  // as info.
  const aFmt = formatSet(a);
  const bFmt = formatSet(b);
  if (aFmt.length > 0 || bFmt.length > 0) {
    const lostOrChanged = aFmt.filter((f) => !bFmt.includes(f));
    const gained = bFmt.filter((f) => !aFmt.includes(f));
    if (lostOrChanged.length > 0) {
      findings.push(
        finding(ctx, path, 'format-changed', 'risky', a, b, `Format lost or changed in b (was ${aFmt.join(', ') || 'none'}, now ${bFmt.join(', ') || 'none'}).`),
      );
    } else if (gained.length > 0) {
      findings.push(
        finding(ctx, path, 'format-changed', 'info', a, b, `Format gained in b (now ${bFmt.join(', ')}).`),
      );
    }
  }

  return findings;
}

function primitiveTypeSeverity(
  aType: Extract<Shape, { kind: 'primitive' }>['type'],
  bType: Extract<Shape, { kind: 'primitive' }>['type'],
): DriftSeverity {
  // integer→number widening is info; number→integer is info; anything else breaking.
  if (aType === 'integer' && bType === 'number') return 'info';
  if (aType === 'number' && bType === 'integer') return 'info';
  return 'breaking';
}

/** Object vs object: field add/remove/optionality plus recurse. */
function compareObject(
  a: Extract<Shape, { kind: 'object' }>,
  b: Extract<Shape, { kind: 'object' }>,
  ctx: ShapeCtx,
  path: string | undefined,
): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const keys = [...new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])].sort();

  for (const key of keys) {
    const fa = a.fields[key];
    const fb = b.fields[key];
    const childP = childPath(path, key);
    if (fa && !fb) {
      findings.push(
        finding(ctx, childP, 'field-removed', 'breaking', fa.shape, undefined, `Field "${key}" was removed in b.`),
      );
    } else if (!fa && fb) {
      findings.push(
        finding(
          { ...ctx, bSeen: fb.seen ?? ctx.bSeen },
          childP,
          'field-added',
          'info',
          undefined,
          fb.shape,
          `Field "${key}" was added in b.`,
        ),
      );
    } else if (fa && fb) {
      // Optionality change.
      if (fb.optional && !fa.optional) {
        findings.push(
          finding(ctx, childP, 'optionality-changed', 'risky', fa.shape, fb.shape, `Field "${key}" became optional in b (was required).`),
        );
      } else if (!fb.optional && fa.optional) {
        findings.push(
          finding(ctx, childP, 'optionality-changed', 'info', fa.shape, fb.shape, `Field "${key}" became required in b (was optional).`),
        );
      }
      // Recurse into the field's shape. The field's presence count (seen)
      // is the evidence backing anything inferred about its value.
      findings.push(
        ...diffShapes(fa.shape, fb.shape, {
          endpoint: ctx.endpoint,
          status: ctx.status,
          basePath: childP,
          bSeen: fb.seen ?? ctx.bSeen,
        }),
      );
    }
  }
  return findings;
}

/**
 * Compare shapes when at least one side is a union (beyond simple nullability,
 * which was already peeled off by walkShapes / stripNull).
 *
 * Strategy (deterministic): treat each side as a list of its non-null variants.
 * Match variants pairwise by kind — object↔object, and primitive↔primitive of
 * the same `type`. For a matched pair, recurse via diffShapes. An unmatched
 * variant present only in b means b widened the type (a consumer written
 * against a may not handle it) → risky `type-changed`. An unmatched variant
 * present only in a means b narrowed the type → info.
 *
 * A single-variant "union" is collapsed to that variant by stripNull already;
 * this function only runs when a genuine multi-variant union is involved.
 */
function compareUnions(
  a: Shape,
  b: Shape,
  ctx: ShapeCtx,
  path: string | undefined,
): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const aVars = variantList(a);
  const bVars = variantList(b);

  const bUsed = new Array<boolean>(bVars.length).fill(false);

  // Match a-variants against b-variants by kind (+ primitive type).
  for (const av of aVars) {
    let matchedIdx = -1;
    for (let i = 0; i < bVars.length; i++) {
      if (bUsed[i]) continue;
      const bv = bVars[i]!;
      if (variantMatches(av, bv)) {
        matchedIdx = i;
        break;
      }
    }
    if (matchedIdx >= 0) {
      bUsed[matchedIdx] = true;
      findings.push(
        ...diffShapes(av, bVars[matchedIdx]!, {
          endpoint: ctx.endpoint,
          status: ctx.status,
          basePath: path,
          bSeen: ctx.bSeen,
        }),
      );
    } else {
      // a-variant with no counterpart in b → b narrowed → info.
      findings.push(
        finding(ctx, path, 'type-changed', 'info', av, b, `Variant "${variantLabel(av)}" from a is absent in b (type narrowed).`),
      );
    }
  }

  // Unmatched b-variants → b widened → risky.
  for (let i = 0; i < bVars.length; i++) {
    if (bUsed[i]) continue;
    const bv = bVars[i]!;
    findings.push(
      finding(ctx, path, 'type-changed', 'risky', a, bv, `Variant "${variantLabel(bv)}" appeared in b (type widened).`),
    );
  }

  return findings;
}

/** True when a and b are considered the "same slot" for union matching. */
function variantMatches(a: Shape, b: Shape): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'primitive' && b.kind === 'primitive') {
    return a.type === b.type;
  }
  return true;
}

function variantLabel(s: Shape): string {
  if (s.kind === 'primitive') return s.type;
  return s.kind;
}

/** Non-null variants of a shape, as a stable list. */
function variantList(s: Shape): Shape[] {
  if (s.kind === 'union') {
    return s.variants.filter((v) => v.kind !== 'null');
  }
  if (s.kind === 'null') return [];
  return [s];
}

/* ------------------------------------------------------------------ */
/* Nullability helpers                                                 */
/* ------------------------------------------------------------------ */

/** A shape "allows null" when it is a NullShape or a union with a null variant. */
function allowsNull(s: Shape): boolean {
  if (s.kind === 'null') return true;
  if (s.kind === 'union') return s.variants.some((v) => v.kind === 'null');
  return false;
}

/**
 * Return the non-null remainder of a shape:
 *  - null shape → null (nothing left)
 *  - union: drop null variants; a remainder of 1 collapses to that variant;
 *    0 → null; >1 → a union of the survivors
 *  - anything else → itself
 */
function stripNull(s: Shape): Shape | null {
  if (s.kind === 'null') return null;
  if (s.kind === 'union') {
    const survivors = s.variants.filter((v) => v.kind !== 'null');
    if (survivors.length === 0) return null;
    if (survivors.length === 1) return survivors[0]!;
    return { kind: 'union', variants: survivors };
  }
  return s;
}

/** String formats of a primitive as a stable sorted list ([] when none). */
function formatSet(s: Shape): string[] {
  if (s.kind === 'primitive' && s.formats && s.formats.length > 0) {
    return [...s.formats].sort();
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* Path & finding construction                                         */
/* ------------------------------------------------------------------ */

/**
 * Build a child path. `suffix` is either a field name (joined with '.'),
 * or a structural marker '[]' / '{}' (appended directly).
 *   root + 'author'  → 'author'
 *   'author' + 'name' → 'author.name'
 *   'items' + '[]'    → 'items[]'
 *   'items[]' + 'role'→ 'items[].role'
 *   root + '[]'       → '[]'
 *   'meta' + '{}'     → 'meta{}'
 */
function childPath(parent: string | undefined, suffix: string): string {
  const structural = suffix === '[]' || suffix === '{}';
  if (parent === undefined || parent === '') {
    return structural ? suffix : suffix;
  }
  return structural ? `${parent}${suffix}` : `${parent}.${suffix}`;
}

function finding(
  ctx: ShapeCtx,
  path: string | undefined,
  kind: DriftFinding['kind'],
  severity: DriftSeverity,
  before: Shape | string | undefined,
  after: Shape | string | undefined,
  message: string,
): DriftFinding {
  const f: DriftFinding = {
    severity,
    kind,
    endpoint: ctx.endpoint,
    message,
  };
  if (ctx.status !== undefined) f.status = ctx.status;
  if (path !== undefined) f.path = path;
  if (ctx.bSeen !== undefined) f.bSamples = ctx.bSeen;
  const beforeText = renderMaybe(before);
  const afterText = renderMaybe(after);
  if (beforeText !== undefined) f.before = beforeText;
  if (afterText !== undefined) f.after = afterText;
  return f;
}

function renderMaybe(v: Shape | string | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'string') return v;
  const text = renderShapeAsTs(v);
  // renderShapeAsTs collapses integer→"number" and drops string formats,
  // which makes findings like format-changed read "string → string".
  // Annotate primitives so the change is visible in reports.
  if (v.kind === 'primitive') {
    if (v.type === 'integer') return 'number (integer)';
    if (v.formats && v.formats.length > 0 && !v.enum) {
      return `${text} (${v.formats.join(', ')})`;
    }
  }
  return text;
}

/* ------------------------------------------------------------------ */
/* Ordering                                                            */
/* ------------------------------------------------------------------ */

const SEVERITY_RANK: Record<DriftSeverity, number> = {
  breaking: 0,
  risky: 1,
  info: 2,
};

/**
 * Sort findings: severity (breaking→risky→info), then endpoint string, then
 * path (undefined paths first), then kind. Fully deterministic.
 */
function sortFindings(findings: DriftFinding[]): DriftFinding[] {
  return [...findings].sort((x, y) => {
    const s = SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity];
    if (s !== 0) return s;
    if (x.endpoint !== y.endpoint) return x.endpoint < y.endpoint ? -1 : 1;
    const px = x.path;
    const py = y.path;
    if (px === undefined && py !== undefined) return -1;
    if (px !== undefined && py === undefined) return 1;
    if (px !== undefined && py !== undefined && px !== py) {
      return px < py ? -1 : 1;
    }
    if (x.kind !== y.kind) return x.kind < y.kind ? -1 : 1;
    return 0;
  });
}
