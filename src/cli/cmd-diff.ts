import { readFile } from 'node:fs/promises';
import { RecordingStore, buildApiModel } from '../core/index.js';
import type { ApiModel } from '../core/index.js';
import { diffModels, renderMarkdownReport, resolveLang } from '../drift/index.js';
import type { DriftFinding, DriftReport, DriftSeverity } from '../drift/index.js';
import { renderTable } from './util.js';

export interface DiffOptions {
  a: string;
  b: string;
  dir: string;
  json?: boolean;
  md?: boolean;
  lang?: string;
  failOn?: string;
  ignoreUnmatched?: boolean;
}

const SEVERITY_RANK: Record<DriftSeverity, number> = {
  breaking: 3,
  risky: 2,
  info: 1,
};

function isSeverity(value: string): value is DriftSeverity {
  return value === 'breaking' || value === 'risky' || value === 'info';
}

/** Resolve an <a>/<b> argument to an ApiModel: existing file → parse JSON; else recording name. */
async function resolveModel(arg: string, dir: string): Promise<ApiModel> {
  // Try to read as a file first.
  let raw: string | null = null;
  try {
    raw = await readFile(arg, 'utf8');
  } catch {
    raw = null;
  }

  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse "${arg}" as JSON: ${message}`);
    }
    if (!isApiModelLike(parsed)) {
      throw new Error(
        `File "${arg}" is not a valid ApiModel (expected an object with an "endpoints" array).`,
      );
    }
    return parsed;
  }

  // Fall back to treating it as a recording name in --dir.
  const store = new RecordingStore(dir);
  let recording;
  try {
    recording = await store.load(arg);
  } catch {
    throw new Error(
      `Could not resolve "${arg}": not a readable file and not a recording in ${dir}.`,
    );
  }
  return buildApiModel(recording);
}

function isApiModelLike(value: unknown): value is ApiModel {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj.endpoints);
}

export async function runDiff(opts: DiffOptions): Promise<void> {
  // Validate --fail-on early.
  if (opts.failOn !== undefined && !isSeverity(opts.failOn)) {
    throw new Error(
      `Invalid --fail-on "${opts.failOn}". Valid levels: breaking, risky, info.`,
    );
  }

  const modelA = await resolveModel(opts.a, opts.dir);
  const modelB = await resolveModel(opts.b, opts.dir);

  const report = diffModels(modelA, modelB, {
    ignoreUnmatchedEndpoints: opts.ignoreUnmatched ?? false,
  });

  // --json wins over --md; JSON output is never localized.
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (opts.md) {
    // Unknown --lang values fall back to en without an error.
    process.stdout.write(renderMarkdownReport(report, resolveLang(opts.lang)));
  } else {
    process.stdout.write(renderHuman(report));
  }

  // Exit code: --fail-on flips exit code 1 when a finding at that level or higher exists.
  if (opts.failOn !== undefined && isSeverity(opts.failOn)) {
    const threshold = SEVERITY_RANK[opts.failOn];
    const hit = report.findings.some((f) => SEVERITY_RANK[f.severity] >= threshold);
    process.exitCode = hit ? 1 : 0;
  }
}

function renderHuman(report: DriftReport): string {
  const out: string[] = [];

  out.push(
    `wiretype diff — a: ${report.a.name} (${report.a.endpointCount} endpoints) ` +
      `vs b: ${report.b.name} (${report.b.endpointCount} endpoints)`,
  );
  out.push(
    `  ${report.summary.breaking} breaking, ${report.summary.risky} risky, ` +
      `${report.summary.info} info · ` +
      `${report.summary.endpointsCompared} compared, ` +
      `${report.summary.endpointsOnlyInA} only-in-a, ` +
      `${report.summary.endpointsOnlyInB} only-in-b`,
  );

  if (report.findings.length === 0) {
    out.push('');
    out.push('no drift detected.');
    return `${out.join('\n')}\n`;
  }

  // Grouped by severity in the fixed order (findings already sorted).
  const order: DriftSeverity[] = ['breaking', 'risky', 'info'];
  for (const sev of order) {
    const group = report.findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    out.push('');
    out.push(`${sev.toUpperCase()} (${group.length})`);
    out.push(renderFindingsTable(group));
  }

  return `${out.join('\n')}\n`;
}

function renderFindingsTable(findings: DriftFinding[]): string {
  return renderTable([
    { header: 'SEVERITY', values: findings.map((f) => f.severity) },
    { header: 'KIND', values: findings.map((f) => f.kind) },
    { header: 'ENDPOINT', values: findings.map((f) => f.endpoint) },
    { header: 'PATH', values: findings.map((f) => formatPath(f)) },
    { header: 'CHANGE', values: findings.map((f) => formatChange(f)) },
  ]);
}

function formatPath(f: DriftFinding): string {
  const parts: string[] = [];
  if (f.status !== undefined) parts.push(`[${f.status}]`);
  if (f.path !== undefined) parts.push(f.path);
  return parts.join(' ');
}

function formatChange(f: DriftFinding): string {
  const before = f.before ?? '-';
  const after = f.after ?? '-';
  const text = `${before} → ${after}`;
  return truncate(text.replace(/\s+/g, ' '), 60);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}
