/**
 * wiretype claims — deterministic extraction of "what the code believes".
 *
 * The agent/human writes a claims MAP binding endpoints to exported type
 * references; this module translates those TypeScript types into wiretype
 * Shapes via the TypeScript compiler API. No LLM in the loop: given the same
 * source and map, the output is byte-identical.
 *
 * Honesty rule: anything that cannot be translated faithfully is REFUSED
 * (listed in `notAuditable`), never guessed. Generic wrappers can be claimed
 * by adding a small exported alias in a shim file, e.g.
 * `export type UserDetailClaim = ApiResponse<UserDetail>;` — the shim is
 * code, so it stays reviewable and deterministic.
 */

import type { ApiModel } from '../core/index.js';

/** "src/apis/user/types.ts#UserDetail" — file path + exported type name. */
export type TypeRef = string;

export interface ClaimsMapEntry {
  /** HTTP method, any case. */
  method: string;
  /** Endpoint pattern EXACTLY as it appears in the observed model, e.g. "/api/users/:userId". */
  pattern: string;
  /** HTTP status the response type claims. Default 200. */
  status?: number;
  /** Response body type reference. */
  response?: TypeRef;
  /** Request body type reference. */
  request?: TypeRef;
  /** Query params type reference. */
  query?: TypeRef;
}

export interface ClaimsMap {
  entries: ClaimsMapEntry[];
}

export interface ClaimRefusal {
  /** Endpoint identity, e.g. "GET /api/users/:userId". */
  endpoint: string;
  /** Which slot was refused: response[status] / request / query. */
  slot: string;
  /** The type reference that could not be translated. */
  ref: TypeRef;
  /** Deterministic human-readable reason. */
  reason: string;
}

/** Output of claims extraction: a partial ApiModel plus the refusals. */
export interface ClaimsResult {
  model: ApiModel;
  notAuditable: ClaimRefusal[];
  /**
   * The tsconfig the compiler options came from (solution-style configs are
   * resolved to the referenced project). null = built-in defaults.
   * strictNullChecks is ALWAYS forced on regardless of this file.
   */
  tsconfigPath: string | null;
}

export interface ExtractClaimsOptions {
  /** Absolute or cwd-relative path to the claims map JSON file. */
  mapPath: string;
  /** Explicit tsconfig path. Default: nearest tsconfig.json from the map file's directory. */
  tsconfig?: string;
}
