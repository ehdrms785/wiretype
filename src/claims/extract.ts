import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type * as TS from 'typescript';
import type { ApiModel, Endpoint, FieldShape, Shape } from '../core/index.js';
import { mergeShapes, operationName } from '../core/index.js';
import type {
  ClaimRefusal,
  ClaimsMap,
  ClaimsMapEntry,
  ClaimsResult,
  ExtractClaimsOptions,
  TypeRef,
} from './types.js';

/** Max nesting depth before refusing (defends against pathological types). */
const MAX_DEPTH = 32;

/** Deterministic, per-slot refusal. Thrown inside translation, caught per entry. */
class Refusal extends Error {}

type Ts = typeof TS;

/** Load the typescript package, with an actionable error when absent. */
async function loadTypescript(): Promise<Ts> {
  try {
    const mod = (await import('typescript')) as unknown as { default?: Ts } & Ts;
    return (mod.default ?? mod) as Ts;
  } catch {
    throw new Error(
      'wiretype claims requires the "typescript" package (>=5). ' +
        'Install it in the project: npm i -D typescript',
    );
  }
}

/* ------------------------------------------------------------------ */
/* Map loading                                                         */
/* ------------------------------------------------------------------ */

function parseRef(ref: TypeRef): { file: string; typeName: string } {
  const hash = ref.lastIndexOf('#');
  if (hash <= 0 || hash === ref.length - 1) {
    throw new Refusal(`Invalid type reference "${ref}" (expected "path/to/file.ts#TypeName").`);
  }
  return { file: ref.slice(0, hash), typeName: ref.slice(hash + 1) };
}

async function loadMap(mapPath: string): Promise<{ map: ClaimsMap; baseDir: string }> {
  const abs = resolve(mapPath);
  let raw: string;
  try {
    raw = await readFile(abs, 'utf8');
  } catch {
    throw new Error(`Claims map not found: ${abs}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse claims map ${abs}: ${message}`);
  }
  const obj = parsed as Partial<ClaimsMap>;
  if (!Array.isArray(obj.entries)) {
    throw new Error(`Claims map ${abs} must be { "entries": [...] }.`);
  }
  for (const e of obj.entries) {
    if (typeof e.method !== 'string' || typeof e.pattern !== 'string') {
      throw new Error(`Claims map entry missing method/pattern: ${JSON.stringify(e)}`);
    }
  }
  return { map: obj as ClaimsMap, baseDir: dirname(abs) };
}

/* ------------------------------------------------------------------ */
/* Program construction                                                */
/* ------------------------------------------------------------------ */

interface BuiltProgram {
  program: TS.Program;
  /** The tsconfig the compiler options actually came from (null = built-in defaults). */
  tsconfigPath: string | null;
}

/**
 * A "solution-style" tsconfig (`{ "files": [], "references": [...] }` with no
 * compilerOptions — the standard vite/tsc monorepo layout) carries no options
 * itself; naively parsing it yields EMPTY compiler options, which turns
 * strictNullChecks off and silently erases `| null` from every union.
 * Follow the first existing reference instead (chains capped at depth 4).
 */
function resolveSolutionStyle(ts: Ts, configPath: string, depth = 0): string {
  if (depth >= 4) return configPath;
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error !== undefined) return configPath;
  const config = read.config as {
    compilerOptions?: Record<string, unknown>;
    references?: Array<{ path?: string }>;
    files?: unknown[];
  };
  const hasOwnOptions =
    config.compilerOptions !== undefined && Object.keys(config.compilerOptions).length > 0;
  const refs = Array.isArray(config.references) ? config.references : [];
  if (hasOwnOptions || refs.length === 0) return configPath;

  for (const ref of refs) {
    if (typeof ref.path !== 'string') continue;
    let candidate = resolve(dirname(configPath), ref.path);
    if (!ts.sys.fileExists(candidate)) {
      const nested = join(candidate, 'tsconfig.json');
      if (!ts.sys.fileExists(nested)) continue;
      candidate = nested;
    }
    return resolveSolutionStyle(ts, candidate, depth + 1);
  }
  return configPath;
}

function buildProgram(
  ts: Ts,
  rootFiles: string[],
  baseDir: string,
  tsconfig?: string,
): BuiltProgram {
  let options: TS.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noEmit: true,
    allowJs: false,
  };

  let configPath =
    tsconfig !== undefined
      ? resolve(tsconfig)
      : ts.findConfigFile(baseDir, ts.sys.fileExists, 'tsconfig.json');

  let tsconfigPath: string | null = null;
  if (configPath !== undefined) {
    configPath = resolveSolutionStyle(ts, configPath);
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (read.error === undefined) {
      const parsed = ts.parseJsonConfigFileContent(
        read.config,
        ts.sys,
        dirname(configPath),
      );
      options = { ...parsed.options, noEmit: true, skipLibCheck: true };
      tsconfigPath = configPath;
    }
  }

  // NORMATIVE: claims extraction is meaningless without null fidelity — a
  // project compiling with strictNullChecks off would have every `| null`
  // erased from its declared unions. Always force it on, regardless of what
  // the project's tsconfig says.
  options.strictNullChecks = true;

  return { program: ts.createProgram({ rootNames: rootFiles, options }), tsconfigPath };
}

/* ------------------------------------------------------------------ */
/* Type → Shape translation (the deterministic core)                   */
/* ------------------------------------------------------------------ */

interface TranslateCtx {
  ts: Ts;
  checker: TS.TypeChecker;
  /** Cycle guard: types currently on the translation stack. */
  stack: Set<TS.Type>;
}

function typeToShape(ctx: TranslateCtx, type: TS.Type, depth: number): Shape {
  const { ts, checker } = ctx;
  if (depth > MAX_DEPTH) throw new Refusal(`Type nesting exceeds ${MAX_DEPTH} levels.`);
  if (ctx.stack.has(type)) {
    throw new Refusal('Recursive type detected — JSON payloads cannot be cyclic.');
  }

  const flags = type.getFlags();

  // Opt-outs and non-JSON types first: refuse or map honestly.
  if (flags & ts.TypeFlags.Any) return { kind: 'unknown' };
  if (flags & ts.TypeFlags.Unknown) return { kind: 'unknown' };
  if (flags & ts.TypeFlags.Never) throw new Refusal('"never" cannot describe a JSON value.');
  if (flags & (ts.TypeFlags.BigInt | ts.TypeFlags.BigIntLiteral)) {
    throw new Refusal('bigint is not a JSON type.');
  }
  if (flags & (ts.TypeFlags.ESSymbol | ts.TypeFlags.UniqueESSymbol)) {
    throw new Refusal('symbol is not a JSON type.');
  }
  if (flags & ts.TypeFlags.TypeParameter) {
    throw new Refusal(
      `Unresolved type parameter "${checker.typeToString(type)}" — claim a concrete ` +
        'instantiation instead (e.g. export type XClaim = Wrapper<Concrete> in a shim file).',
    );
  }
  if (flags & ts.TypeFlags.Void || flags & ts.TypeFlags.Undefined) {
    throw new Refusal('undefined/void cannot appear in JSON — use null or an optional field.');
  }

  if (flags & ts.TypeFlags.Null) return { kind: 'null' };

  // Literals.
  if (type.isStringLiteral()) {
    return { kind: 'primitive', type: 'string', enum: [type.value] };
  }
  if (type.isNumberLiteral()) {
    return {
      kind: 'primitive',
      type: Number.isInteger(type.value) ? 'integer' : 'number',
      enum: [type.value],
    };
  }
  if (flags & ts.TypeFlags.BooleanLiteral) {
    return { kind: 'primitive', type: 'boolean' };
  }

  // Plain primitives.
  if (flags & ts.TypeFlags.String) return { kind: 'primitive', type: 'string' };
  if (flags & ts.TypeFlags.Number) return { kind: 'primitive', type: 'number' };
  if (flags & ts.TypeFlags.Boolean) return { kind: 'primitive', type: 'boolean' };

  // Unions (includes TS enums, which are unions of literals).
  if (type.isUnion()) {
    return unionToShape(ctx, type, depth);
  }

  // Intersections: the checker can hand us the merged property set.
  if (type.isIntersection()) {
    return objectToShape(ctx, type, depth);
  }

  if (flags & ts.TypeFlags.Object) {
    ctx.stack.add(type);
    try {
      // Arrays / tuples.
      if (checker.isArrayType(type)) {
        const args = checker.getTypeArguments(type as TS.TypeReference);
        const el = args[0];
        if (el === undefined) return { kind: 'array', element: null };
        return { kind: 'array', element: typeToShape(ctx, el, depth + 1) };
      }
      if (checker.isTupleType(type)) {
        const args = checker.getTypeArguments(type as TS.TypeReference);
        if (args.length === 0) return { kind: 'array', element: null };
        let element: Shape | undefined;
        for (const arg of args) {
          const s = typeToShape(ctx, arg, depth + 1);
          element = element === undefined ? s : mergeShapes(element, s);
        }
        return { kind: 'array', element: element ?? null };
      }

      // Known non-JSON object types.
      const symbolName = type.getSymbol()?.getName();
      if (symbolName === 'Date') {
        throw new Refusal(
          'Date is not a JSON type — the wire carries a string (or number). ' +
            'Claim the transport type instead.',
        );
      }
      if (symbolName === 'Promise') {
        throw new Refusal('Promise is not a JSON type — claim the awaited type.');
      }
      if (symbolName === 'Map' || symbolName === 'Set') {
        throw new Refusal(`${symbolName} is not a JSON type.`);
      }

      // Callables are not data.
      if (
        checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0 ||
        checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0
      ) {
        throw new Refusal('Function types cannot describe a JSON value.');
      }

      return objectToShape(ctx, type, depth);
    } finally {
      ctx.stack.delete(type);
    }
  }

  throw new Refusal(`Unsupported type "${checker.typeToString(type)}".`);
}

/** Union → Shape: strip undefined, fold literal runs into enums, keep null. */
function unionToShape(ctx: TranslateCtx, type: TS.UnionType, depth: number): Shape {
  const { ts, checker } = ctx;

  const stringLiterals: string[] = [];
  const numberLiterals: number[] = [];
  let sawBooleanLiteral = false;
  let sawNull = false;
  const rest: TS.Type[] = [];

  for (const part of type.types) {
    const f = part.getFlags();
    if (f & ts.TypeFlags.Undefined) continue; // optionality lives on the field
    if (f & ts.TypeFlags.Null) {
      sawNull = true;
      continue;
    }
    if (part.isStringLiteral()) {
      stringLiterals.push(part.value);
      continue;
    }
    if (part.isNumberLiteral()) {
      numberLiterals.push(part.value);
      continue;
    }
    if (f & ts.TypeFlags.BooleanLiteral) {
      sawBooleanLiteral = true;
      continue;
    }
    rest.push(part);
  }

  const variants: Shape[] = [];
  if (stringLiterals.length > 0) {
    // Literal union → closed enum. Sort for determinism (checker order is
    // stable but sorting makes the output obviously canonical).
    variants.push({
      kind: 'primitive',
      type: 'string',
      enum: [...new Set(stringLiterals)].sort(),
    });
  }
  if (numberLiterals.length > 0) {
    const distinct = [...new Set(numberLiterals)].sort((x, y) => x - y);
    variants.push({
      kind: 'primitive',
      type: distinct.every((n) => Number.isInteger(n)) ? 'integer' : 'number',
      enum: distinct,
    });
  }
  if (sawBooleanLiteral) {
    variants.push({ kind: 'primitive', type: 'boolean' });
  }
  for (const part of rest) {
    variants.push(typeToShape(ctx, part, depth + 1));
  }
  if (sawNull) variants.push({ kind: 'null' });

  if (variants.length === 0) {
    throw new Refusal(`Union "${checker.typeToString(type)}" has no JSON-representable variant.`);
  }
  if (variants.length === 1) return variants[0]!;

  // A plain-string variant absorbs a string-enum variant (e.g. `'a' | string`).
  return dedupeUnion(variants);
}

function dedupeUnion(variants: Shape[]): Shape {
  const out: Shape[] = [];
  for (const v of variants) {
    const swallowedByPlainString =
      v.kind === 'primitive' &&
      v.type === 'string' &&
      v.enum !== undefined &&
      variants.some((o) => o !== v && o.kind === 'primitive' && o.type === 'string' && o.enum === undefined);
    if (swallowedByPlainString) continue;
    out.push(v);
  }
  if (out.length === 1) return out[0]!;
  return { kind: 'union', variants: out };
}

/** Object-like type → ObjectShape or RecordShape. */
function objectToShape(ctx: TranslateCtx, type: TS.Type, depth: number): Shape {
  const { ts, checker } = ctx;

  const props = checker.getPropertiesOfType(type);
  const stringIndex = checker.getIndexInfoOfType(type, ts.IndexKind.String);

  if (props.length === 0 && stringIndex !== undefined) {
    return { kind: 'record', value: typeToShape(ctx, stringIndex.type, depth + 1) };
  }
  if (stringIndex !== undefined && props.length > 0) {
    throw new Refusal(
      'Mixed index signature + named properties cannot be expressed as a wiretype Shape.',
    );
  }

  const fields: Record<string, FieldShape> = {};
  // Deterministic field order: sorted by property name.
  const sorted = [...props].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  for (const prop of sorted) {
    const decl = prop.valueDeclaration ?? prop.declarations?.[0];
    if (decl === undefined) {
      throw new Refusal(`Property "${prop.name}" has no declaration (synthetic type?).`);
    }
    const propType = checker.getTypeOfSymbolAtLocation(prop, decl);
    let optional = (prop.getFlags() & ts.SymbolFlags.Optional) !== 0;

    // `X | undefined` on a required property also reads as optional-ish on
    // the wire; unionToShape strips undefined, we record optionality here.
    if (propType.isUnion() && propType.types.some((t) => t.getFlags() & ts.TypeFlags.Undefined)) {
      optional = true;
    }

    let shape: Shape;
    try {
      shape = typeToShape(ctx, propType, depth + 1);
    } catch (err) {
      if (err instanceof Refusal) {
        throw new Refusal(`Property "${prop.name}": ${err.message}`);
      }
      throw err;
    }
    fields[prop.name] = { shape, optional };
  }
  return { kind: 'object', fields };
}

/* ------------------------------------------------------------------ */
/* Public entry                                                        */
/* ------------------------------------------------------------------ */

/**
 * Extract a claims ApiModel from a claims map. Deterministic: same sources +
 * same map → deep-equal result (generatedAt is fixed to 0 on purpose).
 */
export async function extractClaims(opts: ExtractClaimsOptions): Promise<ClaimsResult> {
  const ts = await loadTypescript();
  const { map, baseDir } = await loadMap(opts.mapPath);

  // Collect all referenced files (resolved against the map file's directory).
  const files = new Set<string>();
  const resolveRef = (ref: TypeRef): { file: string; typeName: string } => {
    const parsed = parseRef(ref);
    const abs = isAbsolute(parsed.file) ? parsed.file : join(baseDir, parsed.file);
    return { file: resolve(abs), typeName: parsed.typeName };
  };
  for (const entry of map.entries) {
    for (const ref of [entry.response, entry.request, entry.query]) {
      if (ref !== undefined) {
        try {
          files.add(resolveRef(ref).file);
        } catch {
          // Recorded as a refusal during translation below.
        }
      }
    }
  }

  const { program, tsconfigPath } = buildProgram(ts, [...files].sort(), baseDir, opts.tsconfig);
  const checker = program.getTypeChecker();

  const refusals: ClaimRefusal[] = [];

  const translateRef = (ref: TypeRef): Shape => {
    const { file, typeName } = resolveRef(ref);
    const source = program.getSourceFile(file);
    if (source === undefined) {
      throw new Refusal(`Source file not found in program: ${file}`);
    }
    const moduleSymbol = checker.getSymbolAtLocation(source);
    if (moduleSymbol === undefined) {
      throw new Refusal(`File has no module exports: ${file}`);
    }
    let symbol = checker
      .getExportsOfModule(moduleSymbol)
      .find((s) => s.getName() === typeName);
    if (symbol === undefined) {
      throw new Refusal(`No exported type "${typeName}" in ${file}.`);
    }
    if (symbol.getFlags() & ts.SymbolFlags.Alias) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    const type = checker.getDeclaredTypeOfSymbol(symbol);
    return typeToShape({ ts, checker, stack: new Set() }, type, 0);
  };

  // Group entries by endpoint identity.
  const byEndpoint = new Map<string, ClaimsMapEntry[]>();
  for (const entry of map.entries) {
    const key = `${entry.method.toUpperCase()} ${entry.pattern}`;
    const list = byEndpoint.get(key) ?? [];
    list.push(entry);
    byEndpoint.set(key, list);
  }

  const endpoints: Endpoint[] = [];
  for (const key of [...byEndpoint.keys()].sort()) {
    const entries = byEndpoint.get(key)!;
    const first = entries[0]!;
    const method = first.method.toUpperCase();
    const pattern = first.pattern;
    const { operationId, typeName } = operationName(method, pattern);

    const claimSlot = (slot: string, ref: TypeRef | undefined): Shape | null => {
      if (ref === undefined) return null;
      try {
        return translateRef(ref);
      } catch (err) {
        if (err instanceof Refusal) {
          refusals.push({ endpoint: key, slot, ref, reason: err.message });
          return null;
        }
        throw err;
      }
    };

    const responses: Endpoint['responses'] = [];
    for (const entry of entries) {
      const status = entry.status ?? 200;
      const bodyShape = claimSlot(`response[${status}]`, entry.response);
      if (entry.response !== undefined && bodyShape === null) continue; // refused
      responses.push({ status, bodyShape, count: 1 });
    }
    responses.sort((x, y) => x.status - y.status);

    const requestBodyShape = claimSlot('request', first.request);
    const queryShape = claimSlot('query', first.query);

    // An endpoint with every slot refused carries no claims — skip it so the
    // diff cannot mistake "refused" for "claims nothing".
    if (responses.length === 0 && requestBodyShape === null && queryShape === null) {
      continue;
    }

    endpoints.push({
      method,
      pattern,
      params: [],
      queryShape,
      requestBodyShape,
      responses:
        responses.length > 0 ? responses : [{ status: 200, bodyShape: null, count: 1 }],
      exchangeIds: [],
      operationId,
      typeName,
    });
  }

  const model: ApiModel = {
    name: 'claims',
    target: 'source-code',
    generatedAt: 0,
    endpoints,
  };

  return { model, notAuditable: refusals, tsconfigPath };
}
