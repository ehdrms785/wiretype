#!/usr/bin/env node
/**
 * Release guard: package.json and the Claude plugin manifest must carry the
 * SAME version. Claude Code keys plugin installs/updates by the manifest
 * version — a stale manifest means users silently keep old skills even
 * though the repo moved on. Wired into prepublishOnly so a release cannot
 * ship out of sync.
 */
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const plugin = JSON.parse(
  readFileSync(new URL('../claude-plugin/.claude-plugin/plugin.json', import.meta.url), 'utf8'),
);

if (pkg.version !== plugin.version) {
  process.stderr.write(
    `version mismatch: package.json=${pkg.version} but claude-plugin plugin.json=${plugin.version}\n` +
      `bump claude-plugin/.claude-plugin/plugin.json before releasing.\n`,
  );
  process.exit(1);
}
process.stdout.write(`versions in sync: ${pkg.version}\n`);
