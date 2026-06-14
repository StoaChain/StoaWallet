// @crxjs SERVICE-WORKER-bundle derive->sign EXECUTION runner for the extension.
//
// Why this exists on top of runDeriveSign.mjs: that runner proved the plain
// popup-style (Vite lib) bundle. But @crxjs bundles `background.service_worker`
// as a SEPARATE Rollup input with its OWN tree-shaking pass — and the upstream
// @stoachain Buffer polyfill is dropped under `sideEffects:false`. So the
// polyfill-first ordering, the `node:buffer`->`buffer` redirect, the legacy
// `.cjs` subpath aliases, and the single `@noble/curves` instance must be
// re-proven for the SW bundling pass SPECIFICALLY. A green popup bundle does
// NOT transfer that guarantee to the SW input.
//
// Approach (a): drive the REAL @crxjs SW bundling pass. We give `crx({ manifest })`
// a harness-only manifest whose ONLY `background.service_worker` points at the
// polyfill-first `deriveSignSW.entry.ts`. @crxjs registers it as the SW Rollup
// input (the same plugin/rollup-input treatment the real SW gets), rewrites the
// manifest's `background.service_worker` to a `service-worker-loader.js` that
// imports the hashed SW chunk, and emits all three. We resolve the SW chunk by
// walking the EMITTED manifest -> loader -> chunk (proving it is the @crxjs SW
// artifact, not a plain lib output), then execute that chunk in a `vm` context
// whose ambient `Buffer` is DELETED and asserted-gone BEFORE the bundle's
// polyfill import runs. A node-native Buffer would MASK the precise
// "Buffer is not defined" failure, so we remove it explicitly.
//
// No headless browser is available here; the `vm` run is a non-DOM execution
// check of the crypto derive->sign path, which never touches the DOM.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { crx, defineManifest } from '@crxjs/vite-plugin';
import { build } from 'vite';

import { stoachainResolve } from '../../../packages/core/src/build/viteStoachain.ts';

const MARKER = '__STOA_SW_HARNESS_JSON__';
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Harness-only manifest: a single `background.service_worker` so @crxjs's SW
// Rollup-input pass is exercised in isolation (no popup input to share chunks
// with). The entry is the polyfill-first derive->sign probe.
const harnessManifest = defineManifest({
  manifest_version: 3,
  name: 'StoaHarnessSW',
  version: '0.0.1',
  background: { service_worker: 'harness/deriveSignSW.entry.ts', type: 'module' },
});

function collectOutputChunks(buildResult) {
  // `crx({ manifest })` with `write:false` keeps every emitted asset (the
  // rewritten manifest.json, the service-worker-loader.js, and the hashed SW
  // chunk) in the in-memory Rollup `output` array, so we control exactly what
  // executes — nothing is read off disk.
  const results = Array.isArray(buildResult) ? buildResult : [buildResult];
  const byFileName = new Map();
  for (const r of results) {
    for (const item of r.output) {
      byFileName.set(item.fileName, item);
    }
  }
  return byFileName;
}

function readAssetText(item) {
  if (item == null) return null;
  if (item.type === 'chunk') return item.code;
  const src = item.source;
  return typeof src === 'string' ? src : Buffer.from(src).toString('utf8');
}

/**
 * Resolve the SW chunk THROUGH the @crxjs-rewritten manifest, so the artifact
 * under test is provably the @crxjs SW bundling output:
 *   manifest.json.background.service_worker -> service-worker-loader.js
 *   -> `import './assets/<hashed SW chunk>.js'`
 * Returns { code, bundledViaCrxSwPass }.
 */
function resolveSwChunk(byFileName) {
  const manifestItem = byFileName.get('manifest.json');
  const manifestText = readAssetText(manifestItem);
  if (manifestText == null) {
    return { code: null, bundledViaCrxSwPass: false };
  }
  const manifest = JSON.parse(manifestText);
  const swRef = manifest?.background?.service_worker;
  // @crxjs rewrites `background.service_worker` to a generated loader module
  // (not the raw entry path). That rewrite is the signature of the SW pass.
  if (typeof swRef !== 'string' || !swRef.includes('service-worker-loader')) {
    return { code: null, bundledViaCrxSwPass: false };
  }
  const loaderText = readAssetText(byFileName.get(swRef.replace(/^\/+/, '')));
  if (loaderText == null) {
    return { code: null, bundledViaCrxSwPass: false };
  }
  const chunkRef = loaderText.match(/import\s+['"]\.?\/?(.+?)['"]/)?.[1];
  if (chunkRef == null) {
    return { code: null, bundledViaCrxSwPass: false };
  }
  const chunkCode = readAssetText(byFileName.get(chunkRef.replace(/^\/+/, '')));
  if (chunkCode == null) {
    return { code: null, bundledViaCrxSwPass: false };
  }
  return { code: chunkCode, bundledViaCrxSwPass: true };
}

async function buildSwBundle(appRoot) {
  const output = await build({
    root: appRoot,
    // Do NOT load apps/extension/vite.config.ts: this harness supplies its OWN
    // single-SW manifest to crx(). It still routes through the SAME crx() plugin
    // and the SAME stoachainResolve() correctness layer the real build uses, so
    // the SW input gets the identical rollup-input treatment.
    configFile: false,
    logLevel: 'error',
    plugins: [crx({ manifest: harnessManifest })],
    resolve: stoachainResolve(),
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      write: false,
      minify: false,
      target: 'es2022',
    },
  });

  return collectOutputChunks(output);
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
  sandbox.document = { createElement: () => ({}), documentElement: {} };

  vm.createContext(sandbox);

  // Remove any ambient Buffer the host leaked into the sandbox, then PROVE it is
  // gone before the bundle (and its polyfill) executes. If this assertion ever
  // flips true, the test would be masking the real production failure.
  vm.runInContext('delete globalThis.Buffer; delete this.Buffer;', sandbox);
  const bufferWasDefinedBeforePolyfill = vm.runInContext(
    "typeof globalThis.Buffer !== 'undefined'",
    sandbox,
  );

  let error = null;
  let signature = null;
  try {
    vm.runInContext(bundleCode, sandbox, { filename: 'sw-bundle.js' });
    const run = sandbox.__STOA_RUN_DERIVE_SIGN__;
    if (typeof run !== 'function') {
      throw new Error('SW bundle did not expose __STOA_RUN_DERIVE_SIGN__');
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
  const byFileName = await buildSwBundle(APP_ROOT);
  const { code, bundledViaCrxSwPass } = resolveSwChunk(byFileName);

  if (!bundledViaCrxSwPass || code == null) {
    process.stdout.write(
      `${MARKER}${JSON.stringify({
        bundledViaCrxSwPass,
        bufferWasDefinedBeforePolyfill: false,
        signature: null,
        error: 'could not resolve the @crxjs SW chunk from the emitted manifest/loader',
      })}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const exec = await executeBundleWithoutBuffer(APP_ROOT, code);
  const result = { bundledViaCrxSwPass, ...exec };
  process.stdout.write(`${MARKER}${JSON.stringify(result)}\n`);
  if (result.error != null || result.bufferWasDefinedBeforePolyfill) {
    process.exitCode = 1;
  }
}

await main();
