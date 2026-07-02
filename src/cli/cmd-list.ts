import { RecordingStore } from '../core/index.js';
import { formatTimestamp, renderTable } from './util.js';

export interface ListOptions {
  dir: string;
}

export async function runList(opts: ListOptions): Promise<void> {
  const store = new RecordingStore(opts.dir);
  const recordings = await store.list();

  if (recordings.length === 0) {
    process.stdout.write(`No recordings found in ${opts.dir}\n`);
    return;
  }

  const table = renderTable([
    { header: 'NAME', values: recordings.map((r) => r.name) },
    { header: 'TARGET', values: recordings.map((r) => r.target) },
    { header: 'EXCHANGES', values: recordings.map((r) => String(r.exchangeCount)) },
    { header: 'UPDATED', values: recordings.map((r) => formatTimestamp(r.updatedAt)) },
  ]);

  process.stdout.write(table + '\n');
}
