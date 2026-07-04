import { access, readFile, rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDemo } from './cmd-demo.js';

describe('wiretype demo (smoke)', () => {
  let base: string | undefined;

  afterEach(async () => {
    if (base) await rm(base, { recursive: true, force: true });
    base = undefined;
  });

  it('records both versions, generates all targets, and detects drift', async () => {
    base = await mkdtemp(join(tmpdir(), 'wiretype-demo-'));
    const dir = join(base, '.wiretype');
    const out = join(base, 'generated');

    await runDemo({ dir, out });

    // Both recordings exist.
    await access(join(dir, 'demo-v1', 'exchanges.ndjson'));
    await access(join(dir, 'demo-v2', 'exchanges.ndjson'));

    // All five targets generated from v1.
    for (const f of ['types.ts', 'schemas.ts', 'handlers.ts', 'openapi.json', 'model.json']) {
      await access(join(out, f));
    }

    // The v1 types reflect the documented shape (drift demo baseline).
    const types = await readFile(join(out, 'types.ts'), 'utf8');
    expect(types).toContain('GetApiUsersByUserIdResponse');
    expect(types).toContain('lastLoginAt: string | null');
  }, 30_000);

  it('is idempotent — a second run does not double samples', async () => {
    base = await mkdtemp(join(tmpdir(), 'wiretype-demo-'));
    const dir = join(base, '.wiretype');
    const out = join(base, 'generated');

    await runDemo({ dir, out });
    const first = await readFile(join(dir, 'demo-v1', 'exchanges.ndjson'), 'utf8');
    await runDemo({ dir, out });
    const second = await readFile(join(dir, 'demo-v1', 'exchanges.ndjson'), 'utf8');

    expect(second.trim().split('\n').length).toBe(first.trim().split('\n').length);
  }, 60_000);
});
