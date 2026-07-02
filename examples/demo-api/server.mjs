#!/usr/bin/env node
/**
 * wiretype demo API — zero-dependency node:http server.
 *
 * Serves realistic, DETERMINISTIC data designed to exercise every inference
 * feature in wiretype (enums, formats, optional/nullable fields, unions via
 * multi-status, nested objects, arrays, string[] tags, records).
 *
 * Routes (see docs/ARCHITECTURE.md §examples/demo-api):
 *   GET   /api/users?page=&limit=&role=   paginated list
 *   GET   /api/users/:id                  200 known / 404 unknown
 *   POST  /api/users                      201 created echo
 *   GET   /api/posts/:id                  post w/ nested author/stats/comments
 *   PATCH /api/posts/:id                  200 partial update echo
 *   GET   /api/health                     text/plain "ok"
 *
 * Determinism: no Math.random for data selection. The experimental field on
 * GET /api/users appears iff `page` is an even number.
 */

import http from 'node:http';

const PORT = Number(process.env.PORT) || 8080;

/* ------------------------------------------------------------------ */
/* Seed data                                                           */
/* ------------------------------------------------------------------ */

// Hardcoded uuid-v4-shaped ids (stable across runs).
const USERS = [
  {
    id: 'a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    role: 'admin',
    createdAt: '2023-01-15T09:24:00.000Z',
    lastLoginAt: '2024-11-02T14:05:30.000Z',
    avatarUrl: 'https://cdn.example.com/avatars/ada.png',
  },
  {
    id: 'b4e2d3c5-6f70-4b8c-9d0e-1f2a3b4c5d6e',
    name: 'Alan Turing',
    email: 'alan@example.com',
    role: 'admin',
    createdAt: '2023-02-20T11:10:00.000Z',
    lastLoginAt: '2024-10-28T08:42:11.000Z',
    // avatarUrl intentionally ABSENT (optional key missing, not null)
  },
  {
    id: 'c5f3e4d6-7081-4c9d-ae1f-2a3b4c5d6e7f',
    name: 'Grace Hopper',
    email: 'grace@example.com',
    role: 'editor',
    createdAt: '2023-03-05T16:30:00.000Z',
    lastLoginAt: null, // nullable observed as null
    avatarUrl: 'https://cdn.example.com/avatars/grace.png',
  },
  {
    id: 'd6a4f5e7-8192-4dae-bf20-3b4c5d6e7f80',
    name: 'Katherine Johnson',
    email: 'katherine@example.com',
    role: 'editor',
    createdAt: '2023-04-12T07:45:00.000Z',
    lastLoginAt: '2024-09-19T22:15:00.000Z',
    // avatarUrl absent
  },
  {
    id: 'e7b5a6f8-92a3-4ebf-c031-4c5d6e7f8091',
    name: 'Margaret Hamilton',
    email: 'margaret@example.com',
    role: 'viewer',
    createdAt: '2023-05-25T13:00:00.000Z',
    lastLoginAt: null,
    avatarUrl: 'https://cdn.example.com/avatars/margaret.png',
  },
  {
    id: 'f8c6b7a9-a3b4-4fc0-d142-5d6e7f8091a2',
    name: 'Barbara Liskov',
    email: 'barbara@example.com',
    role: 'viewer',
    createdAt: '2023-06-30T18:20:00.000Z',
    lastLoginAt: '2024-08-01T10:00:00.000Z',
    avatarUrl: 'https://cdn.example.com/avatars/barbara.png',
  },
  {
    id: 'a9d7c8ba-b4c5-40d1-e253-6e7f8091a2b3',
    name: 'Radia Perlman',
    email: 'radia@example.com',
    role: 'editor',
    createdAt: '2023-07-08T05:05:00.000Z',
    lastLoginAt: '2024-07-14T19:30:45.000Z',
    // avatarUrl absent
  },
  {
    id: 'bae8d9cb-c5d6-41e2-f364-7f8091a2b3c4',
    name: 'Frances Allen',
    email: 'frances@example.com',
    role: 'viewer',
    createdAt: '2023-08-19T21:55:00.000Z',
    lastLoginAt: null,
    avatarUrl: 'https://cdn.example.com/avatars/frances.png',
  },
];

// Posts keyed by numeric id, with nested author/stats/comments/tags.
const POSTS = {
  101: {
    id: 101,
    title: 'Notes on the Analytical Engine',
    body: 'A sequence of operations may be varied indefinitely.',
    publishedAt: '2024-01-10T12:00:00.000Z',
    tags: ['history', 'computing', 'engines'],
    author: {
      id: 'a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
      name: 'Ada Lovelace',
      role: 'admin',
    },
    stats: { views: 15234, likes: 842 },
    comments: [
      { id: 1, author: 'Alan Turing', body: 'Prescient.', createdAt: '2024-01-11T09:00:00.000Z' },
      { id: 2, author: 'Grace Hopper', body: 'Love this.', createdAt: '2024-01-12T14:30:00.000Z' },
    ],
  },
  102: {
    id: 102,
    title: 'On Computable Numbers',
    body: 'It is possible to invent a single machine.',
    publishedAt: '2024-02-14T08:30:00.000Z',
    tags: ['theory', 'computing'],
    author: {
      id: 'b4e2d3c5-6f70-4b8c-9d0e-1f2a3b4c5d6e',
      name: 'Alan Turing',
      role: 'admin',
    },
    stats: { views: 98765, likes: 4210 },
    comments: [
      { id: 3, author: 'Katherine Johnson', body: 'Foundational.', createdAt: '2024-02-15T11:11:00.000Z' },
    ],
  },
  103: {
    id: 103,
    title: 'The First Compiler',
    body: 'Nobody believed a computer could understand English.',
    publishedAt: '2024-03-22T17:45:00.000Z',
    tags: ['compilers', 'history', 'tooling'],
    author: {
      id: 'c5f3e4d6-7081-4c9d-ae1f-2a3b4c5d6e7f',
      name: 'Grace Hopper',
      role: 'editor',
    },
    stats: { views: 33210, likes: 1998 },
    comments: [],
  },
  104: {
    id: 104,
    title: 'Software Engineering for Apollo',
    body: 'The code that took us to the Moon.',
    publishedAt: '2024-04-30T06:15:00.000Z',
    tags: ['space', 'reliability'],
    author: {
      id: 'e7b5a6f8-92a3-4ebf-c031-4c5d6e7f8091',
      name: 'Margaret Hamilton',
      role: 'viewer',
    },
    stats: { views: 51000, likes: 3050 },
    comments: [
      { id: 4, author: 'Radia Perlman', body: 'Legendary.', createdAt: '2024-05-01T10:00:00.000Z' },
      { id: 5, author: 'Barbara Liskov', body: 'Rock solid.', createdAt: '2024-05-02T12:00:00.000Z' },
    ],
  },
};

// Deterministic counter for POST-created ids.
let createdCounter = 0;
const CREATED_ID_PREFIX = 'cafe0000-0000-4000-8000-0000000000';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function notFound(res, message) {
  sendJson(res, 404, { error: message || 'Not found', code: 'NOT_FOUND' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(Object.assign(new Error('Body too large'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* Route handlers                                                      */
/* ------------------------------------------------------------------ */

function handleListUsers(res, url) {
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 4));
  const role = url.searchParams.get('role');

  let filtered = USERS;
  if (role) filtered = USERS.filter((u) => u.role === role);

  const start = (page - 1) * limit;
  const slice = filtered.slice(start, start + limit);

  // Deterministic "experimental" field: present iff page is even.
  const includeExperimental = page % 2 === 0;
  const data = slice.map((u) => {
    const out = { ...u };
    if (includeExperimental) out.experimentalScore = u.name.length * 7;
    return out;
  });

  sendJson(res, 200, {
    page,
    limit,
    total: filtered.length,
    role: role || null,
    data,
  });
}

function handleGetUser(res, id) {
  // ids in the demo are addressed by numeric index 1..8 for easy 404 testing.
  const idx = Number(id);
  if (Number.isInteger(idx) && idx >= 1 && idx <= USERS.length) {
    sendJson(res, 200, USERS[idx - 1]);
    return;
  }
  notFound(res, `User ${id} not found`);
}

async function handleCreateUser(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, { error: 'Failed to read request body', code: 'BAD_REQUEST' });
    return;
  }
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body', code: 'BAD_JSON' });
    return;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    sendJson(res, 400, { error: 'Body must be a JSON object', code: 'BAD_BODY' });
    return;
  }

  createdCounter += 1;
  const suffix = String(createdCounter).padStart(2, '0');
  const created = {
    id: `${CREATED_ID_PREFIX}${suffix}`,
    name: typeof body.name === 'string' ? body.name : 'Anonymous',
    email: typeof body.email === 'string' ? body.email : 'anonymous@example.com',
    role: ['admin', 'editor', 'viewer'].includes(body.role) ? body.role : 'viewer',
    createdAt: '2024-12-01T00:00:00.000Z',
    lastLoginAt: null,
  };
  sendJson(res, 201, created);
}

function handleGetPost(res, id) {
  const post = POSTS[id];
  if (post) {
    sendJson(res, 200, post);
    return;
  }
  notFound(res, `Post ${id} not found`);
}

async function handlePatchPost(req, res, id) {
  const post = POSTS[id];
  if (!post) {
    notFound(res, `Post ${id} not found`);
    return;
  }
  let raw;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, { error: 'Failed to read request body', code: 'BAD_REQUEST' });
    return;
  }
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body', code: 'BAD_JSON' });
    return;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    sendJson(res, 400, { error: 'Body must be a JSON object', code: 'BAD_BODY' });
    return;
  }
  // Merge body onto a COPY of the post (do not mutate the seed).
  const merged = { ...post, ...body, id: post.id };
  sendJson(res, 200, merged);
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const method = (req.method || 'GET').toUpperCase();
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const path = url.pathname;
  const startedAt = Date.now();

  res.on('finish', () => {
    const ms = Date.now() - startedAt;
    process.stdout.write(`${method} ${req.url} ${res.statusCode} ${ms}ms\n`);
  });

  try {
    if (path === '/api/health' && method === 'GET') {
      return sendText(res, 200, 'ok');
    }

    if (path === '/api/users' && method === 'GET') {
      return handleListUsers(res, url);
    }
    if (path === '/api/users' && method === 'POST') {
      return await handleCreateUser(req, res);
    }

    const userMatch = path.match(/^\/api\/users\/([^/]+)$/);
    if (userMatch && method === 'GET') {
      return handleGetUser(res, decodeURIComponent(userMatch[1]));
    }

    const postMatch = path.match(/^\/api\/posts\/([^/]+)$/);
    if (postMatch && method === 'GET') {
      return handleGetPost(res, decodeURIComponent(postMatch[1]));
    }
    if (postMatch && method === 'PATCH') {
      return await handlePatchPost(req, res, decodeURIComponent(postMatch[1]));
    }

    return notFound(res, `No route for ${method} ${path}`);
  } catch (err) {
    // Last-resort guard: never crash the process.
    sendJson(res, 500, { error: 'Internal error', code: 'INTERNAL' });
    process.stderr.write(`error handling ${method} ${path}: ${err && err.message}\n`);
  }
});

server.listen(PORT, () => {
  process.stdout.write(`demo-api listening on http://localhost:${PORT}\n`);
});
