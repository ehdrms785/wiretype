import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import {
  brotliDecompressSync,
  gunzipSync,
  inflateRawSync,
  inflateSync,
} from 'node:zlib';
import type { Plugin, ResolvedConfig, ViteDevServer, Connect } from 'vite';
import type { Exchange, RecorderOptions } from '../core/index.js';
import { RecordingStore } from '../core/index.js';
import {
  buildExchange,
  CappedBuffer,
  DEFAULT_MAX_BODY_BYTES,
  shouldRecord,
} from '../proxy/index.js';
import { loadConfig } from '../config/index.js';
import type { WiretypeConfig } from '../config/index.js';

export interface WiretypePluginOptions extends RecorderOptions {
  /**
   * Upstream API base URL, e.g. "http://localhost:8080".
   * Optional when `target` is set in wiretype.config.{mjs,js,json}.
   */
  target?: string;
  /**
   * Path prefixes to intercept+forward, e.g. ["/api"].
   * Optional when `prefixes` is set in wiretype.config.{mjs,js,json}.
   */
  prefixes?: string[];
  /** Recording name. Default "vite". */
  name?: string;
  /** Store directory. Default ".wiretype". */
  dir?: string;
  /**
   * Master switch. When omitted (the recommended setup), recording
   * auto-enables if the Vite dev server runs in mode "record"
   * (`vite --mode record`) OR the WIRETYPE env var is set. Set an explicit
   * boolean to override. This is what lets users avoid `WIRETYPE=1`: they
   * add the plugin unconditionally and run `vite --mode record`.
   */
  enabled?: boolean;
}

/**
 * Resolve the effective enabled flag: an explicit option always wins;
 * otherwise recording auto-enables in mode "record" or when the WIRETYPE
 * env var is set. Pure — exported for tests.
 */
export function resolveEnabled(
  explicit: boolean | undefined,
  mode: string,
  envSet: boolean,
): boolean {
  return explicit ?? (mode === 'record' || envSet);
}

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

function decodeEncoded(body: Buffer, encoding: string | undefined): Buffer {
  if (!encoding) return body;
  const enc = encoding.toLowerCase().trim();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return gunzipSync(body);
    if (enc === 'br') return brotliDecompressSync(body);
    if (enc === 'deflate') {
      try {
        return inflateSync(body);
      } catch {
        return inflateRawSync(body);
      }
    }
  } catch {
    // keep raw
  }
  return body;
}

function resolveTarget(target: string, reqUrl: string): URL {
  const base = new URL(target);
  const incoming = new URL(reqUrl, 'http://placeholder');
  const basePath = base.pathname.replace(/\/+$/, '');
  return new URL(basePath + incoming.pathname + incoming.search, base);
}

export default function wiretypeRecorder(options: WiretypePluginOptions = {}): Plugin {
  // All of these may be overlaid by wiretype.config in configResolved
  // (explicit plugin options always win; config fills the gaps).
  let enabled = resolveEnabled(options.enabled, '', !!process.env.WIRETYPE);
  let target = options.target;
  let prefixes = options.prefixes;
  let name = options.name ?? 'vite';
  let dir = options.dir ?? '.wiretype';
  let recorderOpts: RecorderOptions = {
    includePrefixes: options.includePrefixes,
    excludePrefixes: options.excludePrefixes,
    maxBodyBytes: options.maxBodyBytes,
    redactHeaders: options.redactHeaders,
  };
  let maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  let store: RecordingStore | undefined;
  let initialized: Promise<void> | undefined;

  const ensureStore = (): Promise<void> => {
    if (!store) store = new RecordingStore(dir);
    if (!initialized) initialized = store.init(name, target ?? '');
    return initialized;
  };

  const matchesPrefix = (path: string): boolean =>
    (prefixes ?? []).some((prefix) => path.startsWith(prefix));

  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const rawUrl = req.url ?? '/';
    const path = rawUrl.split('?')[0] ?? rawUrl;

    if (!enabled || target === undefined || !matchesPrefix(path)) {
      next();
      return;
    }

    const startedAt = Date.now();
    const method = req.method ?? 'GET';

    let resolved: URL;
    try {
      resolved = resolveTarget(target, rawUrl);
    } catch {
      send502(res, 'invalid target');
      return;
    }

    const isHttps = resolved.protocol === 'https:';
    const transport = isHttps ? https : http;

    const forwardHeaders = stripHopByHop(req.headers);
    forwardHeaders['host'] = resolved.host;

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
        res.writeHead(status, resHeaders);

        // Bounded capture: long-lived streams (SSE, large downloads) pass
        // through untouched but never grow the capture buffer past the cap.
        const resCapture = new CappedBuffer(maxBodyBytes);

        upstreamRes.on('data', (chunk: Buffer) => {
          res.write(chunk);
          if (willRecord) resCapture.push(chunk);
        });
        upstreamRes.on('end', () => {
          res.end();
          const endedAt = Date.now();

          if (!willRecord) return;

          const rawBody: Buffer = resCapture.buffer();
          const encoding = upstreamRes.headers['content-encoding'];
          const encStr = Array.isArray(encoding) ? encoding[0] : encoding;
          const capturedBody: Buffer = decodeEncoded(rawBody, encStr);

          const captureResHeaders: Record<string, string | string[] | undefined> = {
            ...upstreamRes.headers,
          };
          delete captureResHeaders['content-encoding'];
          delete captureResHeaders['content-length'];

          void record({
            method,
            url: rawUrl,
            reqHeaders: req.headers,
            reqBody: reqCapture.buffer(),
            status,
            resHeaders: captureResHeaders,
            resBody: capturedBody,
            startedAt,
            endedAt,
          });
        });
        upstreamRes.on('error', () => {
          if (!res.writableEnded) res.end();
        });
      },
    );

    upstreamReq.on('error', (err: Error) => {
      send502(res, err.message);
    });

    req.on('error', () => {
      upstreamReq.destroy();
    });

    if (willRecord) {
      req.on('data', (chunk: Buffer) => reqCapture.push(chunk));
    }
    req.pipe(upstreamReq);
  };

  const record = async (input: {
    method: string;
    url: string;
    reqHeaders: Record<string, string | string[] | undefined>;
    reqBody: Buffer;
    status: number;
    resHeaders: Record<string, string | string[] | undefined>;
    resBody: Buffer;
    startedAt: number;
    endedAt: number;
  }): Promise<void> => {
    try {
      await ensureStore();
      const exchange: Exchange = buildExchange({ ...input, opts: recorderOpts });
      await store!.append(name, exchange);
    } catch {
      // Recording failures must never break the dev server.
    }
  };

  return {
    name: 'wiretype-recorder',
    async configResolved(config: ResolvedConfig) {
      enabled = resolveEnabled(options.enabled, config.mode, !!process.env.WIRETYPE);

      // Overlay wiretype.config.{mjs,js,json} from the Vite root: explicit
      // plugin options win, config fills the gaps. A malformed config must
      // never take the dev server down when the recorder is inert.
      let cfg: WiretypeConfig | undefined;
      try {
        cfg = (await loadConfig(config.root))?.config;
      } catch (err) {
        if (enabled) {
          const message = err instanceof Error ? err.message : String(err);
          config.logger.error(`[wiretype] ${message}`);
        }
        cfg = undefined;
      }
      if (cfg) {
        target = options.target ?? cfg.target;
        prefixes = options.prefixes ?? cfg.prefixes;
        if (options.name === undefined && cfg.name !== undefined) name = cfg.name;
        if (options.dir === undefined && cfg.dir !== undefined) dir = cfg.dir;
        recorderOpts = {
          includePrefixes: options.includePrefixes ?? cfg.includePrefixes,
          excludePrefixes: options.excludePrefixes ?? cfg.excludePrefixes,
          maxBodyBytes: options.maxBodyBytes ?? cfg.maxBodyBytes,
          redactHeaders: options.redactHeaders ?? cfg.redactHeaders,
        };
        maxBodyBytes = recorderOpts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
      }

      if (enabled && (target === undefined || (prefixes ?? []).length === 0)) {
        config.logger.warn(
          '[wiretype] recording requested but no target/prefixes configured ' +
            '(pass plugin options or add them to wiretype.config) — recorder stays inert.',
        );
        enabled = false;
      }
    },
    configureServer(server: ViteDevServer) {
      server.middlewares.use(middleware);
    },
  };
}

function send502(res: ServerResponse, message: string): void {
  if (res.headersSent || res.writableEnded) {
    if (!res.writableEnded) res.end();
    return;
  }
  res.writeHead(502, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'Bad Gateway', message }));
}
