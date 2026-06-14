// Production-bundle derive->sign EXECUTION runner for the extension app.
//
// Why this exists: a clean `vite build` exit code proves only that the bundle
// COMPILED. The "Buffer is not defined" and `@noble/curves` duplicate-instance
// failures are dev-tolerant and surface ONLY when the built bundle EXECUTES.
// So this runner production-builds the polyfill-first harness entry, then runs
// it in a context with NO ambient `Buffer` — the exact condition a browser /
// MV3 service worker presents — and reports the EXECUTED result.
//
// No headless browser (Playwright/Puppeteer) is available in this workspace,
// so we execute the IIFE bundle in a fresh Node `vm` context. The critical
// guarantee: the vm context's `Buffer` is DELETED and asserted-undefined
// BEFORE the bundle (and therefore its polyfill import) runs. A node+jsdom
// loader that left Node's native Buffer in place would MASK the precise
// "Buffer is not defined" failure — which is why we remove it explicitly.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { build } from 'vite';

import { stoachainResolve } from '../../../packages/core/src/build/viteStoachain.ts';

const MARKER = '__STOA_HARNESS_JSON__';
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function buildHarnessBundle(appRoot) {
  const entry = path.join(appRoot, 'harness', 'harnessEntry.ts');

  // IIFE lib build: one self-contained file with every dep (including the
  // `buffer` npm polyfill) inlined. `write: false` keeps the artifact in
  // memory so we control exactly what executes.
  const output = await build({
    root: appRoot,
    // Do NOT load apps/extension/vite.config.ts — it registers @crxjs `crx()`
    // (the MV3 manifest plugin), which fails in this standalone IIFE lib build.
    // This harness is intentionally self-contained (its own resolve/define).
    configFile: false,
    logLevel: 'error',
    resolve: stoachainResolve(),
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      write: false,
      minify: false,
      target: 'es2022',
      lib: {
        entry,
        formats: ['iife'],
        name: '__StoaHarness',
        fileName: () => 'harness.iife.js',
      },
    },
  });

  const chunks = Array.isArray(output) ? output : [output];
  return chunks
    .flatMap((o) => o.output)
    .filter((c) => c.type === 'chunk')
    .map((c) => c.code)
    .join('\n');
}

async function executeBundleWithoutBuffer(appRoot, bundleCode) {
  const appRequire = createRequire(path.join(appRoot, 'noop.js'));

  const sandbox = {
    globalThis: undefined,
    console,
    process,
    require: appRequire,
    TextEncoder,
    TextDecoder,
    URL,
    crypto: globalThis.crypto,
    setTimeout,
    clearTimeout,
    queueMicrotask,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  // Minimal DOM stub: some bundled deps read `document` at module-eval time
  // (feature-detection), but the crypto derive->sign path never touches it.
  // This is a non-DOM execution check; it does NOT substitute for the headless
  // browser run that Phase 7/8 must perform under the real build pipeline.
  sandbox.document = { createElement: () => ({}), documentElement: {} };

  vm.createContext(sandbox);

  // Remove any ambient Buffer the host leaked into the sandbox, then PROVE it
  // is gone before the bundle (and its polyfill) executes. If this assertion
  // ever flips true, the test would be masking the real production failure.
  vm.runInContext('delete globalThis.Buffer; delete this.Buffer;', sandbox);
  const bufferWasDefinedBeforePolyfill = vm.runInContext(
    "typeof globalThis.Buffer !== 'undefined'",
    sandbox,
  );

  let error = null;
  let signature = null;
  try {
    vm.runInContext(bundleCode, sandbox, { filename: 'harness.iife.js' });
    const run = sandbox.__STOA_RUN_DERIVE_SIGN__;
    if (typeof run !== 'function') {
      throw new Error('bundle did not expose __STOA_RUN_DERIVE_SIGN__');
    }
    const result = await run();
    signature = result.signature;
    error = result.error;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return { bufferWasDefinedBeforePolyfill, signature, error };
}

async function main() {
  const bundleCode = await buildHarnessBundle(APP_ROOT);
  const result = await executeBundleWithoutBuffer(APP_ROOT, bundleCode);
  process.stdout.write(`${MARKER}${JSON.stringify(result)}\n`);
  if (result.error != null || result.bufferWasDefinedBeforePolyfill) {
    process.exitCode = 1;
  }
}

await main();
