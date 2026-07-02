import { describe, it, expect } from 'vitest';
import type { Shape } from '../core/index.js';
import { fixtureModel } from './fixture.js';
import {
  renderShapeAsTs,
  renderShapeAsZod,
  generateTypes,
  generateZod,
  generateMsw,
  generateOpenApi,
  generateAll,
  shapeToJsonSchema,
  DEFAULT_BANNER,
} from './index.js';

/** Rough structural sanity: every bracket kind is balanced. */
function bracketsBalanced(src: string): boolean {
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const opens = new Set(['(', '[', '{']);
  const stack: string[] = [];
  let inStr: string | null = null;
  let prev = '';
  for (const ch of src) {
    if (inStr) {
      if (ch === inStr && prev !== '\\') inStr = null;
      prev = ch === '\\' && prev === '\\' ? '' : ch;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      prev = ch;
      continue;
    }
    if (opens.has(ch)) stack.push(ch);
    else if (ch in pairs) {
      if (stack.pop() !== pairs[ch]) return false;
    }
    prev = ch;
  }
  return stack.length === 0 && inStr === null;
}

describe('renderShapeAsTs', () => {
  it('renders primitives, integer as number', () => {
    expect(renderShapeAsTs({ kind: 'primitive', type: 'string' })).toBe('string');
    expect(renderShapeAsTs({ kind: 'primitive', type: 'integer' })).toBe('number');
    expect(renderShapeAsTs({ kind: 'primitive', type: 'boolean' })).toBe('boolean');
  });

  it('renders enum as literal union', () => {
    const s: Shape = { kind: 'primitive', type: 'string', enum: ['a', 'b'] };
    expect(renderShapeAsTs(s)).toBe('"a" | "b"');
  });

  it('renders unknown, null, record, arrays', () => {
    expect(renderShapeAsTs({ kind: 'unknown' })).toBe('unknown');
    expect(renderShapeAsTs({ kind: 'null' })).toBe('null');
    expect(renderShapeAsTs({ kind: 'array', element: null })).toBe('unknown[]');
    expect(
      renderShapeAsTs({ kind: 'array', element: { kind: 'primitive', type: 'string' } }),
    ).toBe('string[]');
    expect(
      renderShapeAsTs({ kind: 'record', value: { kind: 'primitive', type: 'number' } }),
    ).toBe('Record<string, number>');
  });

  it('renders nullable union as `T | null`', () => {
    const s: Shape = {
      kind: 'union',
      variants: [{ kind: 'primitive', type: 'string' }, { kind: 'null' }],
    };
    expect(renderShapeAsTs(s)).toBe('string | null');
  });

  it('wraps union array element with Array<>', () => {
    const s: Shape = {
      kind: 'array',
      element: {
        kind: 'union',
        variants: [{ kind: 'primitive', type: 'string' }, { kind: 'null' }],
      },
    };
    expect(renderShapeAsTs(s)).toBe('Array<string | null>');
  });
});

describe('renderShapeAsZod', () => {
  it('renders formats', () => {
    expect(renderShapeAsZod({ kind: 'primitive', type: 'string', formats: ['uuid'] })).toBe(
      'z.string().uuid()',
    );
    expect(renderShapeAsZod({ kind: 'primitive', type: 'string', formats: ['date-time'] })).toBe(
      'z.string().datetime()',
    );
    expect(renderShapeAsZod({ kind: 'primitive', type: 'string', formats: ['email'] })).toBe(
      'z.string().email()',
    );
    expect(renderShapeAsZod({ kind: 'primitive', type: 'string', formats: ['uri'] })).toBe(
      'z.string().url()',
    );
  });

  it('renders date format via regex', () => {
    const out = renderShapeAsZod({ kind: 'primitive', type: 'string', formats: ['date'] });
    expect(out).toContain('z.string().regex(');
    expect(out).toContain('\\d{4}-\\d{2}-\\d{2}');
  });

  it('integer -> z.number().int()', () => {
    expect(renderShapeAsZod({ kind: 'primitive', type: 'integer' })).toBe('z.number().int()');
  });

  it('string enum -> z.enum, numeric enum -> union of literals', () => {
    expect(
      renderShapeAsZod({ kind: 'primitive', type: 'string', enum: ['a', 'b'] }),
    ).toBe('z.enum(["a", "b"])');
    expect(
      renderShapeAsZod({ kind: 'primitive', type: 'integer', enum: [1, 2] }),
    ).toBe('z.union([z.literal(1), z.literal(2)])');
    expect(renderShapeAsZod({ kind: 'primitive', type: 'integer', enum: [1] })).toBe(
      'z.literal(1)',
    );
  });

  it('nullable union -> .nullable()', () => {
    const s: Shape = {
      kind: 'union',
      variants: [{ kind: 'primitive', type: 'string' }, { kind: 'null' }],
    };
    expect(renderShapeAsZod(s)).toBe('z.string().nullable()');
  });

  it('record and empty array', () => {
    expect(renderShapeAsZod({ kind: 'array', element: null })).toBe('z.array(z.unknown())');
    expect(
      renderShapeAsZod({ kind: 'record', value: { kind: 'primitive', type: 'string' } }),
    ).toBe('z.record(z.string())');
    expect(renderShapeAsZod({ kind: 'unknown' })).toBe('z.unknown()');
  });
});

describe('generateTypes', () => {
  const out = generateTypes(fixtureModel);

  it('starts with the banner', () => {
    expect(out.startsWith(`// ${DEFAULT_BANNER}`)).toBe(true);
  });

  it('emits named interfaces / types per endpoint', () => {
    expect(out).toContain('export interface GetApiUsersByUserIdResponse {');
    expect(out).toContain('export interface GetApiUsersByUserIdResponse404 {');
    expect(out).toContain('export interface GetApiUsersByUserIdParams {');
    expect(out).toContain('export interface GetApiUsersQuery {');
    expect(out).toContain('export interface PostApiUsersRequest {');
  });

  it('params values typed as string', () => {
    expect(out).toMatch(/GetApiUsersByUserIdParams \{\s*userId: string;/);
  });

  it('optional fields use ?:', () => {
    expect(out).toContain('avatarUrl?:');
  });

  it('renders format JSDoc and enum literal unions', () => {
    expect(out).toContain('/** format: uuid */');
    expect(out).toContain('"admin" | "editor" | "viewer"');
  });

  it('renders nullable union field', () => {
    expect(out).toContain('lastLoginAt: string | null;');
  });

  it('non-object response becomes a type alias (health has unknown)', () => {
    expect(out).toContain('export type GetApiHealthResponse = unknown;');
  });

  it('array response becomes a type alias', () => {
    expect(out).toMatch(/export type GetApiUsersResponse = \{[\s\S]*\}\[\];/);
  });

  it('record + unknown + empty-array + quoted key in nested object', () => {
    expect(out).toContain('Record<string, string>');
    expect(out).toContain('extra?: unknown;');
    expect(out).toContain('attachments?: unknown[];');
    expect(out).toContain('"content-type"?: string;');
  });

  it('emits ApiEndpoints summary referencing named types with never fallbacks', () => {
    expect(out).toContain('export interface ApiEndpoints {');
    expect(out).toContain(
      '"GET /api/users/:userId": { params: GetApiUsersByUserIdParams; query: never; request: never; response: GetApiUsersByUserIdResponse };',
    );
    expect(out).toContain(
      '"GET /api/health": { params: never; query: never; request: never; response: GetApiHealthResponse };',
    );
  });

  it('is bracket-balanced', () => {
    expect(bracketsBalanced(out)).toBe(true);
  });
});

describe('generateZod', () => {
  const out = generateZod(fixtureModel);

  it('imports zod and starts with banner', () => {
    expect(out.startsWith(`// ${DEFAULT_BANNER}`)).toBe(true);
    expect(out).toContain("import { z } from 'zod';");
  });

  it('emits schemas + inferred type aliases per variant', () => {
    expect(out).toContain('export const getApiUsersByUserIdResponseSchema = z.object({');
    expect(out).toContain(
      'export type GetApiUsersByUserIdResponse = z.infer<typeof getApiUsersByUserIdResponseSchema>;',
    );
    expect(out).toContain('export const getApiUsersByUserIdResponseSchema404 = z.object({');
    expect(out).toContain('export const getApiUsersQuerySchema = z.object({');
    expect(out).toContain('export const postApiUsersRequestSchema = z.object({');
  });

  it('renders formats, enums, integer, optional, nullable', () => {
    expect(out).toContain('z.string().uuid()');
    expect(out).toContain('z.string().email()');
    expect(out).toContain('z.string().datetime()');
    expect(out).toContain('z.enum(["admin", "editor", "viewer"])');
    expect(out).toContain('z.number().int()');
    expect(out).toContain('.optional()');
    expect(out).toContain('z.string().datetime().nullable()');
  });

  it('numeric enum -> literal union', () => {
    expect(out).toContain('z.union([z.literal(1), z.literal(2), z.literal(3)])');
  });

  it('record + empty array + unknown', () => {
    expect(out).toContain('z.record(z.string())');
    expect(out).toContain('z.array(z.unknown())');
    expect(out).toContain('z.unknown()');
  });

  it('quoted key in object', () => {
    expect(out).toContain('"content-type": z.string().optional()');
  });

  it('health (non-JSON) response falls back to z.unknown()', () => {
    expect(out).toContain('export const getApiHealthResponseSchema = z.unknown();');
  });

  it('is bracket-balanced', () => {
    expect(bracketsBalanced(out)).toBe(true);
  });
});

describe('generateMsw', () => {
  const out = generateMsw(fixtureModel);

  it('imports msw and starts with banner', () => {
    expect(out.startsWith(`// ${DEFAULT_BANNER}`)).toBe(true);
    expect(out).toContain("import { http, HttpResponse } from 'msw';");
    expect(out).toContain('export const handlers = [');
  });

  it('uses default base url * and correct methods', () => {
    expect(out).toContain("http.get('*/api/users/:userId', () =>");
    expect(out).toContain("http.post('*/api/users', () =>");
    expect(out).toContain("http.get('*/api/posts/:postId', () =>");
  });

  it('emits success handler with JSON body + status', () => {
    expect(out).toContain('HttpResponse.json(');
    expect(out).toContain('{ status: 200 }');
    expect(out).toContain('{ status: 201 }');
  });

  it('non-2xx variant included as commented block', () => {
    expect(out).toMatch(/\/\/\s*http\.get\('\*\/api\/users\/:userId'/);
    expect(out).toContain('{ status: 404 }');
  });

  it('non-JSON response -> new HttpResponse(null, ...)', () => {
    expect(out).toContain("http.get('*/api/health', () => new HttpResponse(null, { status: 200 }))");
  });

  it('respects custom mswBaseUrl', () => {
    const custom = generateMsw(fixtureModel, { mswBaseUrl: 'https://api.test' });
    expect(custom).toContain("http.get('https://api.test/api/users/:userId', () =>");
  });

  it('is bracket-balanced', () => {
    expect(bracketsBalanced(out)).toBe(true);
  });
});

describe('shapeToJsonSchema', () => {
  it('integer, format, enum, unknown', () => {
    expect(shapeToJsonSchema({ kind: 'primitive', type: 'integer' })).toEqual({ type: 'integer' });
    expect(shapeToJsonSchema({ kind: 'primitive', type: 'string', formats: ['uuid'] })).toEqual({
      type: 'string',
      format: 'uuid',
    });
    expect(
      shapeToJsonSchema({ kind: 'primitive', type: 'string', enum: ['a', 'b'] }),
    ).toEqual({ type: 'string', enum: ['a', 'b'] });
    expect(shapeToJsonSchema({ kind: 'unknown' })).toEqual({});
  });

  it('nullable primitive -> type array; record -> additionalProperties', () => {
    expect(
      shapeToJsonSchema({
        kind: 'union',
        variants: [{ kind: 'primitive', type: 'string', formats: ['date-time'] }, { kind: 'null' }],
      }),
    ).toEqual({ type: ['string', 'null'], format: 'date-time' });
    expect(
      shapeToJsonSchema({ kind: 'record', value: { kind: 'primitive', type: 'string' } }),
    ).toEqual({ type: 'object', additionalProperties: { type: 'string' } });
  });

  it('non-null union -> anyOf', () => {
    const s: Shape = {
      kind: 'union',
      variants: [{ kind: 'primitive', type: 'string' }, { kind: 'primitive', type: 'integer' }],
    };
    expect(shapeToJsonSchema(s)).toEqual({
      anyOf: [{ type: 'string' }, { type: 'integer' }],
    });
  });

  it('object required omits optional fields', () => {
    const s: Shape = {
      kind: 'object',
      fields: {
        a: { shape: { kind: 'primitive', type: 'string' }, optional: false },
        b: { shape: { kind: 'primitive', type: 'string' }, optional: true },
      },
    };
    expect(shapeToJsonSchema(s)).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['a'],
    });
  });
});

describe('generateOpenApi', () => {
  const doc = generateOpenApi(fixtureModel);

  it('is JSON-serializable and 3.1 with info/servers', () => {
    const json = JSON.stringify(doc);
    expect(json).toBeTruthy();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info).toEqual({ title: 'demo (recorded)', version: '0.0.0' });
    expect(doc.servers).toEqual([{ url: 'http://localhost:8080' }]);
  });

  it('uses {userId} path syntax with path + query parameters', () => {
    const paths = doc.paths as Record<string, any>;
    expect(paths['/api/users/{userId}']).toBeTruthy();
    const getUser = paths['/api/users/{userId}'].get;
    expect(getUser.operationId).toBe('getApiUsersByUserId');
    const pathParam = getUser.parameters.find((p: any) => p.in === 'path');
    expect(pathParam).toEqual({
      name: 'userId',
      in: 'path',
      required: true,
      schema: { type: 'string', format: 'uuid' },
    });

    const listUsers = paths['/api/users'].get;
    const queryParam = listUsers.parameters.find((p: any) => p.name === 'role');
    expect(queryParam.in).toBe('query');
    expect(queryParam.required).toBe(false);
    expect(queryParam.schema).toEqual({ type: 'string', enum: ['admin', 'editor', 'viewer'] });
  });

  it('multi-status responses with JSON schema', () => {
    const getUser = (doc.paths as any)['/api/users/{userId}'].get;
    expect(getUser.responses['200'].content['application/json'].schema.type).toBe('object');
    expect(getUser.responses['404']).toBeTruthy();
  });

  it('requestBody present for POST', () => {
    const post = (doc.paths as any)['/api/users'].post;
    expect(post.requestBody.content['application/json'].schema.type).toBe('object');
  });

  it('non-JSON response has no content', () => {
    const health = (doc.paths as any)['/api/health'].get;
    expect(health.responses['200'].content).toBeUndefined();
  });
});

describe('generateAll', () => {
  it('emits the four files with expected paths', () => {
    const files = generateAll(fixtureModel);
    expect(files.map((f) => f.path)).toEqual([
      'types.ts',
      'schemas.ts',
      'handlers.ts',
      'openapi.json',
    ]);
  });

  it('openapi.json is valid JSON and carries the banner', () => {
    const files = generateAll(fixtureModel);
    const openapi = files.find((f) => f.path === 'openapi.json')!;
    const parsed = JSON.parse(openapi.content);
    expect(parsed['x-generated-by']).toBe(DEFAULT_BANNER);
    expect(parsed.openapi).toBe('3.1.0');
  });

  it('honors a subset of targets and custom banner', () => {
    const files = generateAll(fixtureModel, ['ts'], { banner: 'custom banner' });
    expect(files).toHaveLength(1);
    expect(files[0]!.content.startsWith('// custom banner')).toBe(true);
  });

  it('is deterministic', () => {
    expect(generateAll(fixtureModel)).toEqual(generateAll(fixtureModel));
  });
});

describe('array element parenthesization', () => {
  it('wraps enum literal unions inside arrays', () => {
    const shape: Shape = {
      kind: 'array',
      element: { kind: 'primitive', type: 'string', enum: ['history', 'computing'] },
    };
    expect(renderShapeAsTs(shape)).toBe('Array<"history" | "computing">');
  });

  it('does not wrap single-literal enums or plain primitives', () => {
    const single: Shape = {
      kind: 'array',
      element: { kind: 'primitive', type: 'string', enum: ['only'] },
    };
    expect(renderShapeAsTs(single)).toBe('"only"[]');
    const plain: Shape = { kind: 'array', element: { kind: 'primitive', type: 'string' } };
    expect(renderShapeAsTs(plain)).toBe('string[]');
  });
});
