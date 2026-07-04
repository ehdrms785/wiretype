import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { afterEach, describe, it, expect } from 'vitest';
import type { Connect, ViteDevServer } from 'vite';
import { RecordingStore } from '../core/index.js';
import wiretypeRecorder, { resolveEnabled } from './index.js';

describe('resolveEnabled', () => {
  it('explicit true wins regardless of mode/env', () => {
    expect(resolveEnabled(true, 'development', false)).toBe(true);
    expect(resolveEnabled(true, 'record', true)).toBe(true);
  });

  it('explicit false wins regardless of mode/env', () => {
    expect(resolveEnabled(false, 'record', true)).toBe(false);
    expect(resolveEnabled(false, 'development', false)).toBe(false);
  });

  it("mode 'record' auto-enables when no explicit flag", () => {
    expect(resolveEnabled(undefined, 'record', false)).toBe(true);
  });

  it('WIRETYPE env auto-enables in any mode when no explicit flag', () => {
    expect(resolveEnabled(undefined, 'development', true)).toBe(true);
    expect(resolveEnabled(undefined, 'production', true)).toBe(true);
  });

  it('neither mode nor env → disabled', () => {
    expect(resolveEnabled(undefined, 'development', false)).toBe(false);
    expect(resolveEnabled(undefined, 'production', false)).toBe(false);
  });
});

describe('wiretypeRecorder plugin', () => {
  it('registers configResolved and configureServer hooks', () => {
    const plugin = wiretypeRecorder({
      target: 'http://localhost:8080',
      prefixes: ['/api'],
    });
    expect(plugin.name).toBe('wiretype-recorder');
    expect(typeof plugin.configResolved).toBe('function');
    expect(typeof plugin.configureServer).toBe('function');
  });
});

/** Start an in-process upstream. Returns base URL + close. */
function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0];

    if (path === '/api/stream' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      const chunk = 'y'.repeat(8 * 1024);
      for (let i = 0; i < 64; i += 1) res.write(chunk); // 512 KiB total
      res.end();
      return;
    }

    if (path === '/api/upload' && req.method === 'POST') {
      let receivedBytes = 0;
      req.on('data', (c: Buffer) => {
        receivedBytes += c.length;
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ receivedBytes }));
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/** Extract the connect middleware the plugin registers, host it on a server. */
function hostMiddleware(
  plugin: ReturnType<typeof wiretypeRecorder>,
): Promise<{ url: string; close: () => Promise<void> }> {
  let middleware: Connect.NextHandleFunction | undefined;
  const fakeServer = {
    middlewares: {
      use: (fn: Connect.NextHandleFunction) => {
        middleware = fn;
      },
    },
  } as unknown as ViteDevServer;
  (plugin.configureServer as (s: ViteDevServer) => void)(fakeServer);
  if (!middleware) throw new Error('middleware not registered');
  const mw = middleware;

  const server = http.createServer((req, res) => {
    mw(req as Connect.IncomingMessage, res, () => {
      res.statusCode = 404;
      res.end('fallthrough');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe('wiretypeRecorder middleware (integration)', () => {
  let upstream: { url: string; close: () => Promise<void> } | undefined;
  let host: { url: string; close: () => Promise<void> } | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    if (host) await host.close();
    if (upstream) await upstream.close();
    if (dir) await rm(dir, { recursive: true, force: true });
    host = undefined;
    upstream = undefined;
    dir = undefined;
  });

  it('streams large responses through while capping the captured copy', async () => {
    upstream = await startUpstream();
    dir = await mkdtemp(join(tmpdir(), 'wiretype-vite-'));
    const plugin = wiretypeRecorder({
      target: upstream.url,
      prefixes: ['/api'],
      enabled: true,
      dir,
      name: 'test',
      maxBodyBytes: 1024,
    });
    host = await hostMiddleware(plugin);

    const res = await fetch(`${host.url}/api/stream`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.length).toBe(512 * 1024); // client gets every byte

    await new Promise((r) => setTimeout(r, 100)); // recording is fire-and-forget
    const store = new RecordingStore(dir);
    const rec = await store.load('test');
    expect(rec.exchanges).toHaveLength(1);
    const bodyText = rec.exchanges[0]!.response.bodyText ?? '';
    expect(bodyText.length).toBeLessThanOrEqual(1024); // capture is capped
  });

  it('forwards large request bodies intact while capturing a truncated copy', async () => {
    upstream = await startUpstream();
    dir = await mkdtemp(join(tmpdir(), 'wiretype-vite-'));
    const plugin = wiretypeRecorder({
      target: upstream.url,
      prefixes: ['/api'],
      enabled: true,
      dir,
      name: 'test',
      maxBodyBytes: 1024,
    });
    host = await hostMiddleware(plugin);

    const bigBody = 'x'.repeat(300 * 1024);
    const res = await fetch(`${host.url}/api/upload`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: bigBody,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ receivedBytes: bigBody.length });

    await new Promise((r) => setTimeout(r, 100));
    const store = new RecordingStore(dir);
    const rec = await store.load('test');
    expect(rec.exchanges).toHaveLength(1);
    const reqText = rec.exchanges[0]!.request.bodyText ?? '';
    expect(reqText.length).toBeLessThanOrEqual(1024);
  });

  it('falls back to wiretype.config.json when plugin options are omitted', async () => {
    upstream = await startUpstream();
    dir = await mkdtemp(join(tmpdir(), 'wiretype-vite-'));
    const storeDir = join(dir, '.wiretype');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(dir, 'wiretype.config.json'),
      JSON.stringify({
        target: upstream.url,
        prefixes: ['/api'],
        name: 'from-config',
        dir: storeDir,
      }),
    );

    const plugin = wiretypeRecorder(); // zero options
    const logs: string[] = [];
    const fakeResolved = {
      mode: 'record',
      root: dir,
      logger: { warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) },
    };
    await (plugin.configResolved as unknown as (c: unknown) => Promise<void>)(fakeResolved);
    host = await hostMiddleware(plugin);

    const res = await fetch(`${host.url}/api/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'config' }),
    });
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 100));
    const store = new RecordingStore(storeDir);
    const rec = await store.load('from-config');
    expect(rec.exchanges).toHaveLength(1);
    expect(logs).toEqual([]);
  });

  it('stays inert (with a warning) when enabled but unconfigured', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wiretype-vite-'));
    const plugin = wiretypeRecorder();
    const warnings: string[] = [];
    const fakeResolved = {
      mode: 'record',
      root: dir, // no config file here
      logger: { warn: (m: string) => warnings.push(m), error: (m: string) => warnings.push(m) },
    };
    await (plugin.configResolved as unknown as (c: unknown) => Promise<void>)(fakeResolved);
    host = await hostMiddleware(plugin);

    const res = await fetch(`${host.url}/api/anything`);
    expect(res.status).toBe(404); // fell through to next()
    expect(await res.text()).toBe('fallthrough');
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('inert');
  });

  it('passes non-matching paths to next()', async () => {
    upstream = await startUpstream();
    dir = await mkdtemp(join(tmpdir(), 'wiretype-vite-'));
    const plugin = wiretypeRecorder({
      target: upstream.url,
      prefixes: ['/api'],
      enabled: true,
      dir,
      name: 'test',
    });
    host = await hostMiddleware(plugin);

    const res = await fetch(`${host.url}/other`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('fallthrough');
  });
});
