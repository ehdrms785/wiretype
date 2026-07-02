#!/usr/bin/env node
import { Command } from 'commander';
import { runRecord } from './cmd-record.js';
import { runGen } from './cmd-gen.js';
import { runList } from './cmd-list.js';
import { runUi } from './cmd-ui.js';

function fail(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`wiretype: ${message}\n`);
  process.exit(1);
}

const program = new Command();

program
  .name('wiretype')
  .description('Record real API traffic and generate types, zod, MSW, and OpenAPI.');

program
  .command('record')
  .description('Start a recording proxy and append every exchange to the store.')
  .requiredOption('--target <url>', 'upstream base URL to proxy')
  .option('--port <port>', 'listen port', '5050')
  .option('--name <recording>', 'recording name', 'session')
  .option('--dir <dir>', 'store directory', '.wiretype')
  .option('--include <prefix...>', 'only record paths matching these prefixes')
  .option('--exclude <prefix...>', 'skip paths matching these prefixes')
  .action(async (opts) => {
    try {
      await runRecord(opts);
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
  .option('--targets <targets>', 'comma-separated targets', 'ts,zod,msw,openapi')
  .action(async (opts) => {
    try {
      await runGen(opts);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('list')
  .description('List recordings in the store.')
  .option('--dir <dir>', 'store directory', '.wiretype')
  .action(async (opts) => {
    try {
      await runList(opts);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('ui')
  .description('Serve the viewer and JSON API.')
  .option('--dir <dir>', 'store directory', '.wiretype')
  .option('--port <port>', 'listen port', '5099')
  .action(async (opts) => {
    try {
      await runUi(opts);
    } catch (err) {
      fail(err);
    }
  });

program.parseAsync(process.argv).catch(fail);
