import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Service-worker-bundle derive->sign EXECUTION harness for the extension app.
 *
 * The plain-SPA harness (runDeriveSign.mjs) proved the popup-style bundle. But
 * @crxjs bundles `background.service_worker` as a SEPARATE Rollup input with its
 * OWN tree-shaking pass. Because the upstream @stoachain polyfill is dropped
 * under `sideEffects:false`, the Buffer polyfill, the `node:buffer`->`buffer`
 * redirect, the legacy `.cjs` subpath aliases, and the single `@noble/curves`
 * instance must be re-proven for the SW bundling pass SPECIFICALLY — a green
 * popup bundle does not transfer that guarantee to the SW input.
 *
 * The runner (`harness/runDeriveSignSW.mjs`) drives the @crxjs SW bundling pass
 * (`crx({ manifest })` with a harness manifest whose `background.service_worker`
 * points at the polyfill-first derive->sign entry), then executes the emitted SW
 * chunk in a `vm` context whose ambient `Buffer` is DELETED and asserted-gone
 * BEFORE the bundle's polyfill import runs. It emits the EXECUTED result as JSON.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(HERE, '..', '..', 'harness', 'runDeriveSignSW.mjs');

function runHarness(): {
  bundledViaCrxSwPass: boolean;
  bufferWasDefinedBeforePolyfill: boolean;
  signature: string | null;
  error: string | null;
} {
  // Generous timeout: a cold @crxjs production build of the @stoachain triplet.
  const stdout = execFileSync(process.execPath, [RUNNER], {
    encoding: 'utf8',
    timeout: 300_000,
    cwd: path.resolve(HERE, '..', '..'),
  });
  const marker = '__STOA_SW_HARNESS_JSON__';
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith(marker));
  if (line == null) {
    throw new Error(`runner produced no result marker. stdout:\n${stdout}`);
  }
  return JSON.parse(line.slice(marker.length));
}

describe('extension @crxjs service-worker bundle derive->sign execution', () => {
  it('produces the artifact through the @crxjs SW bundling pass, then executes derive->sign Buffer-free returning a valid signature with no Buffer/curve error', () => {
    const result = runHarness();

    // The artifact under test came from the @crxjs SW bundling pass (the same
    // plugin/rollup-input treatment the real `background.service_worker` gets),
    // NOT plain Vite lib mode — otherwise this would re-prove the popup bundle.
    expect(result.bundledViaCrxSwPass).toBe(true);

    // The environment genuinely removed the ambient Buffer before the bundle's
    // polyfill ran — otherwise a native Node Buffer would MASK the exact
    // "Buffer is not defined" production failure this harness exists to catch.
    expect(result.bufferWasDefinedBeforePolyfill).toBe(false);

    // The executed derive->sign path produced a real 128-char hex Ed25519
    // signature with no "Buffer is not defined" and no duplicate-@noble/curves
    // error — not just a successful compile of the SW input.
    expect(result.error).toBeNull();
    expect(result.signature).toMatch(/^[0-9a-f]{128}$/);
  }, 320_000);
});
