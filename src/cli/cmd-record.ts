import { RecordingStore } from '../core/index.js';
import type { Exchange } from '../core/index.js';
import { startProxy } from '../proxy/index.js';

export interface RecordOptions {
  target: string;
  port: string;
  name: string;
  dir: string;
  include?: string[];
  exclude?: string[];
}

export async function runRecord(opts: RecordOptions): Promise<void> {
  const port = Number.parseInt(opts.port, 10);
  if (Number.isNaN(port)) {
    throw new Error(`Invalid --port: ${opts.port}`);
  }

  const store = new RecordingStore(opts.dir);
  await store.init(opts.name, opts.target);

  let count = 0;
  const endpoints = new Set<string>();

  const proxy = await startProxy({
    target: opts.target,
    port,
    includePrefixes: opts.include,
    excludePrefixes: opts.exclude,
    quiet: true,
    onExchange: async (ex: Exchange) => {
      await store.append(opts.name, ex);
      count += 1;
      endpoints.add(`${ex.request.method} ${ex.request.path}`);
      process.stdout.write(
        `${ex.request.method} ${ex.request.path} ${ex.response.status} ` +
          `${ex.response.durationMs}ms (${count} exchanges)\n`,
      );
    },
    onError: (err) => {
      process.stderr.write(`wiretype record error: ${err.message}\n`);
    },
  });

  process.stdout.write(
    `wiretype record → proxy on http://localhost:${proxy.port} → ${opts.target}\n` +
      `  recording "${opts.name}" in ${opts.dir}  (Ctrl-C to stop)\n`,
  );

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      void proxy.close().then(() => {
        process.stdout.write(
          `\nwiretype record stopped.\n` +
            `  total exchanges: ${count}\n` +
            `  distinct endpoints: ${endpoints.size}\n`,
        );
        resolve();
      });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
