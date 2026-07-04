/**
 * wiretype core — shared type contract.
 *
 * Every module depends on the shapes in this file. Treat this as the single
 * source of truth: do NOT change signatures without updating
 * docs/ARCHITECTURE.md and all consumers.
 */

/* ------------------------------------------------------------------ */
/* JSON                                                                */
/* ------------------------------------------------------------------ */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/* ------------------------------------------------------------------ */
/* Captured traffic                                                    */
/* ------------------------------------------------------------------ */

export interface CapturedRequest {
  /** Uppercase HTTP method, e.g. "GET". */
  method: string;
  /** Full original URL as received by the proxy (path + query). */
  url: string;
  /** Pathname only, e.g. "/api/users/42". */
  path: string;
  /** Parsed query string. Multiple values per key preserved. */
  query: Record<string, string[]>;
  /** Selected request headers (lowercased keys). Sensitive headers redacted. */
  headers: Record<string, string>;
  /** Raw body text, if any (truncated at maxBodyBytes). */
  bodyText?: string;
  /** Parsed JSON body when content-type is JSON and parsing succeeds. */
  bodyJson?: JsonValue;
}

export interface CapturedResponse {
  status: number;
  /** Selected response headers (lowercased keys). */
  headers: Record<string, string>;
  bodyText?: string;
  bodyJson?: JsonValue;
  /** Milliseconds from request start to response end. */
  durationMs: number;
}

export interface Exchange {
  /** Unique id (e.g. crypto.randomUUID()). */
  id: string;
  /** Epoch ms when the request started. */
  startedAt: number;
  request: CapturedRequest;
  response: CapturedResponse;
}

export interface RecordingMeta {
  /** Recording name (directory-safe). */
  name: string;
  /** Upstream target base URL, e.g. "http://localhost:8080". */
  target: string;
  createdAt: number;
  updatedAt: number;
  exchangeCount: number;
}

export interface Recording {
  meta: RecordingMeta;
  exchanges: Exchange[];
}

/* ------------------------------------------------------------------ */
/* Shape AST (inferred structure of JSON values)                       */
/* ------------------------------------------------------------------ */

export type StringFormat = 'uuid' | 'date-time' | 'date' | 'email' | 'uri';

export interface PrimitiveShape {
  kind: 'primitive';
  type: 'string' | 'number' | 'integer' | 'boolean';
  /**
   * Detected string formats. Only present for type === 'string' and only
   * when EVERY observed sample matched the format.
   */
  formats?: StringFormat[];
  /**
   * Closed set of observed literal values. Inferred by buildApiModel only
   * for token-like strings (e.g. "admin", "in_progress") when samples >= 4,
   * distinct values <= 8, and values actually repeat
   * (distinct <= ceil(samples / 2)). The (string | number)[] type is kept so
   * emitters also support numeric enums supplied by hand-built models.
   */
  enum?: (string | number)[];
}

export interface NullShape {
  kind: 'null';
}

export interface FieldShape {
  shape: Shape;
  /** True when the field was absent in at least one merged object sample. */
  optional: boolean;
  /**
   * Number of merged object samples in which this key was PRESENT.
   * Populated by inferShape (1) and summed by mergeShapes. Together with
   * ObjectShape.samples this lets consumers judge how much evidence backs an
   * optionality/type inference. Ignored by shapesEqual.
   */
  seen?: number;
}

export interface ObjectShape {
  kind: 'object';
  fields: Record<string, FieldShape>;
  /**
   * Number of object samples merged into this shape (array elements count
   * individually). Ignored by shapesEqual. Absent on hand-built shapes.
   */
  samples?: number;
}

/** Dictionary-like object: many keys, homogeneous values. */
export interface RecordShape {
  kind: 'record';
  value: Shape;
}

export interface ArrayShape {
  kind: 'array';
  /** null = array observed but never with elements (unknown element type). */
  element: Shape | null;
}

export interface UnionShape {
  kind: 'union';
  /**
   * Flattened variants — never contains a nested union. Deduplicated via
   * shapesEqual. A NullShape variant expresses nullability.
   */
  variants: Shape[];
}

export interface UnknownShape {
  kind: 'unknown';
}

export type Shape =
  | PrimitiveShape
  | NullShape
  | ObjectShape
  | RecordShape
  | ArrayShape
  | UnionShape
  | UnknownShape;

/* ------------------------------------------------------------------ */
/* Endpoint model (grouped + inferred)                                 */
/* ------------------------------------------------------------------ */

export interface PathParam {
  /** Param name, e.g. "userId". */
  name: string;
  /** Zero-based segment index within the path. */
  index: number;
  /** Detected sample format. */
  format: 'integer' | 'uuid' | 'string';
  /** Distinct observed raw values (capped at 10). */
  samples: string[];
}

/** One response variant per distinct HTTP status. */
export interface EndpointResponse {
  status: number;
  /** Merged shape of all JSON bodies observed for this status. null = no/non-JSON body. */
  bodyShape: Shape | null;
  /** Most recent JSON body sample (used as MSW mock data). */
  sampleBody?: JsonValue;
  /** Dominant content-type. */
  contentType?: string;
  /** Number of exchanges observed with this status. */
  count: number;
}

export interface Endpoint {
  /** Uppercase method. */
  method: string;
  /** Normalized express-style pattern, e.g. "/api/users/:userId". */
  pattern: string;
  params: PathParam[];
  /**
   * Shape of query params as an object (values inferred from strings:
   * "42" -> integer, "true" -> boolean, otherwise string).
   * null when no query params were ever observed.
   */
  queryShape: Shape | null;
  /** Merged shape of JSON request bodies. null when none observed. */
  requestBodyShape: Shape | null;
  /** Most recent JSON request body sample. */
  requestSample?: JsonValue;
  /** Response variants sorted by ascending status. Always >= 1 entry. */
  responses: EndpointResponse[];
  /** Ids of the exchanges that back this endpoint. */
  exchangeIds: string[];
  /**
   * camelCase operation id derived from method + pattern.
   * e.g. GET /api/users/:userId -> "getApiUsersByUserId"
   */
  operationId: string;
  /**
   * PascalCase base name for generated types.
   * e.g. "GetApiUsersByUserId" (suffixes like Response/Request/Query/Params
   * are appended by codegen).
   */
  typeName: string;
}

export interface ApiModel {
  /** Recording name. */
  name: string;
  /** Upstream target base URL. */
  target: string;
  generatedAt: number;
  /** Sorted by pattern, then method. */
  endpoints: Endpoint[];
}

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

export interface BuildModelOptions {
  /**
   * Extra path segments to always treat as parameters, by exact segment
   * value. Rarely needed — numeric/uuid segments are auto-detected.
   */
  forceParamSegments?: string[];
  /** Enum detection: max distinct values (default 8). */
  enumMaxValues?: number;
  /** Enum detection: min samples before enabling (default 4). */
  enumMinSamples?: number;
  /** Record detection: min distinct keys with homogeneous values (default 12). */
  recordMinKeys?: number;
}

export interface RecorderOptions {
  /** Only record requests whose path matches one of these prefixes. Default: all. */
  includePrefixes?: string[];
  /** Skip requests whose path matches one of these prefixes. */
  excludePrefixes?: string[];
  /** Max captured body size in bytes (default 1 MiB). Larger bodies are truncated and not JSON-parsed. */
  maxBodyBytes?: number;
  /** Header names to redact (default: authorization, cookie, set-cookie, x-api-key). */
  redactHeaders?: string[];
}
