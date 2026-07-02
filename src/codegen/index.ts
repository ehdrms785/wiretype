/**
 * wiretype codegen — public API.
 *
 * Turns an inferred `ApiModel` into TypeScript types, zod schemas, MSW v2
 * handlers, and an OpenAPI 3.1 document.
 */

import type { ApiModel } from '../core/index.js';
import type { CodegenOptions, GeneratedFile, CodegenTarget } from './options.js';
import { generateTypes } from './emit-ts.js';
import { generateZod } from './emit-zod.js';
import { generateMsw } from './emit-msw.js';
import { generateOpenApi } from './emit-openapi.js';
import { DEFAULT_BANNER, bannerComment } from './naming.js';

export type { CodegenOptions, GeneratedFile, CodegenTarget } from './options.js';
export { renderShapeAsTs, generateTypes } from './emit-ts.js';
export { renderShapeAsZod, generateZod } from './emit-zod.js';
export { generateMsw } from './emit-msw.js';
export { generateOpenApi, shapeToJsonSchema } from './emit-openapi.js';

const ALL_TARGETS: CodegenTarget[] = ['ts', 'zod', 'msw', 'openapi'];

/**
 * Generate all (or a subset of) targets as an ordered list of files.
 * paths: `types.ts`, `schemas.ts`, `handlers.ts`, `openapi.json`.
 */
export function generateAll(
  model: ApiModel,
  targets: CodegenTarget[] = ALL_TARGETS,
  opts: CodegenOptions = {},
): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const target of targets) {
    switch (target) {
      case 'ts':
        files.push({ path: 'types.ts', content: generateTypes(model, opts) });
        break;
      case 'zod':
        files.push({ path: 'schemas.ts', content: generateZod(model, opts) });
        break;
      case 'msw':
        files.push({ path: 'handlers.ts', content: generateMsw(model, opts) });
        break;
      case 'openapi': {
        const banner = opts.banner ?? DEFAULT_BANNER;
        const doc = generateOpenApi(model, opts);
        // openapi.json cannot carry a JS comment; prepend a banner via a
        // top-level "x-generated-by" extension and pretty-print with 2 spaces.
        const withBanner = { 'x-generated-by': banner, ...doc };
        files.push({ path: 'openapi.json', content: `${JSON.stringify(withBanner, null, 2)}\n` });
        break;
      }
    }
  }
  return files;
}

// Re-export the banner helper for consumers that want the default value.
export { DEFAULT_BANNER, bannerComment };
