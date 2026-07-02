/**
 * wiretype codegen — zod v3 schema emitter (`schemas.ts`).
 */

import type { ApiModel, Endpoint, Shape, ObjectShape, StringFormat } from '../core/index.js';
import type { CodegenOptions } from './options.js';
import { DEFAULT_BANNER, bannerComment, pad, propKey, responseSuffix } from './naming.js';

/**
 * Render a Shape as an inline zod expression. `indent` is the current
 * indentation level used for nested `z.object({ ... })` bodies.
 */
export function renderShapeAsZod(shape: Shape, indent = 0): string {
  switch (shape.kind) {
    case 'primitive':
      return renderPrimitiveZod(shape);
    case 'null':
      return 'z.null()';
    case 'unknown':
      return 'z.unknown()';
    case 'array': {
      if (shape.element === null) return 'z.array(z.unknown())';
      return `z.array(${renderShapeAsZod(shape.element, indent)})`;
    }
    case 'record':
      return `z.record(${renderShapeAsZod(shape.value, indent)})`;
    case 'union':
      return renderUnionZod(shape.variants, indent);
    case 'object':
      return renderObjectZod(shape, indent);
  }
}

function formatToZod(fmt: StringFormat): string {
  switch (fmt) {
    case 'uuid':
      return '.uuid()';
    case 'date-time':
      return '.datetime()';
    case 'email':
      return '.email()';
    case 'uri':
      return '.url()';
    case 'date':
      // zod v3 has no string .date() in older minors — use a regex.
      return '.regex(/^\\d{4}-\\d{2}-\\d{2}$/)';
  }
}

function renderPrimitiveZod(shape: Extract<Shape, { kind: 'primitive' }>): string {
  if (shape.enum && shape.enum.length > 0) {
    const values = shape.enum;
    const allStrings = values.every((v) => typeof v === 'string');
    if (allStrings) {
      const items = values.map((v) => JSON.stringify(v)).join(', ');
      return `z.enum([${items}])`;
    }
    // Numeric (or mixed) enum -> literal union.
    if (values.length === 1) {
      return `z.literal(${literalZod(values[0]!)})`;
    }
    const lits = values.map((v) => `z.literal(${literalZod(v)})`).join(', ');
    return `z.union([${lits}])`;
  }
  switch (shape.type) {
    case 'string': {
      let base = 'z.string()';
      if (shape.formats && shape.formats.length > 0) {
        // Apply the first detected format (formats are mutually exclusive in practice).
        base += formatToZod(shape.formats[0]!);
      }
      return base;
    }
    case 'number':
      return 'z.number()';
    case 'integer':
      return 'z.number().int()';
    case 'boolean':
      return 'z.boolean()';
  }
}

function literalZod(v: string | number): string {
  return typeof v === 'string' ? JSON.stringify(v) : String(v);
}

function renderUnionZod(variants: Shape[], indent: number): string {
  if (variants.length === 0) return 'z.never()';
  // Exactly `shape | null` -> `.nullable()`.
  const nulls = variants.filter((v) => v.kind === 'null');
  const nonNulls = variants.filter((v) => v.kind !== 'null');
  if (nulls.length > 0 && nonNulls.length === 1) {
    return `${renderShapeAsZod(nonNulls[0]!, indent)}.nullable()`;
  }
  const parts = variants.map((v) => renderShapeAsZod(v, indent));
  if (parts.length === 1) return parts[0]!;
  return `z.union([${parts.join(', ')}])`;
}

function renderObjectZod(shape: ObjectShape, indent: number): string {
  const keys = Object.keys(shape.fields);
  if (keys.length === 0) return 'z.object({})';
  const inner = indent + 1;
  const lines = keys.map((key) => {
    const field = shape.fields[key]!;
    let expr = renderShapeAsZod(field.shape, inner);
    if (field.optional) expr += '.optional()';
    return `${pad(inner)}${propKey(key)}: ${expr},`;
  });
  return `z.object({\n${lines.join('\n')}\n${pad(indent)}})`;
}

/** Top-level schema const + inferred type alias. */
function emitSchema(schemaConst: string, typeName: string, shape: Shape): string {
  const expr = renderShapeAsZod(shape, 0);
  return `export const ${schemaConst} = ${expr};\nexport type ${typeName} = z.infer<typeof ${schemaConst}>;`;
}

export function generateZod(model: ApiModel, opts: CodegenOptions = {}): string {
  const banner = opts.banner ?? DEFAULT_BANNER;
  const chunks: string[] = [];

  for (const ep of model.endpoints) {
    if (ep.queryShape) {
      chunks.push(emitSchema(`${ep.operationId}QuerySchema`, `${ep.typeName}Query`, ep.queryShape));
    }
    if (ep.requestBodyShape) {
      chunks.push(
        emitSchema(`${ep.operationId}RequestSchema`, `${ep.typeName}Request`, ep.requestBodyShape),
      );
    }
    for (const resp of ep.responses) {
      const suffix = responseSuffix(ep, resp.status);
      const shape: Shape = resp.bodyShape ?? { kind: 'unknown' };
      chunks.push(
        emitSchema(
          `${ep.operationId}ResponseSchema${suffix}`,
          `${ep.typeName}Response${suffix}`,
          shape,
        ),
      );
    }
  }

  const body = chunks.join('\n\n');
  return `${bannerComment(banner)}import { z } from 'zod';\n\n${body}\n`;
}
