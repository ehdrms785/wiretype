/**
 * wiretype drift — localized Markdown report rendering.
 *
 * A typed message catalog (en/ko) plus `renderMarkdownReport`. Only
 * human-facing strings (title, summary sentence, severity headings, kind
 * labels, table headers, the "no drift" line) are localized; machine fields
 * (endpoint, path, before → after type text) are never translated so reports
 * stay diffable across languages. Rendering is pure and deterministic.
 */

import type { DriftFinding, DriftKind, DriftReport, DriftSeverity } from './types.js';
import { LOW_CONFIDENCE_SAMPLES } from './types.js';

export type ReportLang = 'en' | 'ko';

interface ReportCatalog {
  /** `# <title>` heading. */
  title: string;
  /**
   * Summary sentence template. Placeholders: {aName} {bName} {breaking}
   * {risky} {info} {compared} {onlyInA} {onlyInB}.
   */
  summary: string;
  /** Line printed instead of sections when the report has no findings. */
  noDrift: string;
  /** `## <heading> (n)` section headings per severity. */
  severity: Record<DriftSeverity, string>;
  /** Findings table column headers. */
  columns: { kind: string; endpoint: string; path: string; change: string; samples: string };
  /** Legend printed when any finding is low-confidence. Placeholder: {n}. */
  lowConfidence: string;
  /** Human label per DriftKind. */
  kinds: Record<DriftKind, string>;
}

const CATALOG: Record<ReportLang, ReportCatalog> = {
  en: {
    title: 'wiretype drift report',
    summary:
      'Compared `{aName}` (a) → `{bName}` (b): {breaking} breaking, {risky} risky, ' +
      '{info} info · {compared} endpoints compared, {onlyInA} only in a, {onlyInB} only in b.',
    noDrift: 'No drift detected.',
    severity: { breaking: 'Breaking', risky: 'Risky', info: 'Info' },
    columns: {
      kind: 'Kind',
      endpoint: 'Endpoint',
      path: 'Path',
      change: 'Change',
      samples: 'Samples (b)',
    },
    lowConfidence:
      '⚠ low confidence: backed by fewer than {n} observed samples — ' +
      're-record with more traffic before acting on these findings.',
    kinds: {
      'endpoint-removed': 'endpoint removed',
      'endpoint-added': 'endpoint added',
      'status-removed': 'response status removed',
      'status-added': 'response status added',
      'field-removed': 'field removed',
      'field-added': 'field added',
      'type-changed': 'type changed',
      'nullability-changed': 'nullability changed',
      'optionality-changed': 'optionality changed',
      'enum-values-changed': 'enum values changed',
      'format-changed': 'format changed',
      'request-changed': 'request body changed',
      'query-changed': 'query changed',
      'params-changed': 'path params changed',
    },
  },
  ko: {
    title: 'wiretype 드리프트 리포트',
    summary:
      '`{aName}`(a) → `{bName}`(b) 비교: 호환성 깨짐 {breaking}건, 위험 {risky}건, ' +
      '참고 {info}건 · 비교한 엔드포인트 {compared}개, a에만 {onlyInA}개, b에만 {onlyInB}개.',
    noDrift: '드리프트가 감지되지 않았습니다.',
    severity: { breaking: '호환성 깨짐', risky: '위험', info: '참고' },
    columns: {
      kind: '종류',
      endpoint: '엔드포인트',
      path: '경로',
      change: '변경',
      samples: '샘플 수(b)',
    },
    lowConfidence:
      '⚠ 낮은 신뢰도: 관측 샘플이 {n}개 미만인 판정입니다 — ' +
      '조치 전에 더 많은 트래픽으로 다시 녹화하세요.',
    kinds: {
      'endpoint-removed': '엔드포인트 삭제',
      'endpoint-added': '엔드포인트 추가',
      'status-removed': '응답 상태코드 삭제',
      'status-added': '응답 상태코드 추가',
      'field-removed': '필드 삭제',
      'field-added': '필드 추가',
      'type-changed': '타입 변경',
      'nullability-changed': 'null 허용 여부 변경',
      'optionality-changed': 'optional 여부 변경',
      'enum-values-changed': 'enum 값 변경',
      'format-changed': '포맷 변경',
      'request-changed': '요청 바디 변경',
      'query-changed': '쿼리 변경',
      'params-changed': '경로 파라미터 변경',
    },
  },
};

/** Coerce a user-supplied lang string to a supported ReportLang (fallback: en). */
export function resolveLang(lang: string | undefined): ReportLang {
  return lang === 'ko' ? 'ko' : 'en';
}

/** Absent-side / empty-cell marker. */
const ABSENT = '—';

/** Fill `{placeholder}` slots in a catalog template. */
function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : String(value);
  });
}

/** Escape Markdown table separators and newlines inside a cell. */
function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s+/g, ' ');
}

/** "[status] path" (either part optional), ABSENT when both missing. */
function formatPath(f: DriftFinding): string {
  const parts: string[] = [];
  if (f.status !== undefined) parts.push(`[${f.status}]`);
  if (f.path !== undefined) parts.push(f.path);
  return parts.length > 0 ? parts.join(' ') : ABSENT;
}

/** "before → after" with ABSENT for a missing side. */
function formatChange(f: DriftFinding): string {
  return `${f.before ?? ABSENT} → ${f.after ?? ABSENT}`;
}

/** Observed sample count cell: "12", "2 ⚠" (low confidence), ABSENT. */
function formatSamples(f: DriftFinding): string {
  if (f.bSamples === undefined) return ABSENT;
  return f.bSamples < LOW_CONFIDENCE_SAMPLES ? `${f.bSamples} ⚠` : String(f.bSamples);
}

/**
 * Render a DriftReport as deterministic Markdown: `# <title>`, a summary
 * line, then one `## <severity> (n)` section per non-empty severity with a
 * findings table (Kind | Endpoint | Path | Change). An empty report renders
 * the localized "no drift detected" line instead of sections.
 */
export function renderMarkdownReport(report: DriftReport, lang: ReportLang = 'en'): string {
  const cat = CATALOG[resolveLang(lang)];
  const out: string[] = [];

  out.push(`# ${cat.title}`);
  out.push('');
  out.push(
    fill(cat.summary, {
      aName: report.a.name,
      bName: report.b.name,
      breaking: report.summary.breaking,
      risky: report.summary.risky,
      info: report.summary.info,
      compared: report.summary.endpointsCompared,
      onlyInA: report.summary.endpointsOnlyInA,
      onlyInB: report.summary.endpointsOnlyInB,
    }),
  );

  if (report.findings.length === 0) {
    out.push('');
    out.push(cat.noDrift);
    return `${out.join('\n')}\n`;
  }

  const order: DriftSeverity[] = ['breaking', 'risky', 'info'];
  for (const sev of order) {
    const group = report.findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    out.push('');
    out.push(`## ${cat.severity[sev]} (${group.length})`);
    out.push('');
    out.push(
      `| ${cat.columns.kind} | ${cat.columns.endpoint} | ${cat.columns.path} | ` +
        `${cat.columns.change} | ${cat.columns.samples} |`,
    );
    out.push('| --- | --- | --- | --- | --- |');
    for (const f of group) {
      out.push(
        `| ${escapeCell(cat.kinds[f.kind])} | ${escapeCell(f.endpoint)} | ` +
          `${escapeCell(formatPath(f))} | ${escapeCell(formatChange(f))} | ` +
          `${escapeCell(formatSamples(f))} |`,
      );
    }
  }

  if (report.findings.some((f) => f.bSamples !== undefined && f.bSamples < LOW_CONFIDENCE_SAMPLES)) {
    out.push('');
    out.push(fill(cat.lowConfidence, { n: LOW_CONFIDENCE_SAMPLES }));
  }

  return `${out.join('\n')}\n`;
}
