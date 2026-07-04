import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
  inflateRawSync,
} from 'node:zlib';
import type { Socket } from 'node:net';
import type { Exchange, RecorderOptions } from '../core/index.js';
import { buildExchange, CappedBuffer, DEFAULT_MAX_BODY_BYTES, shouldRecord } from './capture.js';

export interface ProxyServerOptions extends RecorderOptions {
  /** Upstream base URL. May include a path prefix. */
  target: string;
  /** Listen port. */
  port: number;
  /** Called for every recorded exchange. Awaited-but-fire-safe. */
  onExchange: (ex: Exchange) => void | Promise<void>;
  onError?: (err: Error) => void;
  /** Also print a compact line per request to stdout. Default true. */
  quiet?: boolean;
}

export interface RunningProxy {
  port: number;
  close(): Promise<void>;
}

/** Hop-by-hop headers that must never be forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
]);

function stripHopByHop(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower.startsWith('proxy-')) continue;
    out[key] = value;
  }
  return out;
}

/** Decode a captured body copy given a content-encoding. Never throws. */
function decodeEncoded(body: Buffer, encoding: string | undefined): Buffer {
  if (!encoding) return body;
  const enc = encoding.toLowerCase().trim();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return gunzipSync(body);
    if (enc === 'br') return brotliDecompressSync(body);
    if (enc === 'deflate') {
      // Try zlib-wrapped first, fall back to raw.
      try {
        return inflateSync(body);
      } catch {
        return inflateRawSync(body);
      }
    }
  } catch {
    // Corrupt / unexpected data: keep raw so at least something is captured.
  }
  return body;
}

/**
 * Join a target base URL (which may include a path prefix) with the incoming
 * request URL (path + query). Returns { url, host } components for the request.
 */
function resolveTarget(target: string, reqUrl: string): URL {
  const base = new URL(target);
  const incoming = new URL(reqUrl, 'http://placeholder');
  // Join base path prefix with incoming path.
  const basePath = base.pathname.replace(/\/+$/, ''); // trim trailing slash
  const joinedPath = basePath + incoming.pathname;
  const resolved = new URL(joinedPath + incoming.search, base);
  return resolved;
}

/** Zero-dependency reverse proxy on node:http. */
export function startProxy(opts: ProxyServerOptions): Promise<RunningProxy> {
  const quiet = opts.quiet ?? true;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const recorderOpts: RecorderOptions = {
    includePrefixes: opts.includePrefixes,
    excludePrefixes: opts.excludePrefixes,
    maxBodyBytes: opts.maxBodyBytes,
    redactHeaders: opts.redactHeaders,
  };

  const reportError = (err: unknown): void => {
    if (opts.onError) {
      opts.onError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const emitExchange = (ex: Exchange): void => {
    try {
      const maybe = opts.onExchange(ex);
      if (maybe && typeof (maybe as Promise<void>).then === 'function') {
        (maybe as Promise<void>).catch(reportError);
      }
    } catch (err) {
      reportError(err);
    }
  };

  const handle = (clientReq: IncomingMessage, clientRes: ServerResponse): void => {
    const startedAt = Date.now();
    const method = clientReq.method ?? 'GET';
    const reqUrl = clientReq.url ?? '/';

    let resolved: URL;
    try {
      resolved = resolveTarget(opts.target, reqUrl);
    } catch (err) {
      reportError(err);
      send502(clientRes, 'invalid target');
      return;
    }

    const isHttps = resolved.protocol === 'https:';
    const transport = isHttps ? https : http;

    const forwardHeaders = stripHopByHop(clientReq.headers);
    forwardHeaders['host'] = resolved.host;

    const path = reqUrl.split('?')[0] ?? reqUrl;
    const willRecord = shouldRecord(path, recorderOpts);

    // Capture a bounded copy of the request body while STREAMING the full
    // body to upstream — never forward a truncated body.
    const reqCapture = new CappedBuffer(maxBodyBytes);

    const upstreamReq = transport.request(
      {
        protocol: resolved.protocol,
        hostname: resolved.hostname,
        port: resolved.port || (isHttps ? 443 : 80),
        method,
        path: resolved.pathname + resolved.search,
        headers: forwardHeaders,
      },
      (upstreamRes: IncomingMessage) => {
        const status = upstreamRes.statusCode ?? 502;
        const resHeaders = stripHopByHop(upstreamRes.headers);

        // Stream raw bytes back to the client byte-for-byte while
        // buffering a bounded copy for capture.
        clientRes.writeHead(status, resHeaders);

        const resCapture = new CappedBuffer(maxBodyBytes);

        upstreamRes.on('data', (chunk: Buffer) => {
          clientRes.write(chunk);
          if (willRecord) resCapture.push(chunk);
        });

        upstreamRes.on('end', () => {
          clientRes.end();
          const endedAt = Date.now();

          if (!quiet) {
            process.stdout.write(
              `${method} ${path} ${status} ${endedAt - startedAt}ms\n`,
            );
          }

          if (!willRecord) return;

          // Decode a copy AFTER response completes, in try/catch.
          const rawResBody: Buffer = resCapture.buffer();
          const encoding = upstreamRes.headers['content-encoding'];
          const encStr = Array.isArray(encoding) ? encoding[0] : encoding;
          let capturedResBody: Buffer = rawResBody;
          try {
            capturedResBody = decodeEncoded(rawResBody, encStr);
          } catch (err) {
            reportError(err);
          }

          // Present decoded headers to buildExchange (drop content-encoding
          // so the captured text isn't mistaken for compressed bytes).
          const captureResHeaders: Record<string, string | string[] | undefined> = {
            ...upstreamRes.headers,
          };
          delete captureResHeaders['content-encoding'];
          delete captureResHeaders['content-length'];

          try {
            const exchange = buildExchange({
              method,
              url: reqUrl,
              reqHeaders: clientReq.headers,
              reqBody: reqCapture.buffer(),
              status,
              resHeaders: captureResHeaders,
              resBody: capturedResBody,
              startedAt,
              endedAt,
              opts: recorderOpts,
            });
            emitExchange(exchange);
          } catch (err) {
            reportError(err);
          }
        });

        upstreamRes.on('error', (err) => {
          reportError(err);
          if (!clientRes.writableEnded) clientRes.end();
        });
      },
    );

    upstreamReq.on('error', (err) => {
      reportError(err);
      send502(clientRes, err.message);
    });

    clientReq.on('error', (err) => {
      reportError(err);
      upstreamReq.destroy(err);
    });

    if (willRecord) {
      clientReq.on('data', (chunk: Buffer) => reqCapture.push(chunk));
    }
    clientReq.pipe(upstreamReq);
  };

  const server = http.createServer(handle);

  // WebSocket / other upgrades: destroy cleanly, never crash.
  server.on('upgrade', (_req: IncomingMessage, socket: Socket) => {
    try {
      socket.destroy();
    } catch {
      // ignore
    }
  });

  server.on('clientError', (err: Error, socket: Socket) => {
    reportError(err);
    try {
      if (socket.writable) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      } else {
        socket.destroy();
      }
    } catch {
      // ignore
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, () => {
      server.removeListener('error', reject);
      const address = server.address();
      const actualPort =
        typeof address === 'object' && address !== null ? address.port : opts.port;
      resolve({
        port: actualPort,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

function send502(res: ServerResponse, message: string): void {
  if (res.headersSent || res.writableEnded) {
    if (!res.writableEnded) res.end();
    return;
  }
  const body = JSON.stringify({ error: 'Bad Gateway', message });
  res.writeHead(502, { 'content-type': 'application/json' });
  res.end(body);
}
