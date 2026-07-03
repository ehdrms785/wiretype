import { describe, it, expect } from 'vitest';
import type { DriftReport } from './types.js';
import type { ReportLang } from './index.js';
import { renderMarkdownReport, resolveLang } from './index.js';

/** Handcrafted report covering all three severities + pipe-bearing type text. */
const report: DriftReport = {
  a: { name: 'v1', target: 'http://localhost:8080', generatedAt: 0, endpointCount: 2 },
  b: { name: 'v2', target: 'http://localhost:8080', generatedAt: 0, endpointCount: 2 },
  findings: [
    {
      severity: 'breaking',
      kind: 'field-removed',
      endpoint: 'GET /api/items/:itemId',
      status: 200,
      path: 'name',
      before: 'string',
      message: 'Field "name" was removed in b.',
    },
    {
      severity: 'risky',
      kind: 'enum-values-changed',
      endpoint: 'GET /api/items/:itemId',
      status: 200,
      path: 'status',
      before: '"active" | "archived"',
      after: '"active" | "archived" | "draft"',
      message: 'Enum values added in b: draft.',
    },
    {
      severity: 'info',
      kind: 'endpoint-added',
      endpoint: 'POST /api/items',
      message: 'Endpoint POST /api/items was added (absent in a, present in b).',
    },
  ],
  summary: {
    breaking: 1,
    risky: 1,
    info: 1,
    endpointsCompared: 1,
    endpointsOnlyInA: 0,
    endpointsOnlyInB: 1,
  },
};

const emptyReport: DriftReport = {
  ...report,
  findings: [],
  summary: {
    breaking: 0,
    risky: 0,
    info: 0,
    endpointsCompared: 2,
    endpointsOnlyInA: 0,
    endpointsOnlyInB: 0,
  },
};

describe('resolveLang', () => {
  it('accepts en and ko, falls back to en for anything else', () => {
    expect(resolveLang('en')).toBe('en');
    expect(resolveLang('ko')).toBe('ko');
    expect(resolveLang('fr')).toBe('en');
    expect(resolveLang('')).toBe('en');
    expect(resolveLang(undefined)).toBe('en');
  });
});

describe('renderMarkdownReport (en)', () => {
  const out = renderMarkdownReport(report, 'en');

  it('renders title, summary counts, severity headings, column headers', () => {
    expect(out).toContain('# wiretype drift report');
    expect(out).toContain('Compared `v1` (a) → `v2` (b): 1 breaking, 1 risky, 1 info');
    expect(out).toContain('## Breaking (1)');
    expect(out).toContain('## Risky (1)');
    expect(out).toContain('## Info (1)');
    expect(out).toContain('| Kind | Endpoint | Path | Change |');
  });

  it('renders localized kind labels', () => {
    expect(out).toContain('field removed');
    expect(out).toContain('enum values changed');
    expect(out).toContain('endpoint added');
  });

  it('uses — for absent change sides and [status] path cells', () => {
    expect(out).toContain('[200] name');
    expect(out).toContain('string → —');
  });

  it('escapes pipe characters inside cell values', () => {
    expect(out).toContain('"active" \\| "archived" → "active" \\| "archived" \\| "draft"');
  });

  it('defaults to en and falls back to en on unknown lang', () => {
    expect(renderMarkdownReport(report)).toBe(out);
    expect(renderMarkdownReport(report, 'fr' as ReportLang)).toBe(out);
  });

  it('is deterministic', () => {
    expect(renderMarkdownReport(report, 'en')).toBe(renderMarkdownReport(report, 'en'));
  });
});

describe('renderMarkdownReport (ko)', () => {
  const en = renderMarkdownReport(report, 'en');
  const ko = renderMarkdownReport(report, 'ko');

  it('localizes title, summary, severity headings, column headers, kind labels', () => {
    expect(ko).toContain('# wiretype 드리프트 리포트');
    expect(ko).toContain('호환성 깨짐 1건, 위험 1건, 참고 1건');
    expect(ko).toContain('## 호환성 깨짐 (1)');
    expect(ko).toContain('## 위험 (1)');
    expect(ko).toContain('## 참고 (1)');
    expect(ko).toContain('| 종류 | 엔드포인트 | 경로 | 변경 |');
    expect(ko).toContain('필드 삭제');
    expect(ko).toContain('enum 값 변경');
    expect(ko).toContain('엔드포인트 추가');
  });

  it('keeps machine fields identical across languages', () => {
    for (const machine of [
      'GET /api/items/:itemId',
      'POST /api/items',
      '[200] name',
      'string → —',
      '"active" \\| "archived" → "active" \\| "archived" \\| "draft"',
    ]) {
      expect(en).toContain(machine);
      expect(ko).toContain(machine);
    }
  });

  it('is deterministic', () => {
    expect(renderMarkdownReport(report, 'ko')).toBe(ko);
  });
});

describe('renderMarkdownReport (empty report)', () => {
  it('renders the localized "no drift detected" line and no tables', () => {
    const en = renderMarkdownReport(emptyReport, 'en');
    const ko = renderMarkdownReport(emptyReport, 'ko');
    expect(en).toContain('No drift detected.');
    expect(ko).toContain('드리프트가 감지되지 않았습니다.');
    expect(en).not.toContain('##');
    expect(ko).not.toContain('##');
  });
});
