import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RecordingStore, inferShape } from '../core/index.js';
import type { Exchange } from '../core/index.js';
import { startUiServer } from './cmd-ui.js';
import type { RunningUi } from './cmd-ui.js';

let dir: string | undefined;
let ui: RunningUi | undefined;

afterEach(async () => {
  if (ui) await ui.close();
  if (dir) await rm(dir, { recursive: true, force: true });
  ui = undefined;
  dir = undefined;
});

function exchange(path: string, body: unknown): Exchange {
  return {
    id: `${Math.random()}`,
    startedAt: 1,
    request: { method: 'GET', url: path, path, query: {}, headers: {} },
    response: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      bodyJson: body as never,
      bodyText: JSON.stringify(body),
      durationMs: 5,
    },
  };
}

async function seed(storeDir: string): Promise<void> {
  const store = new RecordingStore(storeDir);
  await store.init('old', 'http://x');
  await store.init('new', 'http://x');
  // old: lastLoginAt string; new: lastLoginAt number + extra field.
  for (let i = 0; i < 4; i += 1) {
    await store.append('old', exchange('/api/users/1', { id: 'a', lastLoginAt: 'x' }));
    await store.append('new', exchange('/api/users/1', { id: 'a', lastLoginAt: 12, mfa: true }));
  }
}

describe('ui /api/diff', () => {
  it('diffs two recordings and returns the report', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wtui-'));
    const storeDir = join(dir, '.wiretype');
    await seed(storeDir);
    ui = await startUiServer(storeDir, 0);

    const res = await fetch(`http://127.0.0.1:${ui.port}/api/diff?a=old&b=new`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      report: { summary: { breaking: number }; findings: Array<{ kind: string; bSamples?: number }> };
      aNotAuditable: unknown[];
    };
    expect(data.report.summary.breaking).toBeGreaterThan(0);
    const typeChanged = data.report.findings.find((f) => f.kind === 'type-changed');
    expect(typeChanged).toBeDefined();
    expect(typeChanged!.bSamples).toBe(4);
    expect(data.aNotAuditable).toEqual([]);
  });

  it('accepts a claims/model file path as side a and surfaces notAuditable', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wtui-'));
    const storeDir = join(dir, '.wiretype');
    await seed(storeDir);

    const claims = {
      name: 'claims',
      target: 'source-code',
      generatedAt: 0,
      endpoints: [
        {
          method: 'GET',
          pattern: '/api/users/:userId',
          params: [],
          queryShape: null,
          requestBodyShape: null,
          responses: [
            { status: 200, bodyShape: inferShape({ id: 'a', lastLoginAt: 'x' }), count: 1 },
          ],
          exchangeIds: [],
          operationId: 'getApiUsersByUserId',
          typeName: 'GetApiUsersByUserId',
        },
      ],
      notAuditable: [
        { endpoint: 'GET /api/other', slot: 'response[200]', ref: 'x.ts#Gone', reason: 'No exported type' },
      ],
    };
    const claimsPath = join(dir, 'claims.json');
    await writeFile(claimsPath, JSON.stringify(claims));

    ui = await startUiServer(storeDir, 0);
    const params = new URLSearchParams({ a: claimsPath, b: 'new', ignoreUnmatched: '1' });
    const res = await fetch(`http://127.0.0.1:${ui.port}/api/diff?${params.toString()}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      report: { summary: { breaking: number; endpointsOnlyInB: number } };
      aNotAuditable: Array<{ endpoint: string }>;
    };
    expect(data.report.summary.breaking).toBeGreaterThan(0);
    expect(data.aNotAuditable).toHaveLength(1);
    expect(data.aNotAuditable[0]!.endpoint).toBe('GET /api/other');
  });

  it('404s with a clear error for an unknown side', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wtui-'));
    const storeDir = join(dir, '.wiretype');
    await seed(storeDir);
    ui = await startUiServer(storeDir, 0);

    const res = await fetch(`http://127.0.0.1:${ui.port}/api/diff?a=ghost&b=new`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Could not resolve "ghost"/);
  });

  it('400s when a side is missing', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wtui-'));
    const storeDir = join(dir, '.wiretype');
    await seed(storeDir);
    ui = await startUiServer(storeDir, 0);

    const res = await fetch(`http://127.0.0.1:${ui.port}/api/diff?a=old`);
    expect(res.status).toBe(400);
  });
});
