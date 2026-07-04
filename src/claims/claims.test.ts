import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ObjectShape, Shape, UnionShape } from '../core/index.js';
import { extractClaims } from './extract.js';

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function setup(files: Record<string, string>): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'wtclaims-'));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, 'utf8');
  }
  return dir;
}

const USER_TYPES = `
export interface UserDetail {
  id: string;
  name: string;
  role: 'admin' | 'editor' | 'viewer';
  score: number;
  active: boolean;
  lastLoginAt: string | null;
  avatarUrl?: string;
  tags: string[];
  address: { city: string; zip: string };
  meta: Record<string, number>;
}

export interface CreateUserBody {
  name: string;
  email: string;
  role?: 'admin' | 'editor' | 'viewer';
}

export interface UserQuery {
  page: number;
  limit?: number;
}

export interface NotFound {
  error: string;
  code: string;
}
`;

function mapJson(entries: unknown[]): string {
  return JSON.stringify({ entries }, null, 2);
}

describe('extractClaims — happy path', () => {
  it('translates interfaces into shapes (optional, nullable, enum, array, nested, record)', async () => {
    const base = await setup({
      'types.ts': USER_TYPES,
      'claims.map.json': mapJson([
        {
          method: 'get',
          pattern: '/api/users/:userId',
          response: 'types.ts#UserDetail',
        },
        {
          method: 'get',
          pattern: '/api/users/:userId',
          status: 404,
          response: 'types.ts#NotFound',
        },
        {
          method: 'POST',
          pattern: '/api/users',
          status: 201,
          response: 'types.ts#UserDetail',
          request: 'types.ts#CreateUserBody',
          query: 'types.ts#UserQuery',
        },
      ]),
    });

    const { model, notAuditable } = await extractClaims({
      mapPath: join(base, 'claims.map.json'),
    });

    expect(notAuditable).toEqual([]);
    expect(model.endpoints).toHaveLength(2);
    expect(model.generatedAt).toBe(0);

    const getUser = model.endpoints.find((e) => e.pattern === '/api/users/:userId')!;
    expect(getUser.method).toBe('GET');
    expect(getUser.responses.map((r) => r.status)).toEqual([200, 404]);

    const body = getUser.responses[0]!.bodyShape as ObjectShape;
    expect(body.kind).toBe('object');
    expect(body.fields.id?.shape).toEqual({ kind: 'primitive', type: 'string' });
    expect(body.fields.role?.shape).toEqual({
      kind: 'primitive',
      type: 'string',
      enum: ['admin', 'editor', 'viewer'],
    });
    expect(body.fields.score?.shape).toEqual({ kind: 'primitive', type: 'number' });
    expect(body.fields.avatarUrl?.optional).toBe(true);
    expect(body.fields.lastLoginAt?.shape.kind).toBe('union');
    const nullable = body.fields.lastLoginAt?.shape as UnionShape;
    expect(nullable.variants).toContainEqual({ kind: 'null' });
    expect(body.fields.tags?.shape).toEqual({
      kind: 'array',
      element: { kind: 'primitive', type: 'string' },
    });
    expect(body.fields.address?.shape.kind).toBe('object');
    expect(body.fields.meta?.shape).toEqual({
      kind: 'record',
      value: { kind: 'primitive', type: 'number' },
    });

    const post = model.endpoints.find((e) => e.pattern === '/api/users')!;
    expect((post.requestBodyShape as ObjectShape).fields.role?.optional).toBe(true);
    expect((post.queryShape as ObjectShape).fields.limit?.optional).toBe(true);
  });

  it('resolves generic instantiations through an exported shim alias', async () => {
    const base = await setup({
      'types.ts': `
        export interface Wrapper<T> { data: T; ok: boolean; }
        export interface Item { id: number; label: string; }
        export type ItemResponseClaim = Wrapper<Item>;
      `,
      'claims.map.json': mapJson([
        { method: 'GET', pattern: '/api/items/:itemId', response: 'types.ts#ItemResponseClaim' },
      ]),
    });

    const { model, notAuditable } = await extractClaims({
      mapPath: join(base, 'claims.map.json'),
    });
    expect(notAuditable).toEqual([]);
    const body = model.endpoints[0]!.responses[0]!.bodyShape as ObjectShape;
    expect(body.fields.ok?.shape).toEqual({ kind: 'primitive', type: 'boolean' });
    expect((body.fields.data?.shape as ObjectShape).fields.id?.shape).toEqual({
      kind: 'primitive',
      type: 'number',
    });
  });

  it('maps any/unknown to the unknown shape (an honest non-claim)', async () => {
    const base = await setup({
      'types.ts': `export interface Loose { blob: any; extra: unknown; }`,
      'claims.map.json': mapJson([
        { method: 'GET', pattern: '/api/loose', response: 'types.ts#Loose' },
      ]),
    });
    const { model, notAuditable } = await extractClaims({
      mapPath: join(base, 'claims.map.json'),
    });
    expect(notAuditable).toEqual([]);
    const body = model.endpoints[0]!.responses[0]!.bodyShape as ObjectShape;
    expect(body.fields.blob?.shape).toEqual({ kind: 'unknown' });
    expect(body.fields.extra?.shape).toEqual({ kind: 'unknown' });
  });

  it('is deterministic — two runs produce deep-equal results', async () => {
    const base = await setup({
      'types.ts': USER_TYPES,
      'claims.map.json': mapJson([
        { method: 'GET', pattern: '/api/users/:userId', response: 'types.ts#UserDetail' },
      ]),
    });
    const first = await extractClaims({ mapPath: join(base, 'claims.map.json') });
    const second = await extractClaims({ mapPath: join(base, 'claims.map.json') });
    expect(second).toEqual(first);
  });
});

describe('extractClaims — refusals (never guess)', () => {
  it('refuses Date, functions, unresolved generics, and missing exports', async () => {
    const base = await setup({
      'types.ts': `
        export interface HasDate { createdAt: Date; }
        export interface HasFn { onClick: () => void; }
        export interface Generic<T> { data: T; }
      `,
      'claims.map.json': mapJson([
        { method: 'GET', pattern: '/api/a', response: 'types.ts#HasDate' },
        { method: 'GET', pattern: '/api/b', response: 'types.ts#HasFn' },
        { method: 'GET', pattern: '/api/c', response: 'types.ts#Generic' },
        { method: 'GET', pattern: '/api/d', response: 'types.ts#Nope' },
      ]),
    });

    const { model, notAuditable } = await extractClaims({
      mapPath: join(base, 'claims.map.json'),
    });

    expect(model.endpoints).toEqual([]); // every endpoint fully refused
    expect(notAuditable).toHaveLength(4);
    const reasons = notAuditable.map((r) => r.reason).join('\n');
    expect(reasons).toMatch(/Date is not a JSON type/);
    expect(reasons).toMatch(/Function types/);
    expect(reasons).toMatch(/type parameter/i);
    expect(reasons).toMatch(/No exported type "Nope"/);
  });

  it('keeps auditable slots when only one slot is refused', async () => {
    const base = await setup({
      'types.ts': `
        export interface Good { id: string; }
        export interface Bad { when: Date; }
      `,
      'claims.map.json': mapJson([
        {
          method: 'POST',
          pattern: '/api/mixed',
          response: 'types.ts#Good',
          request: 'types.ts#Bad',
        },
      ]),
    });
    const { model, notAuditable } = await extractClaims({
      mapPath: join(base, 'claims.map.json'),
    });
    expect(model.endpoints).toHaveLength(1);
    expect(model.endpoints[0]!.responses[0]!.bodyShape).not.toBeNull();
    expect(model.endpoints[0]!.requestBodyShape).toBeNull();
    expect(notAuditable).toHaveLength(1);
    expect(notAuditable[0]!.slot).toBe('request');
  });

  it('refuses recursive types', async () => {
    const base = await setup({
      'types.ts': `export interface Node { value: string; children: Node[]; }`,
      'claims.map.json': mapJson([
        { method: 'GET', pattern: '/api/tree', response: 'types.ts#Node' },
      ]),
    });
    const { model, notAuditable } = await extractClaims({
      mapPath: join(base, 'claims.map.json'),
    });
    expect(model.endpoints).toEqual([]);
    expect(notAuditable[0]!.reason).toMatch(/Recursive type/);
  });
});

describe('extractClaims → diff interop', () => {
  it('claims model diffs cleanly against an observed model', async () => {
    const base = await setup({
      'types.ts': `
        export interface Thing {
          id: string;
          when: string;
          count: number;
        }
      `,
      'claims.map.json': mapJson([
        { method: 'GET', pattern: '/api/things/:thingId', response: 'types.ts#Thing' },
      ]),
    });
    const { model } = await extractClaims({ mapPath: join(base, 'claims.map.json') });

    const observedBody: Shape = {
      kind: 'object',
      samples: 10,
      fields: {
        id: { shape: { kind: 'primitive', type: 'string' }, optional: false, seen: 10 },
        when: { shape: { kind: 'primitive', type: 'integer' }, optional: false, seen: 10 },
        count: { shape: { kind: 'primitive', type: 'integer' }, optional: false, seen: 10 },
      },
    };
    const { diffModels } = await import('../drift/index.js');
    const report = diffModels(
      model,
      {
        name: 'wire',
        target: 'http://x',
        generatedAt: 1,
        endpoints: [
          {
            method: 'GET',
            pattern: '/api/things/:thingId',
            params: [],
            queryShape: null,
            requestBodyShape: null,
            responses: [{ status: 200, bodyShape: observedBody, count: 10 }],
            exchangeIds: [],
            operationId: 'getApiThingsByThingId',
            typeName: 'GetApiThingsByThingId',
          },
        ],
      },
      { ignoreUnmatchedEndpoints: true },
    );

    // when: string (claim) vs integer (wire) → breaking; count: number vs integer → info.
    const breaking = report.findings.filter((f) => f.severity === 'breaking');
    expect(breaking).toHaveLength(1);
    expect(breaking[0]!.path).toBe('when');
    expect(breaking[0]!.bSamples).toBe(10);
    const infos = report.findings.filter((f) => f.kind === 'type-changed' && f.severity === 'info');
    expect(infos.some((f) => f.path === 'count')).toBe(true);
  });
});
