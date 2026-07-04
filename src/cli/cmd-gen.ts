import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { RecordingStore, buildApiModel } from '../core/index.js';
import type { ApiModel, RecordingMeta } from '../core/index.js';
import { generateAll } from '../codegen/index.js';
import { parseTargets, renderTable } from './util.js';

export interface GenOptions {
  /** Recording name. When omitted, the store's ONLY recording is used. */
  name?: string;
  dir: string;
  out: string;
  targets: string;
  mswFixtures?: boolean;
}

/**
 * Resolve which recording to generate from. Explicit name wins; otherwise a
 * store with exactly one recording needs no flag at all (the common
 * first-run case — the vite plugin records as "vite", `wiretype record` as
 * "session", and the user shouldn't have to know that).
 */
export function resolveRecordingName(
  metas: RecordingMeta[],
  dir: string,
  name?: string,
): string {
  if (name !== undefined) return name;
  if (metas.length === 1) return metas[0]!.name;
  if (metas.length === 0) {
    throw new Error(
      `No recordings in ${resolve(dir)}. Record traffic first ` +
        `(Vite plugin: WIRETYPE=1 vite, or: wiretype record --target <url>). ` +
        `In monorepos, run from the app directory or pass --dir.`,
    );
  }
  const names = metas.map((m) => m.name).sort();
  throw new Error(
    `Multiple recordings in ${resolve(dir)}: ${names.join(', ')}. Pass --name <recording>.`,
  );
}

export async function runGen(opts: GenOptions): Promise<void> {
  const targets = parseTargets(opts.targets);

  const store = new RecordingStore(opts.dir);
  const name = resolveRecordingName(await store.list(), opts.dir, opts.name);
  const recording = await store.load(name);
  const model = buildApiModel(recording);

  const files = generateAll(model, targets, { mswFixtures: opts.mswFixtures ?? false });

  await mkdir(opts.out, { recursive: true });
  for (const file of files) {
    const dest = join(opts.out, file.path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, file.content, 'utf8');
  }

  process.stdout.write(
    `wiretype gen → recording "${name}" → wrote ${files.length} file(s) to ${opts.out}\n` +
      files.map((f) => `  ${join(opts.out, f.path)}`).join('\n') +
      '\n\n',
  );

  process.stdout.write(renderSummary(model) + '\n');
}

function renderSummary(model: ApiModel): string {
  const methods: string[] = [];
  const patterns: string[] = [];
  const statuses: string[] = [];
  const samples: string[] = [];

  for (const ep of model.endpoints) {
    methods.push(ep.method);
    patterns.push(ep.pattern);
    statuses.push(ep.responses.map((r) => String(r.status)).join(','));
    const sampleCount = ep.responses.reduce((sum, r) => sum + r.count, 0);
    samples.push(String(sampleCount));
  }

  return renderTable([
    { header: 'METHOD', values: methods },
    { header: 'PATTERN', values: patterns },
    { header: 'STATUSES', values: statuses },
    { header: 'SAMPLES', values: samples },
  ]);
}
