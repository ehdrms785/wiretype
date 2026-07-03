import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RecordingStore, buildApiModel } from '../core/index.js';
import type { ApiModel } from '../core/index.js';
import { generateAll } from '../codegen/index.js';
import { parseTargets, renderTable } from './util.js';

export interface GenOptions {
  name: string;
  dir: string;
  out: string;
  targets: string;
  mswFixtures?: boolean;
}

export async function runGen(opts: GenOptions): Promise<void> {
  const targets = parseTargets(opts.targets);

  const store = new RecordingStore(opts.dir);
  const recording = await store.load(opts.name);
  const model = buildApiModel(recording);

  const files = generateAll(model, targets, { mswFixtures: opts.mswFixtures ?? false });

  await mkdir(opts.out, { recursive: true });
  for (const file of files) {
    const dest = join(opts.out, file.path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, file.content, 'utf8');
  }

  process.stdout.write(
    `wiretype gen → wrote ${files.length} file(s) to ${opts.out}\n` +
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
