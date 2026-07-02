/**
 * wiretype codegen — OpenAPI 3.1 emitter (`openapi.json`).
 */

import type {
  ApiModel,
  Endpoint,
  PathParam,
  Shape,
  ObjectShape,
  StringFormat,
} from '../core/index.js';
import type { CodegenOptions } from './options.js';

type JsonSchema = Record<string, unknown>;

/** JSON Schema `format` keyword for a detected string format. */
function formatKeyword(fmt: StringFormat): string {
  // OpenAPI/JSON Schema use "date-time" and "uuid"/"email"; "uri" -> "uri".
  return fmt;
}

/**
 * Convert a Shape into an OpenAPI 3.1 JSON Schema object. Nullability is
 * expressed via `type` arrays where possible, else `anyOf`.
 */
export function shapeToJsonSchema(shape: Shape): JsonSchema {
  switch (shape.kind) {
    case 'primitive':
      return primitiveToJsonSchema(shape);
    case 'null':
      return { type: 'null' };
    case 'unknown':
      return {};
    case 'array': {
      if (shape.element === null) return { type: 'array', items: {} };
      return { type: 'array', items: shapeToJsonSchema(shape.element) };
    }
    case 'record':
      return { type: 'object', additionalProperties: shapeToJsonSchema(shape.value) };
    case 'union':
      return unionToJsonSchema(shape.variants);
    case 'object':
      return objectToJsonSchema(shape);
  }
}

function primitiveToJsonSchema(shape: Extract<Shape, { kind: 'primitive' }>): JsonSchema {
  const base: JsonSchema = {};
  switch (shape.type) {
    case 'string':
      base.type = 'string';
      break;
    case 'number':
      base.type = 'number';
      break;
    case 'integer':
      base.type = 'integer';
      break;
    case 'boolean':
      base.type = 'boolean';
      break;
  }
  if (shape.type === 'string' && shape.formats && shape.formats.length > 0) {
    base.format = formatKeyword(shape.formats[0]!);
  }
  if (shape.enum && shape.enum.length > 0) {
    base.enum = [...shape.enum];
  }
  return base;
}

function objectToJsonSchema(shape: ObjectShape): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const key of Object.keys(shape.fields)) {
    const field = shape.fields[key]!;
    properties[key] = shapeToJsonSchema(field.shape);
    if (!field.optional) required.push(key);
  }
  const schema: JsonSchema = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

/**
 * A union of exactly `X | null` where X is a plain primitive collapses to a
 * `type` array (3.1 style). Everything else uses `anyOf`, folding a null
 * variant into `{ type: "null" }`.
 */
function unionToJsonSchema(variants: Shape[]): JsonSchema {
  const nulls = variants.filter((v) => v.kind === 'null');
  const nonNulls = variants.filter((v) => v.kind !== 'null');
  const hasNull = nulls.length > 0;

  if (hasNull && nonNulls.length === 1) {
    const only = nonNulls[0]!;
    if (only.kind === 'primitive' && !(only.enum && only.enum.length > 0)) {
      const inner = primitiveToJsonSchema(only);
      const t = inner.type;
      const schema: JsonSchema = { ...inner, type: [t as string, 'null'] };
      return schema;
    }
    // Complex single variant + null -> anyOf.
    return { anyOf: [shapeToJsonSchema(only), { type: 'null' }] };
  }

  const anyOf = variants.map((v) => shapeToJsonSchema(v));
  return { anyOf };
}

/** OpenAPI parameter schema for a path param based on its detected format. */
function pathParamSchema(param: PathParam): JsonSchema {
  switch (param.format) {
    case 'uuid':
      return { type: 'string', format: 'uuid' };
    case 'integer':
      return { type: 'integer' };
    case 'string':
      return { type: 'string' };
  }
}

/** Convert an express-style pattern (`:userId`) to OpenAPI (`{userId}`). */
function toOpenApiPath(pattern: string): string {
  return pattern.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function buildParameters(ep: Endpoint): JsonSchema[] {
  const params: JsonSchema[] = [];
  for (const p of ep.params) {
    params.push({
      name: p.name,
      in: 'path',
      required: true,
      schema: pathParamSchema(p),
    });
  }
  if (ep.queryShape && ep.queryShape.kind === 'object') {
    const obj = ep.queryShape;
    for (const key of Object.keys(obj.fields)) {
      const field = obj.fields[key]!;
      params.push({
        name: key,
        in: 'query',
        required: !field.optional,
        schema: shapeToJsonSchema(field.shape),
      });
    }
  }
  return params;
}

function buildResponses(ep: Endpoint): JsonSchema {
  const responses: JsonSchema = {};
  for (const resp of ep.responses) {
    const entry: JsonSchema = { description: `Status ${resp.status}` };
    if (resp.bodyShape) {
      entry.content = {
        'application/json': { schema: shapeToJsonSchema(resp.bodyShape) },
      };
    }
    responses[String(resp.status)] = entry;
  }
  return responses;
}

export function generateOpenApi(
  model: ApiModel,
  _opts: CodegenOptions = {},
): Record<string, unknown> {
  const paths: Record<string, JsonSchema> = {};

  for (const ep of model.endpoints) {
    const oaPath = toOpenApiPath(ep.pattern);
    const pathItem: JsonSchema = (paths[oaPath] as JsonSchema) ?? {};

    const operation: JsonSchema = {
      operationId: ep.operationId,
      responses: buildResponses(ep),
    };

    const parameters = buildParameters(ep);
    if (parameters.length > 0) operation.parameters = parameters;

    if (ep.requestBodyShape) {
      operation.requestBody = {
        content: {
          'application/json': { schema: shapeToJsonSchema(ep.requestBodyShape) },
        },
      };
    }

    pathItem[ep.method.toLowerCase()] = operation;
    paths[oaPath] = pathItem;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: `${model.name} (recorded)`,
      version: '0.0.0',
    },
    servers: [{ url: model.target }],
    paths,
  };
}
