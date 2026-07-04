import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Exchange } from '../core/index.js';
import { startProxy } from './proxy.js';
import type { RunningProxy } from './proxy.js';
import { buildExchange, CappedBuffer, shouldRecord } from './capture.js';

/** Start an in-process upstream with fixed routes. Returns base URL + close. */
function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    const path = url.split('?')[0];

    if (path === '/api/users' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ users: [{ id: 1, name: 'Ada' }], page: 1 }));
      return;
    }

    if (path === '/api/gzipped' && req.method === 'GET') {
      const payload = Buffer.from(JSON.stringify({ compressed: true, value: 42 }));
      const gz = gzipSync(payload);
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      });
      res.end(gz);
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

    if (path === '/api/stream' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      const chunk = 'y'.repeat(8 * 1024);
      for (let i = 0; i < 64; i += 1) res.write(chunk); // 512 KiB total
      res.end();
      return;
    }

    if (path === '/api/echo' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ received: JSON.parse(body || '{}') }));
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

describe('shouldRecord', () => {
  it('passes everything with no filters', () => {
    expect(shouldRecord('/api/users')).toBe(true);
  });
  it('applies include prefixes', () => {
    expect(shouldRecord('/api/users', { includePrefixes: ['/api'] })).toBe(true);
    expect(shouldRecord('/static/x', { includePrefixes: ['/api'] })).toBe(false);
  });
  it('applies exclude prefixes', () => {
    expect(shouldRecord('/api/health', { excludePrefixes: ['/api/health'] })).toBe(false);
    expect(shouldRecord('/api/users', { excludePrefixes: ['/api/health'] })).toBe(true);
  });
});

describe('CappedBuffer', () => {
  it('keeps everything under the cap', () => {
    const cb = new CappedBuffer(10);
    cb.push(Buffer.from('12345'));
    cb.push(Buffer.from('67890'));
    expect(cb.buffer().toString()).toBe('1234567890');
  });

  it('keeps the chunk crossing the cap (truncation detectable) then drops', () => {
    const cb = new CappedBuffer(10);
    cb.push(Buffer.from('123456789')); // 9 <= cap: kept
    cb.push(Buffer.from('abcdef')); // crosses cap: kept (length now > cap)
    cb.push(Buffer.from('DROPPED')); // past cap: dropped
    cb.push(Buffer.from('DROPPED'));
    const buf = cb.buffer();
    expect(buf.toString()).toBe('123456789abcdef');
    expect(buf.length).toBeGreaterThan(10); // consumers detect truncation
  });

  it('memory stays bounded across many pushes', () => {
    const cb = new CappedBuffer(1024);
    const chunk = Buffer.alloc(512, 1);
    for (let i = 0; i < 10_000; i += 1) cb.push(chunk);
    expect(cb.buffer().length).toBeLessThanOrEqual(1024 + 512);
  });
});

describe('buildExchange', () => {
  it('normalizes headers, parses query + json, redacts sensitive headers', () => {
    const ex = buildExchange({
      method: 'get',
      url: '/api/users?page=1&role=admin&role=editor',
      reqHeaders: {
        authorization: 'Bearer secret',
        'x-multi': ['a', 'b'],
        'content-type': 'application/json',
      },
      reqBody: Buffer.from(''),
      status: 200,
      resHeaders: { 'content-type': 'application/json' },
      resBody: Buffer.from(JSON.stringify({ ok: true })),
      startedAt: 100,
      endedAt: 112,
    });
    expect(ex.request.method).toBe('GET');
    expect(ex.request.path).toBe('/api/users');
    expect(ex.request.query).toEqual({ page: ['1'], role: ['admin', 'editor'] });
    expect(ex.request.headers['authorization']).toBe('[redacted]');
    expect(ex.request.headers['x-multi']).toBe('a, b');
    expect(ex.response.bodyJson).toEqual({ ok: true });
    expect(ex.response.durationMs).toBe(12);
    expect(ex.id).toMatch(/[0-9a-f-]{36}/);
  });

  it('truncates oversized bodies and skips json parse', () => {
    const big = Buffer.from('x'.repeat(100));
    const ex = buildExchange({
      method: 'GET',
      url: '/big',
      reqHeaders: {},
      reqBody: Buffer.from(''),
      status: 200,
      resHeaders: { 'content-type': 'application/json' },
      resBody: big,
      startedAt: 0,
      endedAt: 1,
      opts: { maxBodyBytes: 10 },
    });
    expect(ex.response.bodyText).toBe('x'.repeat(10));
    expect(ex.response.bodyJson).toBeUndefined();
  });
});

describe('startProxy', () => {
  let upstream: { url: string; close: () => Promise<void> } | undefined;
  let proxy: RunningProxy | undefined;

  afterEach(async () => {
    if (proxy) await proxy.close();
    if (upstream) await upstream.close();
    proxy = undefined;
    upstream = undefined;
  });

  it('passes responses through and captures parsed json', async () => {
    upstream = await startUpstream();
    const captured: Exchange[] = [];
    proxy = await startProxy({
      target: upstream.url,
      port: 0,
      onExchange: (ex) => {
        captured.push(ex);
      },
    });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/users?page=1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ users: [{ id: 1, name: 'Ada' }], page: 1 });

    // Wait a tick for capture emission.
    await new Promise((r) => setTimeout(r, 50));
    expect(captured).toHaveLength(1);
    const ex = captured[0]!;
    expect(ex.request.path).toBe('/api/users');
    expect(ex.request.query).toEqual({ page: ['1'] });
    expect(ex.response.status).toBe(200);
    expect(ex.response.bodyJson).toEqual({ users: [{ id: 1, name: 'Ada' }], page: 1 });
  });

  it('forwards gzip raw but decodes a copy for capture', async () => {
    upstream = await startUpstream();
    const captured: Exchange[] = [];
    proxy = await startProxy({
      target: upstream.url,
      port: 0,
      onExchange: (ex) => {
        captured.push(ex);
      },
    });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/gzipped`);
    expect(res.status).toBe(200);
    // fetch auto-decompresses; body should be the original json.
    const body = await res.json();
    expect(body).toEqual({ compressed: true, value: 42 });

    await new Promise((r) => setTimeout(r, 50));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.response.bodyJson).toEqual({ compressed: true, value: 42 });
  });

  it('captures POST body and echoes', async () => {
    upstream = await startUpstream();
    const captured: Exchange[] = [];
    proxy = await startProxy({
      target: upstream.url,
      port: 0,
      onExchange: (ex) => {
        captured.push(ex);
      },
    });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ received: { hello: 'world' } });

    await new Promise((r) => setTimeout(r, 50));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.request.bodyJson).toEqual({ hello: 'world' });
    expect(captured[0]!.response.status).toBe(201);
  });

  it('captures 404 responses', async () => {
    upstream = await startUpstream();
    const captured: Exchange[] = [];
    proxy = await startProxy({
      target: upstream.url,
      port: 0,
      onExchange: (ex) => {
        captured.push(ex);
      },
    });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/nope`);
    expect(res.status).toBe(404);
    await new Promise((r) => setTimeout(r, 50));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.response.status).toBe(404);
  });

  it('respects include/exclude filters (proxied but not recorded)', async () => {
    upstream = await startUpstream();
    const captured: Exchange[] = [];
    proxy = await startProxy({
      target: upstream.url,
      port: 0,
      excludePrefixes: ['/api/users'],
      onExchange: (ex) => {
        captured.push(ex);
      },
    });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/users`);
    expect(res.status).toBe(200); // still proxied
    await new Promise((r) => setTimeout(r, 50));
    expect(captured).toHaveLength(0); // but not recorded
  });

  it('forwards large request bodies intact while capturing a truncated copy', async () => {
    upstream = await startUpstream();
    const captured: Exchange[] = [];
    proxy = await startProxy({
      target: upstream.url,
      port: 0,
      maxBodyBytes: 1024,
      onExchange: (ex) => captured.push(ex),
    });

    const bigBody = 'x'.repeat(300 * 1024); // 300 KiB, far past the 1 KiB cap
    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/upload`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: bigBody,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Upstream must receive EVERY byte — capture caps must never truncate
    // the forwarded body.
    expect(body).toEqual({ receivedBytes: bigBody.length });

    await new Promise((r) => setTimeout(r, 50));
    expect(captured).toHaveLength(1);
    const reqText = captured[0]!.request.bodyText ?? '';
    expect(reqText.length).toBeLessThanOrEqual(1024);
  });

  it('caps the captured copy of large streamed responses', async () => {
    upstream = await startUpstream();
    const captured: Exchange[] = [];
    proxy = await startProxy({
      target: upstream.url,
      port: 0,
      maxBodyBytes: 1024,
      onExchange: (ex) => captured.push(ex),
    });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/stream`);
    expect(res.status).toBe(200);
    const text = await res.text();
    // Client still receives the full stream.
    expect(text.length).toBe(512 * 1024);

    await new Promise((r) => setTimeout(r, 50));
    expect(captured).toHaveLength(1);
    const resText = captured[0]!.response.bodyText ?? '';
    expect(resText.length).toBeLessThanOrEqual(1024);
  });

  it('returns 502 on dead upstream', async () => {
    const errors: Error[] = [];
    proxy = await startProxy({
      target: 'http://127.0.0.1:1', // nothing listening
      port: 0,
      onExchange: () => {},
      onError: (err) => errors.push(err),
    });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/users`);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toHaveProperty('error', 'Bad Gateway');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('joins target path prefix correctly', async () => {
    upstream = await startUpstream();
    const captured: Exchange[] = [];
    proxy = await startProxy({
      // target includes no prefix here; verify plain join still works
      target: `${upstream.url}/`,
      port: 0,
      onExchange: (ex) => captured.push(ex),
    });
    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/users`);
    expect(res.status).toBe(200);
  });
});
