import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Project-level configuration: one place for the values every command (and
 * the Vite plugin) would otherwise repeat as flags. Loaded from the first of
 * `wiretype.config.mjs` / `wiretype.config.js` / `wiretype.config.json`
 * found in the working directory (no upward search — in monorepos, run
 * wiretype from the app directory that owns the config).
 *
 * Precedence everywhere: explicit CLI flags / plugin options > config file
 * > built-in defaults.
 */
export interface WiretypeConfig {
  /** Store directory. Default ".wiretype". */
  dir?: string;
  /** Default recording name. */
  name?: string;
  /** Upstream API base URL (record proxy + Vite plugin). */
  target?: string;
  /** Path prefixes the Vite plugin intercepts, e.g. ["/api"]. */
  prefixes?: string[];
  /** Output directory for `wiretype gen`. */
  out?: string;
  /** Targets for `wiretype gen`, e.g. ["ts", "zod", "msw", "openapi", "model"]. */
  targets?: string[];
  /** Only record paths matching these prefixes. */
  includePrefixes?: string[];
  /** Skip paths matching these prefixes. */
  excludePrefixes?: string[];
  /** Capture cap per body, in bytes. */
  maxBodyBytes?: number;
  /** Header names to redact in recordings. */
  redactHeaders?: string[];
}

/** Identity helper for typed config files (`export default defineConfig({...})`). */
export function defineConfig(config: WiretypeConfig): WiretypeConfig {
  return config;
}

const CONFIG_FILES = ['wiretype.config.mjs', 'wiretype.config.js', 'wiretype.config.json'];

export interface LoadedConfig {
  config: WiretypeConfig;
  /** Absolute path of the file the config was loaded from. */
  path: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function assertShape(value: unknown, path: string): WiretypeConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid wiretype config in ${path}: expected an object export.`);
  }
  return value as WiretypeConfig;
}

/**
 * Load the config file from `cwd`, or null when none exists. Never applies
 * defaults — callers layer it under their own flag defaults. Throws on a
 * malformed file (a silently ignored config is worse than an error).
 */
export async function loadConfig(cwd: string = process.cwd()): Promise<LoadedConfig | null> {
  for (const file of CONFIG_FILES) {
    const path = resolve(join(cwd, file));
    if (!(await exists(path))) continue;

    if (file.endsWith('.json')) {
      const raw = await readFile(path, 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to parse ${path}: ${message}`);
      }
      return { config: assertShape(parsed, path), path };
    }

    // .mjs / .js — native ESM import; cache-bust so long-lived processes
    // (tests, dev servers) can observe edits. Constructed via new Function so
    // bundlers and vite-node module runners cannot intercept or rewrite it —
    // the config file must load through Node itself, from anywhere on disk.
    const nativeImport = new Function('u', 'return import(u)') as (
      u: string,
    ) => Promise<{ default?: unknown }>;
    const mod = await nativeImport(`${pathToFileURL(path).href}?t=${Date.now()}`);
    if (mod.default === undefined) {
      throw new Error(`${path} must have a default export (use defineConfig({...})).`);
    }
    return { config: assertShape(mod.default, path), path };
  }
  return null;
}
