import { describe, it, expect } from 'vitest';
import { normalizePath, operationName, singularize, coerceQueryValue, buildApiModel } from './normalize.js';
import type { Exchange, JsonValue, ObjectShape, PrimitiveShape, Recording, ArrayShape } from './types.js';

describe('singularize', () => {
  it('strips trailing s', () => {
    expect(singularize('users')).toBe('user');
    expect(singularize('posts')).toBe('post');
  });
  it('ies -> y', () => {
    expect(singularize('categories')).toBe('category');
  });
  it('leaves non-plural alone', () => {
    expect(singularize('media')).toBe('media');
  });
});

describe('normalizePath', () => {
  it('numeric segment -> integer param named from previous segment', () => {
    const n = normalizePath('/api/users/42');
    expect(n.pattern).toBe('/api/users/:userId');
    expect(n.params[0]).toMatchObject({ name: 'userId', index: 2, format: 'integer', value: '42' });
  });
  it('uuid segment -> uuid param', () => {
    const n = normalizePath('/api/posts/2b8f0a3e-9c1d-4a2b-8e7f-1a2b3c4d5e6f');
    expect(n.pattern).toBe('/api/posts/:postId');
    expect(n.params[0]?.format).toBe('uuid');
  });
  it('long hex token -> string param', () => {
    const n = normalizePath('/api/tokens/deadbeefdeadbeefdeadbeef');
    expect(n.pattern).toBe('/api/tokens/:tokenId');
    expect(n.params[0]?.format).toBe('string');
  });
  it('short hex is a literal, not a param', () => {
    const n = normalizePath('/api/x/abc123');
    expect(n.pattern).toBe('/api/x/abc123');
    expect(n.params).toHaveLength(0);
  });
  it('fallback param<i> when no usable previous segment', () => {
    const n = normalizePath('/42');
    expect(n.pattern).toBe('/:param0');
    expect(n.params[0]?.name).toBe('param0');
  });
  it('two consecutive params get distinct names', () => {
    const n = normalizePath('/api/users/42/posts/99');
    expect(n.pattern).toBe('/api/users/:userId/posts/:postId');
  });
});

describe('operationName', () => {
  it('GET /api/users/:userId', () => {
    expect(operationName('GET', '/api/users/:userId')).toEqual({
      operationId: 'getApiUsersByUserId',
      typeName: 'GetApiUsersByUserId',
    });
  });
  it('DELETE prefix', () => {
    expect(operationName('DELETE', '/api/users/:userId').operationId).toBe('deleteApiUsersByUserId');
  });
  it('multiple params contribute By... in order', () => {
    expect(operationName('GET', '/api/users/:userId/posts/:postId').typeName).toBe(
      'GetApiUsersByUserIdPostsByPostId',
    );
  });
  it('sanitizes non-alphanumeric path chars', () => {
    expect(operationName('GET', '/api/v1.2/foo-bar').operationId).toBe('getApiV12FooBar');
  });
});

describe('coerceQueryValue', () => {
  it('integer', () => expect(coerceQueryValue('42')).toBe(42));
  it('negative integer', () => expect(coerceQueryValue('-7')).toBe(-7));
  it('float', () => expect(coerceQueryValue('3.14')).toBe(3.14));
  it('true/false', () => {
    expect(coerceQueryValue('true')).toBe(true);
    expect(coerceQueryValue('false')).toBe(false);
  });
  it('string fallback', () => expect(coerceQueryValue('admin')).toBe('admin'));
});

/* ------------------------------------------------------------------ */
/* buildApiModel with a synthetic recording                            */
/* ------------------------------------------------------------------ */

let idCounter = 0;
function ex(
  method: string,
  path: string,
  status: number,
  bodyJson: JsonValue | undefined,
  opts: { query?: Record<string, string[]>; reqBody?: JsonValue; contentType?: string } = {},
): Exchange {
  idCounter++;
  return {
    id: `ex-${idCounter}`,
    startedAt: 1000 + idCounter,
    request: {
      method,
      url: path,
      path: path.split('?')[0] ?? path,
      query: opts.query ?? {},
      headers: {},
      ...(opts.reqBody !== undefined ? { bodyJson: opts.reqBody } : {}),
    },
    response: {
      status,
      headers: opts.contentType ? { 'content-type': opts.contentType } : {},
      ...(bodyJson !== undefined ? { bodyJson } : {}),
      durationMs: 5,
    },
  };
}

function recFrom(exchanges: Exchange[]): Recording {
  return {
    meta: { name: 'test', target: 'http://x', createdAt: 1, updatedAt: 2, exchangeCount: exchanges.length },
    exchanges,
  };
}

describe('buildApiModel', () => {
  it('groups by method + normalized pattern', () => {
    const rec = recFrom([
      ex('GET', '/api/users/1', 200, { id: 1 }, { contentType: 'application/json' }),
      ex('GET', '/api/users/2', 200, { id: 2 }, { contentType: 'application/json' }),
      ex('GET', '/api/users/3', 404, { error: 'nope' }, { contentType: 'application/json' }),
    ]);
    const model = buildApiModel(rec);
    expect(model.endpoints).toHaveLength(1);
    const ep = model.endpoints[0]!;
    expect(ep.pattern).toBe('/api/users/:userId');
    expect(ep.operationId).toBe('getApiUsersByUserId');
    expect(ep.responses.map((r) => r.status)).toEqual([200, 404]);
    expect(ep.responses[0]?.count).toBe(2);
    expect(ep.params[0]?.samples).toEqual(['1', '2', '3']);
  });

  it('caps path param samples at 10', () => {
    const exchanges: Exchange[] = [];
    for (let i = 0; i < 15; i++) exchanges.push(ex('GET', `/api/users/${i}`, 200, { id: i }));
    const model = buildApiModel(recFrom(exchanges));
    expect(model.endpoints[0]?.params[0]?.samples).toHaveLength(10);
  });

  it('response variant merges bodies and keeps latest sample + dominant content-type', () => {
    const rec = recFrom([
      ex('GET', '/api/users/1', 200, { id: 1, name: 'a' }, { contentType: 'application/json' }),
      ex('GET', '/api/users/2', 200, { id: 2 }, { contentType: 'application/json; charset=utf-8' }),
    ]);
    const ep = buildApiModel(rec).endpoints[0]!;
    const r = ep.responses[0]!;
    const shape = r.bodyShape as ObjectShape;
    expect(shape.fields.name?.optional).toBe(true);
    expect(r.sampleBody).toEqual({ id: 2 });
    expect(r.contentType).toBe('application/json');
  });

  it('infers query shape with coercion and optionality', () => {
    const rec = recFrom([
      ex('GET', '/api/users', 200, [], { query: { page: ['1'], role: ['admin'], tag: ['a', 'b'] } }),
      ex('GET', '/api/users', 200, [], { query: { page: ['2'] } }),
    ]);
    const ep = buildApiModel(rec).endpoints[0]!;
    const q = ep.queryShape as ObjectShape;
    expect((q.fields.page?.shape as PrimitiveShape).type).toBe('integer');
    expect(q.fields.page?.optional).toBe(false);
    expect(q.fields.role?.optional).toBe(true);
    expect(q.fields.tag?.shape.kind).toBe('array');
  });

  it('captures request body shape and latest sample', () => {
    const rec = recFrom([
      ex('POST', '/api/users', 201, { id: 1 }, { reqBody: { name: 'a', role: 'admin' } }),
      ex('POST', '/api/users', 201, { id: 2 }, { reqBody: { name: 'b' } }),
    ]);
    const ep = buildApiModel(rec).endpoints[0]!;
    const body = ep.requestBodyShape as ObjectShape;
    expect(body.fields.role?.optional).toBe(true);
    expect(ep.requestSample).toEqual({ name: 'b' });
  });

  it('detects enums (>=4 samples, <=8 distinct, no formats, no booleans)', () => {
    const roles = ['admin', 'editor', 'viewer', 'admin', 'editor'];
    const exchanges = roles.map((r, i) => ex('GET', `/api/u/${i}`, 200, { role: r }));
    const ep = buildApiModel(recFrom(exchanges)).endpoints[0]!;
    const shape = ep.responses[0]?.bodyShape as ObjectShape;
    const role = shape.fields.role?.shape as PrimitiveShape;
    expect(role.enum?.slice().sort()).toEqual(['admin', 'editor', 'viewer']);
  });

  it('does not emit enum for booleans', () => {
    const exchanges = [true, false, true, false, true].map((b, i) =>
      ex('GET', `/api/f/${i}`, 200, { active: b }),
    );
    const ep = buildApiModel(recFrom(exchanges)).endpoints[0]!;
    const shape = ep.responses[0]?.bodyShape as ObjectShape;
    const active = shape.fields.active?.shape as PrimitiveShape;
    expect(active.enum).toBeUndefined();
  });

  it('does not emit enum when a format was detected', () => {
    const emails = ['a@b.com', 'c@d.com', 'e@f.com', 'g@h.com', 'i@j.com'];
    const exchanges = emails.map((e, i) => ex('GET', `/api/e/${i}`, 200, { email: e }));
    const ep = buildApiModel(recFrom(exchanges)).endpoints[0]!;
    const shape = ep.responses[0]?.bodyShape as ObjectShape;
    const email = shape.fields.email?.shape as PrimitiveShape;
    expect(email.enum).toBeUndefined();
    expect(email.formats).toEqual(['email']);
  });

  it('does not emit enum with too many distinct values', () => {
    const exchanges = Array.from({ length: 12 }, (_, i) =>
      ex('GET', `/api/k/${i}`, 200, { code: `v${i}` }),
    );
    const ep = buildApiModel(recFrom(exchanges)).endpoints[0]!;
    const shape = ep.responses[0]?.bodyShape as ObjectShape;
    expect((shape.fields.code?.shape as PrimitiveShape).enum).toBeUndefined();
  });

  it('does not emit enum for numbers, even repeated small sets', () => {
    const ids = [101, 102, 101, 102, 101, 102];
    const exchanges = ids.map((id, i) => ex('GET', `/api/n/${i}`, 200, { id }));
    const ep = buildApiModel(recFrom(exchanges)).endpoints[0]!;
    const shape = ep.responses[0]?.bodyShape as ObjectShape;
    expect((shape.fields.id?.shape as PrimitiveShape).enum).toBeUndefined();
  });

  it('does not emit enum for free-form strings (non token-like)', () => {
    const titles = ['On Computable Numbers', 'On Computable Numbers', 'The First Compiler', 'The First Compiler'];
    const exchanges = titles.map((t, i) => ex('GET', `/api/t/${i}`, 200, { title: t }));
    const ep = buildApiModel(recFrom(exchanges)).endpoints[0]!;
    const shape = ep.responses[0]?.bodyShape as ObjectShape;
    expect((shape.fields.title?.shape as PrimitiveShape).enum).toBeUndefined();
  });

  it('does not emit enum when values never repeat (distinct == samples)', () => {
    const slugs = ['alpha', 'beta', 'gamma', 'delta'];
    const exchanges = slugs.map((v, i) => ex('GET', `/api/s/${i}`, 200, { slug: v }));
    const ep = buildApiModel(recFrom(exchanges)).endpoints[0]!;
    const shape = ep.responses[0]?.bodyShape as ObjectShape;
    expect((shape.fields.slug?.shape as PrimitiveShape).enum).toBeUndefined();
  });

  it('detects record shapes (>=12 homogeneous keys)', () => {
    const dict: Record<string, JsonValue> = {};
    for (let i = 0; i < 14; i++) dict[`k${i}`] = i;
    const ep = buildApiModel(recFrom([ex('GET', '/api/dict', 200, dict)])).endpoints[0]!;
    const shape = ep.responses[0]?.bodyShape;
    expect(shape?.kind).toBe('record');
  });

  it('endpoints sorted by pattern then method, responses by status', () => {
    const rec = recFrom([
      ex('POST', '/api/users', 201, { id: 1 }),
      ex('GET', '/api/users', 200, []),
      ex('GET', '/api/posts', 500, { error: 'x' }),
      ex('GET', '/api/posts', 200, []),
    ]);
    const model = buildApiModel(rec);
    expect(model.endpoints.map((e) => `${e.method} ${e.pattern}`)).toEqual([
      'GET /api/posts',
      'GET /api/users',
      'POST /api/users',
    ]);
    const posts = model.endpoints[0]!;
    expect(posts.responses.map((r) => r.status)).toEqual([200, 500]);
  });

  it('non-JSON responses do not break inference (bodyShape null)', () => {
    const rec = recFrom([ex('GET', '/api/health', 200, undefined, { contentType: 'text/plain' })]);
    const ep = buildApiModel(rec).endpoints[0]!;
    expect(ep.responses[0]?.bodyShape).toBeNull();
    expect(ep.responses[0]?.count).toBe(1);
  });

  it('array element merges across exchanges', () => {
    const rec = recFrom([
      ex('GET', '/api/list', 200, [{ id: 1 }]),
      ex('GET', '/api/list', 200, [{ id: 2, extra: true }]),
    ]);
    const ep = buildApiModel(rec).endpoints[0]!;
    const arr = ep.responses[0]?.bodyShape as ArrayShape;
    const el = arr.element as ObjectShape;
    expect(el.fields.extra?.optional).toBe(true);
  });
});
