import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { extractClaims } from '../claims/index.js';
import { renderTable } from './util.js';

export interface ClaimsCmdOptions {
  map: string;
  out: string;
  tsconfig?: string;
  strict?: boolean;
}

export async function runClaims(opts: ClaimsCmdOptions): Promise<void> {
  const { model, notAuditable, tsconfigPath } = await extractClaims({
    mapPath: opts.map,
    tsconfig: opts.tsconfig,
  });

  const payload = { ...model, notAuditable };
  await mkdir(dirname(opts.out) || '.', { recursive: true });
  await writeFile(opts.out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const claimed = model.endpoints.length;
  process.stdout.write(
    `wiretype claims → ${opts.out}\n` +
      `  ${claimed} endpoint(s) claimed, ${notAuditable.length} refusal(s)\n` +
      `  tsconfig: ${tsconfigPath ?? '(built-in defaults)'} · strictNullChecks forced ON\n`,
  );

  if (model.endpoints.length > 0) {
    const rows = model.endpoints.map((ep) => ({
      endpoint: `${ep.method} ${ep.pattern}`,
      slots: [
        ...ep.responses.filter((r) => r.bodyShape !== null).map((r) => `response[${r.status}]`),
        ...(ep.requestBodyShape !== null ? ['request'] : []),
        ...(ep.queryShape !== null ? ['query'] : []),
      ].join(', '),
    }));
    process.stdout.write(
      `\n${renderTable([
        { header: 'ENDPOINT', values: rows.map((r) => r.endpoint) },
        { header: 'CLAIMED', values: rows.map((r) => r.slots) },
      ])}\n`,
    );
  }

  if (notAuditable.length > 0) {
    process.stdout.write(
      `\nNOT AUDITABLE (excluded from claims — never guessed)\n${renderTable([
        { header: 'ENDPOINT', values: notAuditable.map((r) => r.endpoint) },
        { header: 'SLOT', values: notAuditable.map((r) => r.slot) },
        { header: 'REF', values: notAuditable.map((r) => r.ref) },
        { header: 'REASON', values: notAuditable.map((r) => r.reason) },
      ])}\n`,
    );
  }

  process.stdout.write(
    `\nNext: npx wiretype diff --claims ${opts.out} --observed <model.json|recording> --ignore-unmatched\n`,
  );

  if (opts.strict && notAuditable.length > 0) {
    process.exitCode = 1;
  }
}
