/** Pure helpers for the CLI, unit-tested independently of wiretype core. */

export type Target = 'ts' | 'zod' | 'msw' | 'openapi' | 'model';

const VALID_TARGETS: readonly Target[] = ['ts', 'zod', 'msw', 'openapi', 'model'];

/** Parse a comma-separated --targets string into a validated Target[]. */
export function parseTargets(raw: string): Target[] {
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const out: Target[] = [];
  for (const part of parts) {
    if (!isTarget(part)) {
      throw new Error(
        `Unknown target "${part}". Valid targets: ${VALID_TARGETS.join(', ')}`,
      );
    }
    if (!out.includes(part)) out.push(part);
  }
  if (out.length === 0) {
    throw new Error(`No valid targets provided. Valid targets: ${VALID_TARGETS.join(', ')}`);
  }
  return out;
}

export function isTarget(value: string): value is Target {
  return (VALID_TARGETS as readonly string[]).includes(value);
}

export interface Column {
  header: string;
  /** Row values, already stringified. */
  values: string[];
}

/**
 * Render a simple padEnd-aligned text table. No dependencies.
 * Columns are separated by "  |  " (two spaces + pipe + two spaces),
 * with a dashed separator line under the header.
 */
export function renderTable(columns: Column[]): string {
  if (columns.length === 0) return '';
  const rowCount = Math.max(0, ...columns.map((c) => c.values.length));

  const widths = columns.map((c) =>
    Math.max(c.header.length, ...c.values.map((v) => v.length), 0),
  );

  const sep = ' | ';
  const lines: string[] = [];

  const headerCells = columns.map((c, i) => c.header.padEnd(widths[i] ?? 0));
  lines.push(headerCells.join(sep).trimEnd());

  const dashCells = widths.map((w) => '-'.repeat(w));
  lines.push(dashCells.join(sep).trimEnd());

  for (let r = 0; r < rowCount; r++) {
    const cells = columns.map((c, i) => (c.values[r] ?? '').padEnd(widths[i] ?? 0));
    lines.push(cells.join(sep).trimEnd());
  }

  return lines.join('\n');
}

/**
 * Layer a config file under CLI options. For each mapping entry
 * `optionKey → configValue`, the config value wins ONLY when the option was
 * not explicitly passed on the command line (i.e. it still holds its
 * default). Pure: returns a new options object.
 */
export function layerConfig<T extends Record<string, unknown>>(
  opts: T,
  isExplicit: (key: string) => boolean,
  overrides: Partial<Record<keyof T & string, unknown>>,
): T {
  const out: Record<string, unknown> = { ...opts };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (isExplicit(key)) continue;
    out[key] = value;
  }
  return out as T;
}

/** Format an epoch-ms timestamp as an ISO string (or "-" when falsy). */
export function formatTimestamp(ms: number | undefined): string {
  if (!ms) return '-';
  return new Date(ms).toISOString();
}
