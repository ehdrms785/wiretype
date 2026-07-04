import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RecordingStore, buildApiModel } from '../core/index.js';
import { startProxy } from '../proxy/index.js';
import { diffModels } from '../drift/index.js';
import { runGen } from './cmd-gen.js';
import { renderHuman } from './cmd-diff.js';

export interface DemoOptions {
  dir: string;
  out: string;
}

/* ------------------------------------------------------------------ */
/* Tiny ANSI helpers (no deps; disabled when not a TTY or NO_COLOR).   */
/* ------------------------------------------------------------------ */

const useColor =
  (!!process.stdout.isTTY || !!process.env.FORCE_COLOR) && !process.env.NO_COLOR;
const bold = (s: string): string => (useColor ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string): string => (useColor ? `\x1b[2m${s}\x1b[0m` : s);
const cyan = (s: string): string => (useColor ? `\x1b[36m${s}\x1b[0m` : s);
const yellow = (s: string): string => (useColor ? `\x1b[33m${s}\x1b[0m` : s);

const say = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

/* ------------------------------------------------------------------ */
/* In-process demo API. version 1 = "what the docs promised",          */
/* version 2 = "what the backend quietly became six months later".     */
/* Deterministic: no randomness anywhere.                              */
/* ------------------------------------------------------------------ */

interface DemoUpstream {
  url: string;
  close(): Promise<void>;
}

const USERS = [
  { id: 'a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d', name: 'Ada Lovelace', email: 'ada@example.com', role: 'admin', createdAt: '2023-01-15T09:24:00.000Z', lastLoginAt: '2024-11-02T14:05:30.000Z', lastLoginEpoch: 1730556330000, avatarUrl: 'https://cdn.example.com/avatars/ada.png' },
  { id: 'b4e2d3c5-6f70-4b8c-9d0e-1f2a3b4c5d6e', name: 'Alan Turing', email: 'alan@example.com', role: 'admin', createdAt: '2023-02-20T11:10:00.000Z', lastLoginAt: '2024-10-28T08:42:11.000Z', lastLoginEpoch: 1730104931000, avatarUrl: undefined },
  { id: 'c5f3e4d6-7081-4c9d-ae1f-2a3b4c5d6e7f', name: 'Grace Hopper', email: 'grace@example.com', role: 'editor', createdAt: '2023-03-05T16:30:00.000Z', lastLoginAt: null, lastLoginEpoch: null, avatarUrl: 'https://cdn.example.com/avatars/grace.png' },
  { id: 'd6a4f5e7-8192-4dae-bf20-3b4c5d6e7f80', name: 'Katherine Johnson', email: 'katherine@example.com', role: 'editor', createdAt: '2023-04-12T07:45:00.000Z', lastLoginAt: '2024-09-19T22:15:00.000Z', lastLoginEpoch: 1726784100000, avatarUrl: undefined },
  { id: 'e7b5a6f8-92a3-4ebf-c031-4c5d6e7f8091', name: 'Margaret Hamilton', email: 'margaret@example.com', role: 'viewer', createdAt: '2023-05-25T13:00:00.000Z', lastLoginAt: null, lastLoginEpoch: null, avatarUrl: 'https://cdn.example.com/avatars/margaret.png' },
  { id: 'f8c6b7a9-a3b4-4fc0-d142-5d6e7f8091a2', name: 'Barbara Liskov', email: 'barbara@example.com', role: 'viewer', createdAt: '2023-06-30T18:20:00.000Z', lastLoginAt: '2024-08-01T10:00:00.000Z', lastLoginEpoch: 1722506400000, avatarUrl: 'https://cdn.example.com/avatars/barbara.png' },
] as const;

const POSTS: Record<string, object> = {
  '101': {
    id: 101,
    title: 'Notes on the Analytical Engine',
    body: 'A sequence of operations may be varied indefinitely.',
    publishedAt: '2024-01-10T12:00:00.000Z',
    tags: ['history', 'computing'],
    author: { id: 'a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d', name: 'Ada Lovelace', role: 'admin' },
    stats: { views: 15234, likes: 842 },
  },
  '102': {
    id: 102,
    title: 'On Computable Numbers',
    body: 'It is possible to invent a single machine.',
    publishedAt: '2024-02-14T08:30:00.000Z',
    tags: ['theory', 'computing'],
    author: { id: 'b4e2d3c5-6f70-4b8c-9d0e-1f2a3b4c5d6e', name: 'Alan Turing', role: 'admin' },
    stats: { views: 98765, likes: 4210 },
  },
};

/** Render a user in the v1 (documented) or v2 (drifted) shape. */
function renderUser(u: (typeof USERS)[number], version: 1 | 2): Record<string, unknown> {
  if (version === 1) {
    const out: Record<string, unknown> = {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
    };
    if (u.avatarUrl !== undefined) out.avatarUrl = u.avatarUrl;
    return out;
  }
  // v2 drift: lastLoginAt string→number (epoch), avatarUrl dropped,
  // role gains "owner", new mfaEnabled field.
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role === 'admin' && u.name === 'Ada Lovelace' ? 'owner' : u.role,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginEpoch,
    mfaEnabled: u.role === 'admin',
  };
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function startDemoApi(version: 1 | 2): Promise<DemoUpstream> {
  let createdCounter = 0;

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', 'http://demo.local');
    const path = url.pathname;

    if (path === '/api/health' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }

    if (path === '/api/users' && method === 'GET') {
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 4));
      const role = url.searchParams.get('role');
      let filtered: readonly (typeof USERS)[number][] = USERS;
      if (role) filtered = USERS.filter((u) => u.role === role);
      const slice = filtered.slice((page - 1) * limit, (page - 1) * limit + limit);
      sendJson(res, 200, {
        page,
        limit,
        total: filtered.length,
        data: slice.map((u) => renderUser(u, version)),
      });
      return;
    }

    if (path === '/api/users' && method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          sendJson(res, 400, { error: 'Invalid JSON body', code: 'BAD_JSON' });
          return;
        }
        createdCounter += 1;
        const created = renderUser(USERS[0]!, version);
        created.id = `cafe0000-0000-4000-8000-0000000000${String(createdCounter).padStart(2, '0')}`;
        created.name = typeof parsed.name === 'string' ? parsed.name : 'Anonymous';
        created.lastLoginAt = null;
        sendJson(res, 201, created);
      });
      return;
    }

    const userMatch = /^\/api\/users\/([^/]+)$/.exec(path);
    if (userMatch && method === 'GET') {
      const idx = Number(userMatch[1]);
      if (Number.isInteger(idx) && idx >= 1 && idx <= USERS.length) {
        sendJson(res, 200, renderUser(USERS[idx - 1]!, version));
      } else {
        sendJson(res, 404, { error: `User ${userMatch[1]} not found`, code: 'NOT_FOUND' });
      }
      return;
    }

    const postMatch = /^\/api\/posts\/([^/]+)$/.exec(path);
    if (postMatch && method === 'GET') {
      const post = POSTS[postMatch[1] ?? ''];
      if (post) sendJson(res, 200, post);
      else sendJson(res, 404, { error: `Post ${postMatch[1]} not found`, code: 'NOT_FOUND' });
      return;
    }

    sendJson(res, 404, { error: `No route for ${method} ${path}`, code: 'NOT_FOUND' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* Scripted traffic                                                    */
/* ------------------------------------------------------------------ */

async function hit(base: string, method: string, path: string, body?: unknown): Promise<void> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, init);
  await res.text().catch(() => {});
}

async function fireTrafficV1(base: string): Promise<number> {
  const calls: Array<[string, string, unknown?]> = [
    ['GET', '/api/users?page=1&limit=4'],
    ['GET', '/api/users?page=2&limit=4'],
    ['GET', '/api/users?page=1&limit=3&role=admin'],
    ['GET', '/api/users?page=1&limit=3&role=editor'],
    ['GET', '/api/users?page=1&limit=5&role=viewer'],
    ['GET', '/api/users?page=1&limit=2'],
    ['GET', '/api/users/1'],
    ['GET', '/api/users/2'],
    ['GET', '/api/users/3'],
    ['GET', '/api/users/4'],
    ['GET', '/api/users/5'],
    ['GET', '/api/users/6'],
    ['GET', '/api/users/999'], // 404
    ['POST', '/api/users', { name: 'Dennis Ritchie', email: 'dennis@example.com', role: 'admin' }],
    ['POST', '/api/users', { name: 'Ken Thompson', email: 'ken@example.com' }],
    ['GET', '/api/posts/101'],
    ['GET', '/api/posts/102'],
    ['GET', '/api/posts/900'], // 404
    ['GET', '/api/health'],
  ];
  for (const [method, path, body] of calls) await hit(base, method, path, body);
  return calls.length;
}

async function fireTrafficV2(base: string): Promise<number> {
  const calls: Array<[string, string, unknown?]> = [
    ['GET', '/api/users?page=1&limit=4'],
    ['GET', '/api/users?page=2&limit=4'],
    ['GET', '/api/users?page=1&limit=3&role=admin'],
    ['GET', '/api/users?page=1&limit=5&role=viewer'],
    ['GET', '/api/users/1'],
    ['GET', '/api/users/2'],
    ['GET', '/api/users/3'],
    ['GET', '/api/users/4'],
    ['GET', '/api/users/5'],
    ['GET', '/api/users/6'],
    ['GET', '/api/users/999'], // 404
  ];
  for (const [method, path, body] of calls) await hit(base, method, path, body);
  return calls.length;
}

/* ------------------------------------------------------------------ */
/* Record one version: demo api → proxy → traffic → store              */
/* ------------------------------------------------------------------ */

async function recordVersion(
  store: RecordingStore,
  dir: string,
  name: string,
  version: 1 | 2,
): Promise<number> {
  await store.remove(name); // idempotent reruns
  await store.init(name, 'wiretype-demo-api');

  const api = await startDemoApi(version);
  const pending: Promise<void>[] = [];
  const proxy = await startProxy({
    target: api.url,
    port: 0,
    quiet: true,
    onExchange: (ex) => {
      pending.push(store.append(name, ex));
    },
  });

  const fired =
    version === 1
      ? await fireTrafficV1(`http://127.0.0.1:${proxy.port}`)
      : await fireTrafficV2(`http://127.0.0.1:${proxy.port}`);

  await Promise.all(pending);
  await proxy.close();
  await api.close();
  return fired;
}

/** Pull one generated interface out of types.ts for a teaser. */
function extractInterface(typesTs: string, nameFragment: string): string | null {
  const re = new RegExp(`export interface (\\w*${nameFragment}\\w*Response) \\{[\\s\\S]*?\\n\\}`);
  const match = re.exec(typesTs);
  return match ? match[0] : null;
}

export async function runDemo(opts: DemoOptions): Promise<void> {
  const dir = opts.dir;
  const out = opts.out;
  const store = new RecordingStore(dir);

  say('');
  say(bold('wiretype demo') + dim(' — record real traffic → generate types → catch schema drift.'));
  say(dim('Everything runs locally against a built-in demo API. Nothing leaves your machine.'));
  say('');

  // 1. record v1
  say(bold('[1/4] record') + '  starting a demo API + recording proxy in front of it…');
  const firedV1 = await recordVersion(store, dir, 'demo-v1', 1);
  say(`       ${cyan(String(firedV1))} requests fired through the proxy → recorded to ${cyan(`${dir}/demo-v1`)}`);
  say('');

  // 2. generate
  say(bold('[2/4] generate') + '  inferring the model and generating code…');
  say('');
  await runGen({ name: 'demo-v1', dir, out, targets: 'ts,zod,msw,openapi,model' });

  const typesTs = await readFile(join(out, 'types.ts'), 'utf8').catch(() => '');
  const teaser = extractInterface(typesTs, 'ByUserId');
  if (teaser) {
    say(dim(`--- ${join(out, 'types.ts')} (excerpt) `.padEnd(64, '-')));
    say(teaser);
    say(dim(''.padEnd(64, '-')));
    say('');
  }

  // 3. record v2 (the backend quietly changed)
  say(bold('[3/4] six months later…') + '  the backend changed. re-recording the same endpoints:');
  const firedV2 = await recordVersion(store, dir, 'demo-v2', 2);
  say(`       ${cyan(String(firedV2))} requests → recorded to ${cyan(`${dir}/demo-v2`)}`);
  say('');

  // 4. drift verdict
  say(bold('[4/4] drift') + `  ${dim('wiretype diff demo-v1 demo-v2 --ignore-unmatched')}`);
  say('');
  const modelA = buildApiModel(await store.load('demo-v1'));
  const modelB = buildApiModel(await store.load('demo-v2'));
  const report = diffModels(modelA, modelB, { ignoreUnmatchedEndpoints: true });
  say(renderHuman(report));

  say(bold('The docs lie. The wire doesn’t.'));
  say('');
  say('Next:');
  say(`  npx wiretype ui --dir ${dir}     ${dim('# explore both recordings + generated code in a dashboard')}`);
  say(`  cat ${join(out, 'handlers.ts')}      ${dim('# MSW v2 handlers seeded with the real responses')}`);
  say('');
  say(`Try it on your own app: add the Vite plugin and run ${yellow('vite --mode record')}.`);
  say(dim(`Cleanup: rm -rf ${dir} ${out}`));
  say('');
}
