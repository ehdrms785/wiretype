import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RecordingStore } from '../core/index.js';
import type { RecordingMeta } from '../core/index.js';
import { resolveRecordingName } from './cmd-gen.js';

function meta(name: string): RecordingMeta {
  return { name, target: 'http://x', createdAt: 0, updatedAt: 0, exchangeCount: 1 };
}

describe('resolveRecordingName', () => {
  it('explicit name always wins', () => {
    expect(resolveRecordingName([meta('a'), meta('b')], '.wiretype', 'b')).toBe('b');
    expect(resolveRecordingName([], '.wiretype', 'ghost')).toBe('ghost');
  });

  it('auto-picks the only recording (first-run UX: no --name needed)', () => {
    expect(resolveRecordingName([meta('vite')], '.wiretype')).toBe('vite');
  });

  it('errors helpfully with zero recordings', () => {
    expect(() => resolveRecordingName([], '.wiretype')).toThrow(/No recordings in .*wiretype/);
    expect(() => resolveRecordingName([], '.wiretype')).toThrow(/WIRETYPE=1 vite/);
  });

  it('errors listing names when multiple recordings exist', () => {
    expect(() => resolveRecordingName([meta('b'), meta('a')], '.wiretype')).toThrow(
      /Multiple recordings .*: a, b\. Pass --name/,
    );
  });
});

describe('RecordingStore gitignore', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('drops an ignore-everything .gitignore into the store dir on init', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wtstore-'));
    const store = new RecordingStore(join(dir, '.wiretype'));
    await store.init('session', 'http://x');
    const content = await readFile(join(dir, '.wiretype', '.gitignore'), 'utf8');
    expect(content).toContain('*');
  });
});
