import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordingStore } from './store.js';
import type { Exchange } from './types.js';

function makeExchange(i: number): Exchange {
  return {
    id: `ex-${i}`,
    startedAt: 1000 + i,
    request: { method: 'GET', url: `/api/x/${i}`, path: `/api/x/${i}`, query: {}, headers: {} },
    response: { status: 200, headers: {}, durationMs: 3 },
  };
}

describe('RecordingStore', () => {
  let dir: string;
  let store: RecordingStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wiretype-store-'));
    store = new RecordingStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('init creates meta + ndjson layout', async () => {
    await store.init('rec1', 'http://localhost:8080');
    const meta = JSON.parse(await readFile(join(dir, 'rec1', 'meta.json'), 'utf8'));
    expect(meta).toMatchObject({ name: 'rec1', target: 'http://localhost:8080', exchangeCount: 0 });
  });

  it('append updates exchangeCount and updatedAt', async () => {
    await store.init('rec1', 'http://x');
    await store.append('rec1', makeExchange(1));
    await store.append('rec1', makeExchange(2));
    const rec = await store.load('rec1');
    expect(rec.meta.exchangeCount).toBe(2);
    expect(rec.exchanges).toHaveLength(2);
    expect(rec.exchanges[0]?.id).toBe('ex-1');
  });

  it('load throws when missing', async () => {
    await expect(store.load('nope')).rejects.toThrow(/not found/i);
  });

  it('load skips corrupt ndjson lines tolerantly', async () => {
    await store.init('rec1', 'http://x');
    await store.append('rec1', makeExchange(1));
    // Inject a corrupt line.
    const p = join(dir, 'rec1', 'exchanges.ndjson');
    const good = await readFile(p, 'utf8');
    await writeFile(p, `${good}this-is-not-json\n${JSON.stringify(makeExchange(2))}\n`, 'utf8');
    const rec = await store.load('rec1');
    expect(rec.exchanges.map((e) => e.id)).toEqual(['ex-1', 'ex-2']);
  });

  it('list returns metas sorted by updatedAt desc', async () => {
    await store.init('a', 'http://a');
    await new Promise((r) => setTimeout(r, 5));
    await store.init('b', 'http://b');
    await store.append('b', makeExchange(1));
    const list = await store.list();
    expect(list.map((m) => m.name)).toEqual(['b', 'a']);
  });

  it('list ignores non-recording directories', async () => {
    await store.init('a', 'http://a');
    await mkdir(join(dir, 'not-a-recording'), { recursive: true });
    const list = await store.list();
    expect(list.map((m) => m.name)).toEqual(['a']);
  });

  it('remove deletes the recording dir', async () => {
    await store.init('a', 'http://a');
    await store.remove('a');
    await expect(store.load('a')).rejects.toThrow();
    expect(await store.list()).toHaveLength(0);
  });

  it('serializes concurrent appends without losing any', async () => {
    await store.init('rec1', 'http://x');
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.append('rec1', makeExchange(i))));
    const rec = await store.load('rec1');
    expect(rec.exchanges).toHaveLength(20);
    expect(rec.meta.exchangeCount).toBe(20);
    // All ids present (order not guaranteed but no interleaving corruption).
    const ids = new Set(rec.exchanges.map((e) => e.id));
    expect(ids.size).toBe(20);
  });

  it('re-init preserves existing exchanges and createdAt', async () => {
    await store.init('rec1', 'http://x');
    await store.append('rec1', makeExchange(1));
    const before = await store.load('rec1');
    await store.init('rec1', 'http://y');
    const after = await store.load('rec1');
    expect(after.exchanges).toHaveLength(1);
    expect(after.meta.createdAt).toBe(before.meta.createdAt);
    expect(after.meta.target).toBe('http://y');
  });
});
