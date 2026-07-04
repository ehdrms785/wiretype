#!/usr/bin/env node
import { Command } from 'commander';
import { runRecord } from './cmd-record.js';
import { runGen } from './cmd-gen.js';
import { runList } from './cmd-list.js';
import { runUi } from './cmd-ui.js';
import { runDiff, resolveDiffSides } from './cmd-diff.js';
import { runDemo } from './cmd-demo.js';
import { runClaims } from './cmd-claims.js';
import { loadConfig } from '../config/index.js';
import type { WiretypeConfig } from '../config/index.js';
import { layerConfig } from './util.js';

function fail(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`wiretype: ${message}\n`);
  process.exit(1);
}

/** Load wiretype.config.* from cwd (or {} when absent). */
async function fileConfig(): Promise<WiretypeConfig> {
  const loaded = await loadConfig();
  return loaded?.config ?? {};
}

/** true when the option was explicitly passed on the command line. */
function explicit(cmd: Command): (key: string) => boolean {
  return (key) => cmd.getOptionValueSource(key) === 'cli';
}

const program = new Command();

program
  .name('wiretype')
  .description('Record real API traffic and generate types, zod, MSW, and OpenAPI.');

program
  .command('record')
  .description('Start a recording proxy and append every exchange to the store.')
  .option('--target <url>', 'upstream base URL to proxy (or set it in wiretype.config)')
  .option('--port <port>', 'listen port', '5050')
  .option('--name <recording>', 'recording name', 'session')
  .option('--dir <dir>', 'store directory', '.wiretype')
  .option('--include <prefix...>', 'only record paths matching these prefixes')
  .option('--exclude <prefix...>', 'skip paths matching these prefixes')
  .action(async (opts, cmd: Command) => {
    try {
      const cfg = await fileConfig();
      const merged = layerConfig(opts, explicit(cmd), {
        target: cfg.target,
        name: cfg.name,
        dir: cfg.dir,
        include: cfg.includePrefixes,
        exclude: cfg.excludePrefixes,
      });
      if (!merged.target) {
        throw new Error('Missing target: pass --target <url> or set "target" in wiretype.config.');
      }
      await runRecord({
        ...merged,
        maxBodyBytes: cfg.maxBodyBytes,
        redactHeaders: cfg.redactHeaders,
      });
      process.exit(0);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('gen')
  .description('Load a recording, build the model, and generate code.')
  .option('--name <recording>', 'recording name', 'session')
  .option('--dir <dir>', 'store directory', '.wiretype')
  .option('--out <dir>', 'output directory', 'wiretype-generated')
  .option('--targets <targets>', 'comma-separated targets (ts,zod,msw,openapi,model)', 'ts,zod,msw,openapi,model')
  .option('--msw-fixtures', 'write MSW mock bodies as fixtures/*.json and import them from handlers.ts')
  .action(async (opts, cmd: Command) => {
    try {
      const cfg = await fileConfig();
      const merged = layerConfig(opts, explicit(cmd), {
        name: cfg.name,
        dir: cfg.dir,
        out: cfg.out,
        targets: cfg.targets ? cfg.targets.join(',') : undefined,
      });
      await runGen(merged);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('diff')
  .description('Compare two models/recordings and report schema drift (a → b).')
  .argument('[a]', 'baseline: model.json path or recording name (what consumers believe)')
  .argument('[b]', 'observed: model.json path or recording name (observed reality)')
  .option('--claims <ref>', 'explicit side "a" — what the code believes (alias for the first positional)')
  .option('--observed <ref>', 'explicit side "b" — observed reality (alias for the second positional)')
  .option('--dir <dir>', 'store directory', '.wiretype')
  .option('--json', 'print the DriftReport as JSON (never localized; wins over --md)')
  .option('--md', 'print a localized Markdown report instead of the table')
  .option('--lang <lang>', 'report language for --md (en|ko, unknown falls back to en)', 'en')
  .option('--fail-on <level>', 'exit 1 when a finding at this level or higher exists (breaking|risky|info)')
  .option('--ignore-unmatched', 'ignore endpoints only present on one side')
  .action(async (a: string | undefined, b: string | undefined, opts, cmd: Command) => {
    try {
      const cfg = await fileConfig();
      const merged = layerConfig(opts, explicit(cmd), { dir: cfg.dir });
      const sides = resolveDiffSides({ a, b, claims: opts.claims, observed: opts.observed });
      await runDiff({ ...merged, ...sides });
    } catch (err) {
      fail(err);
    }
  });

program
  .command('claims')
  .description(
    'Deterministically extract "what the code believes" into a claims model: ' +
      'a claims map binds endpoints to exported TS types (file.ts#TypeName), the ' +
      'TypeScript compiler translates them into shapes. Untranslatable refs are ' +
      'refused and listed, never guessed.',
  )
  .requiredOption('--map <file>', 'claims map JSON ({ "entries": [{ method, pattern, status?, response?, request?, query? }] })')
  .option('--out <file>', 'output claims model path', 'claims.json')
  .option('--tsconfig <file>', 'tsconfig to resolve imports/paths (default: nearest to the map file)')
  .option('--strict', 'exit 1 when any reference is refused (not auditable)')
  .action(async (opts) => {
    try {
      await runClaims(opts);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('demo')
  .description(
    'Self-contained 30-second tour: record a built-in demo API, generate types/zod/MSW/OpenAPI, then catch schema drift.',
  )
  .option('--dir <dir>', 'store directory', '.wiretype')
  .option('--out <dir>', 'output directory', 'wiretype-demo')
  .action(async (opts) => {
    try {
      await runDemo(opts);
      process.exit(0);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('list')
  .description('List recordings in the store.')
  .option('--dir <dir>', 'store directory', '.wiretype')
  .action(async (opts, cmd: Command) => {
    try {
      const cfg = await fileConfig();
      await runList(layerConfig(opts, explicit(cmd), { dir: cfg.dir }));
    } catch (err) {
      fail(err);
    }
  });

program
  .command('ui')
  .description('Serve the viewer and JSON API.')
  .option('--dir <dir>', 'store directory', '.wiretype')
  .option('--port <port>', 'listen port', '5099')
  .action(async (opts, cmd: Command) => {
    try {
      const cfg = await fileConfig();
      await runUi(layerConfig(opts, explicit(cmd), { dir: cfg.dir }));
    } catch (err) {
      fail(err);
    }
  });

program.parseAsync(process.argv).catch(fail);
