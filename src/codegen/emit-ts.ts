/**
 * wiretype codegen — TypeScript types emitter (`types.ts`).
 */

import type { ApiModel, Endpoint, Shape, ObjectShape } from '../core/index.js';
import type { CodegenOptions } from './options.js';
import {
  DEFAULT_BANNER,
  bannerComment,
  endpointKey,
  pad,
  propKey,
  responseSuffix,
} from './naming.js';

/**
 * Render a Shape as inline TypeScript type text. `indent` is the current
 * indentation level (used when rendering nested object literals). The result
 * never has a trailing newline.
 */
export function renderShapeAsTs(shape: Shape, indent = 0): string {
  switch (shape.kind) {
    case 'primitive':
      return renderPrimitiveTs(shape);
    case 'null':
      return 'null';
    case 'unknown':
      return 'unknown';
    case 'array': {
      if (shape.element === null) return 'unknown[]';
      const el = renderShapeAsTs(shape.element, indent);
      // Parenthesize unions (incl. enum literal unions) so `A | B[]` doesn't mis-associate.
      const needsParens =
        shape.element.kind === 'union' ||
        (shape.element.kind === 'primitive' && (shape.element.enum?.length ?? 0) > 1);
      return needsParens ? `Array<${el}>` : `${el}[]`;
    }
    case 'record': {
      const v = renderShapeAsTs(shape.value, indent);
      return `Record<string, ${v}>`;
    }
    case 'union':
      return renderUnionTs(shape.variants, indent);
    case 'object':
      return renderObjectLiteralTs(shape, indent);
  }
}

function renderPrimitiveTs(shape: Extract<Shape, { kind: 'primitive' }>): string {
  if (shape.enum && shape.enum.length > 0) {
    return shape.enum.map((v) => (typeof v === 'string' ? JSON.stringify(v) : String(v))).join(' | ');
  }
  switch (shape.type) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
  }
}

function renderUnionTs(variants: Shape[], indent: number): string {
  if (variants.length === 0) return 'never';
  const parts = variants.map((v) => {
    const text = renderShapeAsTs(v, indent);
    // Object literals span multiple lines; keep them as-is (they are valid in a union).
    return text;
  });
  return parts.join(' | ');
}

/** JSDoc annotation for a field's format(s), or empty string. */
function formatDoc(shape: Shape): string {
  if (shape.kind === 'primitive' && shape.formats && shape.formats.length > 0) {
    return `/** format: ${shape.formats.join(', ')} */ `;
  }
  return '';
}

function renderObjectLiteralTs(shape: ObjectShape, indent: number): string {
  const keys = Object.keys(shape.fields);
  if (keys.length === 0) return 'Record<string, never>';
  const inner = indent + 1;
  const lines = keys.map((key) => {
    const field = shape.fields[key]!;
    const opt = field.optional ? '?' : '';
    const doc = formatDoc(field.shape);
    const value = renderShapeAsTs(field.shape, inner);
    return `${pad(inner)}${doc}${propKey(key)}${opt}: ${value};`;
  });
  return `{\n${lines.join('\n')}\n${pad(indent)}}`;
}

/** Render the members of an object shape as interface body lines (indent 1). */
function renderInterfaceBody(shape: ObjectShape): string {
  const keys = Object.keys(shape.fields);
  const lines = keys.map((key) => {
    const field = shape.fields[key]!;
    const opt = field.optional ? '?' : '';
    const doc = formatDoc(field.shape);
    const value = renderShapeAsTs(field.shape, 1);
    return `${pad(1)}${doc}${propKey(key)}${opt}: ${value};`;
  });
  return lines.join('\n');
}

/**
 * Emit a top-level named type. Object shapes become `export interface`,
 * everything else becomes `export type`.
 */
function emitNamedType(name: string, shape: Shape): string {
  if (shape.kind === 'object' && Object.keys(shape.fields).length > 0) {
    return `export interface ${name} {\n${renderInterfaceBody(shape)}\n}`;
  }
  return `export type ${name} = ${renderShapeAsTs(shape, 0)};`;
}

/** Build a synthetic object shape for a Params interface (all string values). */
function paramsShape(ep: Endpoint): ObjectShape | null {
  if (ep.params.length === 0) return null;
  const fields: ObjectShape['fields'] = {};
  for (const p of ep.params) {
    fields[p.name] = { shape: { kind: 'primitive', type: 'string' }, optional: false };
  }
  return { kind: 'object', fields };
}

/**
 * Names of the four generated member types for an endpoint, or `never` when
 * that member is absent. Used by the ApiEndpoints summary map.
 */
interface EndpointTypeRefs {
  params: string;
  query: string;
  request: string;
  response: string;
}

export function generateTypes(model: ApiModel, opts: CodegenOptions = {}): string {
  const banner = opts.banner ?? DEFAULT_BANNER;
  const chunks: string[] = [];
  const summaryEntries: string[] = [];

  for (const ep of model.endpoints) {
    const refs: EndpointTypeRefs = {
      params: 'never',
      query: 'never',
      request: 'never',
      response: 'never',
    };

    // Params.
    const params = paramsShape(ep);
    if (params) {
      const name = `${ep.typeName}Params`;
      chunks.push(emitNamedType(name, params));
      refs.params = name;
    }

    // Query.
    if (ep.queryShape) {
      const name = `${ep.typeName}Query`;
      chunks.push(emitNamedType(name, ep.queryShape));
      refs.query = name;
    }

    // Request.
    if (ep.requestBodyShape) {
      const name = `${ep.typeName}Request`;
      chunks.push(emitNamedType(name, ep.requestBodyShape));
      refs.request = name;
    }

    // Responses (one per status; success gets no suffix).
    for (const resp of ep.responses) {
      const suffix = responseSuffix(ep, resp.status);
      const name = `${ep.typeName}Response${suffix}`;
      const shape: Shape = resp.bodyShape ?? { kind: 'unknown' };
      chunks.push(emitNamedType(name, shape));
      if (suffix === '') refs.response = name;
    }

    summaryEntries.push(
      `${pad(1)}${JSON.stringify(endpointKey(ep))}: { params: ${refs.params}; query: ${refs.query}; request: ${refs.request}; response: ${refs.response} };`,
    );
  }

  const summary = `export interface ApiEndpoints {\n${summaryEntries.join('\n')}\n}`;

  const body = [...chunks, summary].join('\n\n');
  return `${bannerComment(banner)}\n${body}\n`;
}
