import { describe, it, expect } from 'vitest';
import wiretypeRecorder, { resolveEnabled } from './index.js';

describe('resolveEnabled', () => {
  it('explicit true wins regardless of mode/env', () => {
    expect(resolveEnabled(true, 'development', false)).toBe(true);
    expect(resolveEnabled(true, 'record', true)).toBe(true);
  });

  it('explicit false wins regardless of mode/env', () => {
    expect(resolveEnabled(false, 'record', true)).toBe(false);
    expect(resolveEnabled(false, 'development', false)).toBe(false);
  });

  it("mode 'record' auto-enables when no explicit flag", () => {
    expect(resolveEnabled(undefined, 'record', false)).toBe(true);
  });

  it('WIRETYPE env auto-enables in any mode when no explicit flag', () => {
    expect(resolveEnabled(undefined, 'development', true)).toBe(true);
    expect(resolveEnabled(undefined, 'production', true)).toBe(true);
  });

  it('neither mode nor env → disabled', () => {
    expect(resolveEnabled(undefined, 'development', false)).toBe(false);
    expect(resolveEnabled(undefined, 'production', false)).toBe(false);
  });
});

describe('wiretypeRecorder plugin', () => {
  it('registers configResolved and configureServer hooks', () => {
    const plugin = wiretypeRecorder({
      target: 'http://localhost:8080',
      prefixes: ['/api'],
    });
    expect(plugin.name).toBe('wiretype-recorder');
    expect(typeof plugin.configResolved).toBe('function');
    expect(typeof plugin.configureServer).toBe('function');
  });
});
