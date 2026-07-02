import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { RecordingStore, buildApiModel } from '../core/index.js';
import {
  generateMsw,
  generateOpenApi,
  generateTypes,
  generateZod,
} from '../codegen/index.js';
import { isTarget } from './util.js';
import type { Target } from './util.js';

export interface UiOptions {
  dir: string;
  port: string;
}

/**
 * Viewer HTML candidates, in priority order:
 * 1. WIRETYPE_VIEWER_HTML env (explicit override)
 * 2. <package root>/viewer/index.html resolved from dist/cli/ (normal install)
 * 3. ./viewer/index.html next to the executable (single-file bundle layout)
 */
const VIEWER_CANDIDATES: URL[] = [
  ...(process.env['WIRETYPE_VIEWER_HTML']
    ? [new URL(`file://${process.env['WIRETYPE_VIEWER_HTML']}`)]
    : []),
  new URL('../../viewer/index.html', import.meta.url),
  new URL('./viewer/index.html', import.meta.url),
];

export async function runUi(opts: UiOptions): Promise<void> {
  const port = Number.parseInt(opts.port, 10);
  if (Number.isNaN(port)) {
    throw new Error(`Invalid --port: ${opts.port}`);
  }
  const store = new RecordingStore(opts.dir);

  const server = http.createServer((req, res) => {
    handleRequest(req, res, store).catch((err: unknown) => {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  process.stdout.write(`wiretype ui → http://localhost:${port}\n`);

  // Keep the process alive until interrupted.
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      server.close(() => resolve());
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  setCors(res);
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, body: string): void {
  setCors(res);
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: RecordingStore,
): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  if (method === 'OPTIONS') {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // Static viewer.
  if (pathname === '/' || pathname === '/index.html') {
    await serveViewer(res);
    return;
  }

  // JSON API.
  const segments = pathname.split('/').filter((s) => s.length > 0);
  // /api/recordings ...
  if (segments[0] === 'api' && segments[1] === 'recordings') {
    await handleApi(res, store, segments.slice(2));
    return;
  }

  sendJson(res, 404, { error: `Not found: ${pathname}` });
}

async function serveViewer(res: ServerResponse): Promise<void> {
  for (const candidate of VIEWER_CANDIDATES) {
    try {
      const html = await readFile(fileURLToPath(candidate), 'utf8');
      setCors(res);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    } catch {
      // try next candidate
    }
  }
  sendText(res, 503, 'viewer not built');
}

async function handleApi(
  res: ServerResponse,
  store: RecordingStore,
  rest: string[],
): Promise<void> {
  // GET /api/recordings
  if (rest.length === 0) {
    const list = await store.list();
    sendJson(res, 200, list);
    return;
  }

  const name = rest[0]!;

  // GET /api/recordings/:name
  if (rest.length === 1) {
    try {
      const recording = await store.load(name);
      sendJson(res, 200, recording);
    } catch (err) {
      sendJson(res, 404, {
        error: err instanceof Error ? err.message : `Recording not found: ${name}`,
      });
    }
    return;
  }

  // GET /api/recordings/:name/model
  if (rest.length === 2 && rest[1] === 'model') {
    try {
      const recording = await store.load(name);
      sendJson(res, 200, buildApiModel(recording));
    } catch (err) {
      sendJson(res, 404, {
        error: err instanceof Error ? err.message : `Recording not found: ${name}`,
      });
    }
    return;
  }

  // GET /api/recordings/:name/generated/:target
  if (rest.length === 3 && rest[1] === 'generated') {
    const target = rest[2]!;
    if (!isTarget(target)) {
      sendJson(res, 400, { error: `Unknown target: ${target}` });
      return;
    }
    try {
      const recording = await store.load(name);
      const model = buildApiModel(recording);
      sendText(res, 200, renderTarget(target, model));
    } catch (err) {
      sendJson(res, 404, {
        error: err instanceof Error ? err.message : `Recording not found: ${name}`,
      });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

function renderTarget(
  target: Target,
  model: Parameters<typeof generateTypes>[0],
): string {
  switch (target) {
    case 'ts':
      return generateTypes(model);
    case 'zod':
      return generateZod(model);
    case 'msw':
      return generateMsw(model);
    case 'openapi':
      return JSON.stringify(generateOpenApi(model), null, 2);
  }
}
