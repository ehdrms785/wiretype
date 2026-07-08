import { describe, expect, it } from 'vitest';
import { buildApiModel } from './index.js';
import type { JsonValue, ObjectShape, Recording, Shape } from './index.js';

/** Build a recording of GET /api/things responses with the given bodies. */
function recordingOf(bodies: JsonValue[]): Recording {
  return {
    meta: {
      name: 't',
      target: 'http://x',
      createdAt: 0,
      updatedAt: 0,
      exchangeCount: bodies.length,
    },
    exchanges: bodies.map((body, i) => ({
      id: String(i),
      startedAt: i,
      request: { method: 'GET', url: '/api/things', path: '/api/things', query: {}, headers: {} },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        bodyJson: body,
        bodyText: JSON.stringify(body),
        durationMs: 1,
      },
    })),
  };
}

function fieldShape(model: ReturnType<typeof buildApiModel>, name: string): Shape {
  const body = model.endpoints[0]!.responses[0]!.bodyShape as ObjectShape;
  return body.fields[name]!.shape;
}

describe('enum detection — vocabulary vs numeric data (wild case 2026-07-08)', () => {
  it('never freezes numeric data strings into an enum ("Bad" | "30" | ... → string)', () => {
    // Real-world case: alarm stateValue arrives as numeric strings + one word.
    // "30"/"20"/"10"/"5" are thresholds (data), not a closed vocabulary.
    const bodies = ['30', '20', '10', '5', 'Bad', '30', '20', '10'].map((v) => ({
      stateValue: v,
    }));
    const model = buildApiModel(recordingOf(bodies));
    expect(fieldShape(model, 'stateValue')).toEqual({ kind: 'primitive', type: 'string' });
  });

  it('rejects pure numeric-string sets too ("1" | "0" → string)', () => {
    const bodies = ['1', '0', '1', '0', '1', '0'].map((v) => ({ flag: v }));
    const model = buildApiModel(recordingOf(bodies));
    expect(fieldShape(model, 'flag')).toEqual({ kind: 'primitive', type: 'string' });
  });

  it('keeps leading-zero code systems as enums ("050015" fails numeric round-trip)', () => {
    const bodies = ['050015', '050020', '050015', '050021', '050020', '050015'].map((v) => ({
      intervalType: v,
    }));
    const model = buildApiModel(recordingOf(bodies));
    const shape = fieldShape(model, 'intervalType') as Extract<Shape, { kind: 'primitive' }>;
    expect(shape.enum).toEqual(['050015', '050020', '050021']);
  });

  it('keeps word-like vocabularies as enums (TEMPLATE_* codes)', () => {
    const bodies = [
      'TEMPLATE_REPORT',
      'TEMPLATE_EVENT',
      'TEMPLATE_REPORT',
      'TEMPLATE_ALARM',
      'TEMPLATE_EVENT',
      'TEMPLATE_REPORT',
    ].map((v) => ({ templateId: v }));
    const model = buildApiModel(recordingOf(bodies));
    const shape = fieldShape(model, 'templateId') as Extract<Shape, { kind: 'primitive' }>;
    expect(shape.enum).toEqual(['TEMPLATE_REPORT', 'TEMPLATE_EVENT', 'TEMPLATE_ALARM']);
  });
});

describe('buildApiModel preserves sample counts through normalization', () => {
  it('keeps ObjectShape.samples and FieldShape.seen after enum/record walks', () => {
    const bodies: JsonValue[] = [
      { id: 'a', extra: true },
      { id: 'b' },
      { id: 'c' },
    ];
    const model = buildApiModel(recordingOf(bodies));
    const body = model.endpoints[0]!.responses[0]!.bodyShape as ObjectShape;
    expect(body.samples).toBe(3);
    expect(body.fields.id?.seen).toBe(3);
    expect(body.fields.extra?.seen).toBe(1);
    expect(body.fields.extra?.optional).toBe(true);
  });
});
