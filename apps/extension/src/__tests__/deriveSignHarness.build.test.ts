import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Production-bundle derive->sign EXECUTION harness for the extension app.
 *
 * A passing dev test or a clean `vite build` exit code is NOT sufficient proof:
 * the "Buffer is not defined" and `@noble/curves` duplicate-instance failures
 * are dev-tolerant and surface ONLY when the production bundle is EXECUTED.
 *
 * The runner (`harness/runDeriveSign.mjs`) production-builds the polyfill-first
 * derive->sign entry, deletes the ambient `Buffer` global (asserting it is gone
 * BEFORE the bundle's polyfill import runs), executes the bundle, and emits the
 * EXECUTED result as JSON. This test asserts on that executed result.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(HERE, '..', '..', 'harness', 'runDeriveSign.mjs');

function runHarness(): {
  bufferWasDefinedBeforePolyfill: boolean;
  signature: string | null;
  error: string | null;
} {
  // Generous timeout: a cold Vite production build of the @stoachain triplet.
  const stdout = execFileSync(process.execPath, [RUNNER], {
    encoding: 'utf8',
    timeout: 240_000,
    cwd: path.resolve(HERE, '..', '..'),
  });
  const marker = '__STOA_HARNESS_JSON__';
  const line = stdout
    .split(/\r?\n/)
    .find((l) => l.startsWith(marker));
  if (line == null) {
    throw new Error(`runner produced no result marker. stdout:\n${stdout}`);
  }
  return JSON.parse(line.slice(marker.length));
}

describe('extension production bundle derive->sign execution', () => {
  it('executes derive->sign in a Buffer-free bundle and returns a valid signature with no Buffer/curve error', () => {
    const result = runHarness();

    // The environment genuinely removed the ambient Buffer before the bundle's
    // polyfill ran — otherwise a native Node Buffer would MASK the exact
    // "Buffer is not defined" production failure this harness exists to catch.
    expect(result.bufferWasDefinedBeforePolyfill).toBe(false);

    // The executed derive->sign path produced a real 128-char hex Ed25519
    // signature — not just a successful compile.
    expect(result.error).toBeNull();
    expect(result.signature).toMatch(/^[0-9a-f]{128}$/);
  }, 260_000);
});
