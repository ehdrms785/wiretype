/**
 * wiretype codegen — handcrafted ApiModel test fixture.
 *
 * Deliberately exercises every feature the emitters must handle:
 * path + query params, optional fields, nullable, unions, enums, formats,
 * nested objects/arrays, record shape, a multi-status endpoint (200 + 404),
 * a POST with a request body, and an endpoint with a non-JSON response.
 */

import type { ApiModel, Endpoint, Shape } from '../core/index.js';

const uuidString: Shape = { kind: 'primitive', type: 'string', formats: ['uuid'] };
const dateTimeString: Shape = { kind: 'primitive', type: 'string', formats: ['date-time'] };
const emailString: Shape = { kind: 'primitive', type: 'string', formats: ['email'] };
const uriString: Shape = { kind: 'primitive', type: 'string', formats: ['uri'] };
const plainString: Shape = { kind: 'primitive', type: 'string' };
const integer: Shape = { kind: 'primitive', type: 'integer' };
const roleEnum: Shape = {
  kind: 'primitive',
  type: 'string',
  enum: ['admin', 'editor', 'viewer'],
};
const numericEnum: Shape = { kind: 'primitive', type: 'integer', enum: [1, 2, 3] };

/** A User object shape with a nullable field, an enum, formats, optional field. */
const userShape: Shape = {
  kind: 'object',
  fields: {
    id: { shape: uuidString, optional: false },
    email: { shape: emailString, optional: false },
    createdAt: { shape: dateTimeString, optional: false },
    role: { shape: roleEnum, optional: false },
    // nullable via union with null
    lastLoginAt: {
      shape: { kind: 'union', variants: [dateTimeString, { kind: 'null' }] },
      optional: false,
    },
    // optional field
    avatarUrl: { shape: uriString, optional: true },
    // union of string | integer (non-null union)
    externalId: {
      shape: { kind: 'union', variants: [plainString, integer] },
      optional: true,
    },
  },
};

/** getApiUsersByUserId — path param, single 200 + 404, nested object. */
const getUser: Endpoint = {
  method: 'GET',
  pattern: '/api/users/:userId',
  params: [{ name: 'userId', index: 2, format: 'uuid', samples: ['a-uuid'] }],
  queryShape: null,
  requestBodyShape: null,
  responses: [
    {
      status: 200,
      bodyShape: userShape,
      sampleBody: {
        id: '11111111-1111-1111-1111-111111111111',
        email: 'a@b.com',
        createdAt: '2020-01-01T00:00:00Z',
        role: 'admin',
        lastLoginAt: null,
      },
      contentType: 'application/json',
      count: 10,
    },
    {
      status: 404,
      bodyShape: {
        kind: 'object',
        fields: {
          error: { shape: plainString, optional: false },
          code: { shape: plainString, optional: false },
        },
      },
      sampleBody: { error: 'not found', code: 'NOT_FOUND' },
      contentType: 'application/json',
      count: 3,
    },
  ],
  exchangeIds: ['e1', 'e2'],
  operationId: 'getApiUsersByUserId',
  typeName: 'GetApiUsersByUserId',
};

/** getApiUsers — query params (with optional + enum), array response. */
const listUsers: Endpoint = {
  method: 'GET',
  pattern: '/api/users',
  params: [],
  queryShape: {
    kind: 'object',
    fields: {
      page: { shape: integer, optional: true },
      limit: { shape: integer, optional: true },
      role: { shape: roleEnum, optional: true },
    },
  },
  requestBodyShape: null,
  responses: [
    {
      status: 200,
      bodyShape: { kind: 'array', element: userShape },
      sampleBody: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          email: 'a@b.com',
          createdAt: '2020-01-01T00:00:00Z',
          role: 'admin',
          lastLoginAt: null,
        },
      ],
      contentType: 'application/json',
      count: 20,
    },
  ],
  exchangeIds: ['e3'],
  operationId: 'getApiUsers',
  typeName: 'GetApiUsers',
};

/** postApiUsers — POST with request body, 201 echo. */
const createUser: Endpoint = {
  method: 'POST',
  pattern: '/api/users',
  params: [],
  queryShape: null,
  requestBodyShape: {
    kind: 'object',
    fields: {
      name: { shape: plainString, optional: false },
      email: { shape: emailString, optional: false },
      role: { shape: roleEnum, optional: true },
      tier: { shape: numericEnum, optional: true },
    },
  },
  requestSample: { name: 'x', email: 'a@b.com' },
  responses: [
    {
      status: 201,
      bodyShape: userShape,
      sampleBody: {
        id: '22222222-2222-2222-2222-222222222222',
        email: 'a@b.com',
        createdAt: '2020-01-01T00:00:00Z',
        role: 'editor',
        lastLoginAt: null,
      },
      contentType: 'application/json',
      count: 5,
    },
  ],
  exchangeIds: ['e4'],
  operationId: 'postApiUsers',
  typeName: 'PostApiUsers',
};

/** getApiPostsByPostId — nested arrays/objects + a record shape + weird key. */
const getPost: Endpoint = {
  method: 'GET',
  pattern: '/api/posts/:postId',
  params: [{ name: 'postId', index: 2, format: 'integer', samples: ['42'] }],
  queryShape: null,
  requestBodyShape: null,
  responses: [
    {
      status: 200,
      bodyShape: {
        kind: 'object',
        fields: {
          id: { shape: integer, optional: false },
          title: { shape: plainString, optional: false },
          tags: { shape: { kind: 'array', element: plainString }, optional: false },
          author: {
            shape: {
              kind: 'object',
              fields: {
                id: { shape: uuidString, optional: false },
                name: { shape: plainString, optional: false },
              },
            },
            optional: false,
          },
          stats: {
            shape: {
              kind: 'object',
              fields: {
                views: { shape: integer, optional: false },
                likes: { shape: integer, optional: false },
              },
            },
            optional: false,
          },
          // record shape: homogeneous dictionary
          metadata: { shape: { kind: 'record', value: plainString }, optional: true },
          // unknown shape
          extra: { shape: { kind: 'unknown' }, optional: true },
          // empty array -> unknown[]
          attachments: { shape: { kind: 'array', element: null }, optional: true },
          // a key that is not a safe identifier
          'content-type': { shape: plainString, optional: true },
        },
      },
      sampleBody: {
        id: 42,
        title: 'Hello',
        tags: ['a', 'b'],
        author: { id: '33333333-3333-3333-3333-333333333333', name: 'Ann' },
        stats: { views: 10, likes: 2 },
      },
      contentType: 'application/json',
      count: 8,
    },
  ],
  exchangeIds: ['e5'],
  operationId: 'getApiPostsByPostId',
  typeName: 'GetApiPostsByPostId',
};

/** getApiHealth — non-JSON response (bodyShape null, no sampleBody). */
const health: Endpoint = {
  method: 'GET',
  pattern: '/api/health',
  params: [],
  queryShape: null,
  requestBodyShape: null,
  responses: [
    {
      status: 200,
      bodyShape: null,
      contentType: 'text/plain',
      count: 15,
    },
  ],
  exchangeIds: ['e6'],
  operationId: 'getApiHealth',
  typeName: 'GetApiHealth',
};

export const fixtureModel: ApiModel = {
  name: 'demo',
  target: 'http://localhost:8080',
  generatedAt: 0,
  endpoints: [getUser, listUsers, createUser, getPost, health],
};
