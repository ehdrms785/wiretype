/**
 * wiretype drift — public entry.
 *
 * Deterministic schema-drift detection between two ApiModels.
 */

export * from './types.js';
export { diffModels, diffShapes } from './diff.js';
