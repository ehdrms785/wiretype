import { describe, expect, it } from 'vitest';
import type { ApiModel, Shape } from '../core/index.js';
import { diffModels } from './diff.js';
import { renderMarkdownReport } from './i18n.js';

function model(name: string, bodyShape: Shape, count: number): ApiModel {
  return {
    name,
    target: 'http://test',
    generatedAt: 0,
    endpoints: [
      {
        method: 'GET',
        pattern: '/api/things/:thingId',
        params: [],
        queryShape: null,
        requestBodyShape: null,
        responses: [{ status: 200, bodyShape, count }],
        exchangeIds: [],
        operationId: 'getApiThingsByThingId',
        typeName: 'GetApiThingsByThingId',
      },
    ],
  };
}

const claims: Shape = {
  kind: 'object',
  fields: {
    id: { shape: { kind: 'primitive', type: 'string' }, optional: false },
    name: { shape: { kind: 'primitive', type: 'string' }, optional: false },
  },
};

describe('drift confidence (bSamples)', () => {
  it('attaches observed sample counts to field findings', () => {
    const observed: Shape = {
      kind: 'object',
      samples: 12,
      fields: {
        id: { shape: { kind: 'primitive', type: 'string' }, optional: false, seen: 12 },
        // "name" missing on the wire → field-removed, evidence = 12 samples
        extra: { shape: { kind: 'primitive', type: 'boolean' }, optional: true, seen: 2 },
      },
    };
    const report = diffModels(model('claims', claims, 12), model('wire', observed, 12));

    const removed = report.findings.find((f) => f.kind === 'field-removed');
    expect(removed?.bSamples).toBe(12);

    // field-added evidence is the field's own presence count.
    const added = report.findings.find((f) => f.kind === 'field-added');
    expect(added?.bSamples).toBe(2);
  });

  it('marks low-confidence findings in the markdown report (both langs)', () => {
    const observed: Shape = {
      kind: 'object',
      samples: 2,
      fields: {
        id: { shape: { kind: 'primitive', type: 'string' }, optional: false, seen: 2 },
        name: { shape: { kind: 'primitive', type: 'string' }, optional: true, seen: 1 },
      },
    };
    const report = diffModels(model('claims', claims, 2), model('wire', observed, 2));
    const opt = report.findings.find((f) => f.kind === 'optionality-changed');
    expect(opt?.bSamples).toBe(2);

    const en = renderMarkdownReport(report, 'en');
    expect(en).toContain('2 ⚠');
    expect(en).toContain('low confidence');
    const ko = renderMarkdownReport(report, 'ko');
    expect(ko).toContain('낮은 신뢰도');
  });

  it('omits bSamples when the observed model has no counts', () => {
    const observed: Shape = {
      kind: 'object',
      fields: {
        id: { shape: { kind: 'primitive', type: 'integer' }, optional: false },
        name: { shape: { kind: 'primitive', type: 'string' }, optional: false },
      },
    };
    // count still exists at response level, so root-level bSeen exists, but
    // the uncounted object resets nothing — field findings inherit response
    // count. Verify it does NOT invent counts below uncounted objects other
    // than the inherited response count.
    const report = diffModels(model('claims', claims, 5), model('wire', observed, 5));
    const typeChanged = report.findings.find((f) => f.kind === 'type-changed');
    expect(typeChanged?.bSamples).toBe(5); // inherited from response count
  });
});
