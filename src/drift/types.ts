/**
 * wiretype drift — deterministic schema drift detection.
 *
 * Compares two ApiModels ("a" → "b") and reports findings. Semantics:
 * "a" is what consumers currently believe/depend on (an older recording,
 * a committed baseline, or a claims model extracted from source code);
 * "b" is the newly observed reality. A finding is BREAKING when code
 * written against "a" can break when the API behaves like "b".
 *
 * This module is pure and deterministic — no LLM judgment anywhere.
 * Fuzzy work (finding call sites, translating hand-written types into a
 * claims ApiModel) belongs to agents/tooling ABOVE this layer; they feed
 * claims in and receive verdicts out.
 */

export type DriftSeverity = 'breaking' | 'risky' | 'info';

export type DriftKind =
  | 'endpoint-removed'
  | 'endpoint-added'
  | 'status-removed'
  | 'status-added'
  | 'field-removed'
  | 'field-added'
  | 'type-changed'
  | 'nullability-changed'
  | 'optionality-changed'
  | 'enum-values-changed'
  | 'format-changed'
  | 'request-changed'
  | 'query-changed'
  | 'params-changed';

export interface DriftFinding {
  severity: DriftSeverity;
  kind: DriftKind;
  /** "GET /api/users/:userId" */
  endpoint: string;
  /** HTTP status the finding applies to (response findings only). */
  status?: number;
  /**
   * JSON path into the body shape, e.g. "items[].role" or "author.name".
   * Omitted for endpoint/status-level findings.
   */
  path?: string;
  /** Rendered TS-ish type text before (side a). */
  before?: string;
  /** Rendered TS-ish type text after (side b). */
  after?: string;
  /** One human-readable sentence. */
  message: string;
}

export interface DriftSideInfo {
  name: string;
  target: string;
  generatedAt: number;
  endpointCount: number;
}

export interface DriftReport {
  a: DriftSideInfo;
  b: DriftSideInfo;
  /** Sorted: breaking first, then risky, then info; stable within groups. */
  findings: DriftFinding[];
  summary: {
    breaking: number;
    risky: number;
    info: number;
    /** Endpoints present on both sides (method+pattern match). */
    endpointsCompared: number;
    endpointsOnlyInA: number;
    endpointsOnlyInB: number;
  };
}

export interface DiffOptions {
  /**
   * Ignore endpoints only present on one side (default false). Useful when
   * comparing a partial claims model against a full observed model — claims
   * usually cover a subset, so endpoint-added noise is unwanted.
   */
  ignoreUnmatchedEndpoints?: boolean;
}
