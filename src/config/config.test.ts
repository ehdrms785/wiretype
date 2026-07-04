import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { defineConfig, loadConfig } from './index.js';
import { layerConfig } from '../cli/util.js';

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_URL = pathToFileURL(join(HERE, 'index.ts')).href;
const REPO_ROOT = join(HERE, '..', '..');

/**
 * Run loadConfig in a REAL Node process (via tsx). The vitest runner executes
 * modules inside a vm without a dynamic-import callback, so the .mjs/.js
 * loading path (which must escape bundler rewriting by design) can only be
 * exercised authentically in a subprocess — exactly how the CLI and the Vite
 * dev server run in production.
 */
async function loadInRealNode(dir: string): Promise<Record<string, unknown> | null> {
  const script = [
    `const { loadConfig } = await import(${JSON.stringify(SRC_URL)});`,
    `const loaded = await loadConfig(${JSON.stringify(dir)});`,
    `process.stdout.write(JSON.stringify(loaded ? loaded.config : null));`,
  ].join('\n');
  const { stdout } = await execFileP(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    { cwd: REPO_ROOT },
  );
  return JSON.parse(stdout) as Record<string, unknown> | null;
}

describe('loadConfig', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('returns null when no config file exists', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wtcfg-'));
    expect(await loadConfig(dir)).toBeNull();
  });

  it('loads wiretype.config.json', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wtcfg-'));
    await writeFile(
      join(dir, 'wiretype.config.json'),
      JSON.stringify({ target: 'http://localhost:8080', prefixes: ['/api'], dir: '.wt' }),
    );
    const loaded = await loadConfig(dir);
    expect(loaded?.config.target).toBe('http://localhost:8080');
    expect(loaded?.config.prefixes).toEqual(['/api']);
    expect(loaded?.path).toContain('wiretype.config.json');
  });

  it('loads wiretype.config.mjs with a defineConfig default export (real node)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wtcfg-'));
    await writeFile(
      join(dir, 'wiretype.config.mjs'),
      `export default { target: 'http://localhost:9090', name: 'from-mjs' };\n`,
    );
    const config = await loadInRealNode(dir);
    expect(config).toEqual({ target: 'http://localhost:9090', name: 'from-mjs' });
  }, 30_000);

  it('prefers .mjs over .json when both exist (real node)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wtcfg-'));
    await writeFile(join(dir, 'wiretype.config.mjs'), `export default { name: 'mjs' };\n`);
    await writeFile(join(dir, 'wiretype.config.json'), JSON.stringify({ name: 'json' }));
    const config = await loadInRealNode(dir);
    expect(config?.name).toBe('mjs');
  }, 30_000);

  it('throws loudly on malformed JSON', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wtcfg-'));
    await writeFile(join(dir, 'wiretype.config.json'), '{ not json');
    await expect(loadConfig(dir)).rejects.toThrow(/Failed to parse/);
  });

  it('throws when the module has no default export (real node)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wtcfg-'));
    await writeFile(join(dir, 'wiretype.config.mjs'), `export const nope = 1;\n`);
    await expect(loadInRealNode(dir)).rejects.toThrow(/default export/);
  }, 30_000);
});

describe('defineConfig', () => {
  it('is an identity helper', () => {
    const cfg = { target: 'http://x', prefixes: ['/api'] };
    expect(defineConfig(cfg)).toBe(cfg);
  });
});

describe('layerConfig', () => {
  const opts = { dir: '.wiretype', name: 'session', out: 'generated' };

  it('config fills non-explicit options', () => {
    const merged = layerConfig(opts, () => false, { dir: '.custom', name: 'cfg' });
    expect(merged).toEqual({ dir: '.custom', name: 'cfg', out: 'generated' });
  });

  it('explicit CLI flags beat config', () => {
    const merged = layerConfig(opts, (k) => k === 'dir', { dir: '.custom', name: 'cfg' });
    expect(merged.dir).toBe('.wiretype');
    expect(merged.name).toBe('cfg');
  });

  it('undefined config values never overwrite', () => {
    const merged = layerConfig(opts, () => false, { dir: undefined });
    expect(merged.dir).toBe('.wiretype');
  });
});
