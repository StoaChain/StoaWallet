import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MOBILE_WEB_DIR } from '../../webDir';

/**
 * Mobile Capacitor `webDir` PRODUCTION-bundle derive->sign EXECUTION harness.
 *
 * Phase-1 (T1.7) proved a plain self-contained lib build. But the mobile app is
 * a SEPARATE Vite build target with its OWN config (`apps/mobile/vite.config.ts`:
 * the `@vitejs/plugin-react` plugin, the `MOBILE_WEB_DIR` outDir, and the shared
 * `stoachainResolve()` correctness layer). The bytes Capacitor copies verbatim
 * into the native WebView come from THAT config — so the Buffer polyfill, the
 * `node:buffer`->`buffer` redirect, the legacy `.cjs` subpath aliases, and the
 * single `@noble/curves@1.9.7` instance must be re-proven against an artifact
 * emitted THROUGH the mobile config, not a fresh plain lib build that ignores it.
 *
 * The runner (`harness/runDeriveSignWebDir.mjs`) loads the mobile `vite.config.ts`
 * as its base, overrides only the build INPUT to the polyfill-first derive->sign
 * harness entry (so the plugins / resolve / define stay exactly the mobile
 * config's), confirms it emitted into MOBILE_WEB_DIR, then executes the emitted
 * chunk in a `vm` context whose ambient `Buffer` is DELETED and asserted-gone
 * BEFORE the bundle's polyfill import runs. It emits the EXECUTED result as JSON.
 *
 * RR#7 / ENVIRONMENT HONESTY: the AUTHORITATIVE WebView check wants a headless
 * browser (Playwright/puppeteer), because `delete globalThis.Buffer` does NOT
 * stop a CJS `.cjs` module re-acquiring Buffer via `require('buffer')`. No
 * headless browser is available in this workspace, so the `vm` run is the
 * primary CI proof (it catches the ESM/aliasing/polyfill/curve failures at the
 * bundler level) and the headless-browser WebView run remains a device/ops
 * verification. This test does NOT claim the headless WebView run is covered.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(HERE, '..', '..', 'harness', 'runDeriveSignWebDir.mjs');

interface HarnessResult {
  builtViaMobileConfig: boolean;
  emittedWebDir: string | null;
  bufferWasDefinedBeforePolyfill: boolean;
  signature: string | null;
  error: string | null;
}

function runHarness(): HarnessResult {
  // Generous timeout: a cold mobile Vite production build of the @stoachain
  // triplet through the real mobile config (react plugin + resolve layer).
  const stdout = execFileSync(process.execPath, [RUNNER], {
    encoding: 'utf8',
    timeout: 300_000,
    cwd: path.resolve(HERE, '..', '..'),
  });
  const marker = '__STOA_WEBDIR_HARNESS_JSON__';
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith(marker));
  if (line == null) {
    throw new Error(`runner produced no result marker. stdout:\n${stdout}`);
  }
  return JSON.parse(line.slice(marker.length));
}

describe('mobile Capacitor webDir production bundle derive->sign execution', () => {
  it('builds the artifact THROUGH the mobile vite config (its own config), then executes derive->sign Buffer-free returning a valid signature with no Buffer/curve error', () => {
    const result = runHarness();

    // The artifact under test was emitted through the mobile `vite.config.ts`
    // (the react plugin + stoachainResolve + MOBILE_WEB_DIR outDir) — NOT a
    // fresh plain lib build that ignores the mobile config. A green plain-lib
    // bundle does not transfer the polyfill/alias/curve guarantee to the bytes
    // Capacitor actually copies into the WebView.
    expect(result.builtViaMobileConfig).toBe(true);

    // The emitted output landed in the SAME directory the mobile config declares
    // as the Capacitor webDir, proving the build target under test is the webDir
    // build and not some unrelated outDir.
    expect(result.emittedWebDir).toBe(MOBILE_WEB_DIR);

    // The environment genuinely removed the ambient Buffer before the bundle's
    // polyfill ran — otherwise a native Node Buffer would MASK the exact
    // "Buffer is not defined" production failure this harness exists to catch.
    expect(result.bufferWasDefinedBeforePolyfill).toBe(false);

    // The executed derive->sign path produced a real 128-char hex Ed25519
    // signature with no "Buffer is not defined" and no duplicate-@noble/curves
    // error — not just a successful compile of the mobile webDir bundle.
    expect(result.error).toBeNull();
    expect(result.signature).toMatch(/^[0-9a-f]{128}$/);
  }, 320_000);
});
