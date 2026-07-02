import { mkdir, readFile, writeFile, appendFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Exchange, Recording, RecordingMeta } from './types.js';

/**
 * NDJSON-backed store. Layout on disk:
 *   <dir>/<name>/meta.json          RecordingMeta
 *   <dir>/<name>/exchanges.ndjson   one Exchange per line
 */
export class RecordingStore {
  private readonly dir: string;
  /** Per-recording promise chain to serialize appends. */
  private readonly locks = new Map<string, Promise<void>>();

  constructor(dir: string) {
    this.dir = dir;
  }

  private recDir(name: string): string {
    return join(this.dir, name);
  }

  private metaPath(name: string): string {
    return join(this.recDir(name), 'meta.json');
  }

  private ndjsonPath(name: string): string {
    return join(this.recDir(name), 'exchanges.ndjson');
  }

  /** Create or open a recording. Existing recordings keep their exchanges. */
  async init(name: string, target: string): Promise<void> {
    await mkdir(this.recDir(name), { recursive: true });
    let meta: RecordingMeta | undefined;
    try {
      const raw = await readFile(this.metaPath(name), 'utf8');
      meta = JSON.parse(raw) as RecordingMeta;
    } catch {
      meta = undefined;
    }
    const now = Date.now();
    if (meta === undefined) {
      const created: RecordingMeta = {
        name,
        target,
        createdAt: now,
        updatedAt: now,
        exchangeCount: 0,
      };
      await writeFile(this.metaPath(name), JSON.stringify(created, null, 2), 'utf8');
      // Ensure the ndjson file exists (empty).
      await appendFile(this.ndjsonPath(name), '', 'utf8');
    } else {
      // Re-opening: refresh target + updatedAt but preserve createdAt/count.
      meta.target = target;
      meta.updatedAt = now;
      await writeFile(this.metaPath(name), JSON.stringify(meta, null, 2), 'utf8');
    }
  }

  /** Append an exchange and update meta (updatedAt, exchangeCount). Serialized. */
  async append(name: string, exchange: Exchange): Promise<void> {
    // Chain onto the previous append for this recording so concurrent appends
    // do not interleave. The tail stored in `locks` never rejects, so a failed
    // append cannot break the chain for subsequent callers.
    const prev = this.locks.get(name) ?? Promise.resolve();
    const run = prev.then(() => this.doAppend(name, exchange));
    this.locks.set(
      name,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async doAppend(name: string, exchange: Exchange): Promise<void> {
    await mkdir(this.recDir(name), { recursive: true });
    await appendFile(this.ndjsonPath(name), `${JSON.stringify(exchange)}\n`, 'utf8');
    let meta: RecordingMeta;
    try {
      const raw = await readFile(this.metaPath(name), 'utf8');
      meta = JSON.parse(raw) as RecordingMeta;
    } catch {
      const now = Date.now();
      meta = { name, target: '', createdAt: now, updatedAt: now, exchangeCount: 0 };
    }
    meta.exchangeCount = (meta.exchangeCount ?? 0) + 1;
    meta.updatedAt = Date.now();
    await writeFile(this.metaPath(name), JSON.stringify(meta, null, 2), 'utf8');
  }

  /** Load a full recording. Throws if the recording is missing. */
  async load(name: string): Promise<Recording> {
    let raw: string;
    try {
      raw = await readFile(this.metaPath(name), 'utf8');
    } catch {
      throw new Error(`Recording not found: ${name}`);
    }
    const meta = JSON.parse(raw) as RecordingMeta;

    const exchanges: Exchange[] = [];
    let content = '';
    try {
      content = await readFile(this.ndjsonPath(name), 'utf8');
    } catch {
      content = '';
    }
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        exchanges.push(JSON.parse(trimmed) as Exchange);
      } catch {
        // Skip corrupt lines tolerantly.
      }
    }
    return { meta, exchanges };
  }

  /** List recording metas sorted by updatedAt descending. */
  async list(): Promise<RecordingMeta[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return [];
    }
    const metas: RecordingMeta[] = [];
    for (const entry of entries) {
      const p = join(this.dir, entry);
      try {
        const st = await stat(p);
        if (!st.isDirectory()) continue;
        const raw = await readFile(join(p, 'meta.json'), 'utf8');
        metas.push(JSON.parse(raw) as RecordingMeta);
      } catch {
        // Not a recording dir; skip.
      }
    }
    metas.sort((a, b) => b.updatedAt - a.updatedAt);
    return metas;
  }

  /** Remove a recording directory entirely. */
  async remove(name: string): Promise<void> {
    await rm(this.recDir(name), { recursive: true, force: true });
    this.locks.delete(name);
  }
}
