// Mobile Capacitor `webDir` PRODUCTION-bundle derive->sign EXECUTION runner.
//
// Why this exists on top of runDeriveSign.mjs: that runner proved a plain,
// self-contained IIFE lib build with its OWN `configFile:false` resolve/define.
// The mobile app, however, is a SEPARATE Vite build TARGET with its OWN config
// (`apps/mobile/vite.config.ts`): the `@vitejs/plugin-react` plugin, the
// `MOBILE_WEB_DIR` outDir, and the shared `stoachainResolve()` correctness
// layer. The bytes Capacitor copies verbatim into the native WebView come from
// THAT config — so the Buffer polyfill, the `node:buffer`->`buffer` redirect,
// the legacy `.cjs` subpath aliases, and the single `@noble/curves@1.9.7`
// instance must be re-proven against an artifact emitted THROUGH the mobile
// config, NOT a fresh plain lib build that ignores it.
//
// Approach: load the mobile `vite.config.ts` itself (`loadConfigFromFile`), so
// we read the EXACT plugins / resolve / define / outDir the shipped mobile build
// uses. We assert the loaded `build.outDir` is MOBILE_WEB_DIR (proving the
// config under test is the webDir build target). Then we `build()` with that
// config's plugins+resolve+define, overriding ONLY the build INPUT to the
// polyfill-first derive->sign harness entry (lib/IIFE so we get one
// self-contained executable chunk). `write:false` keeps the artifact in memory
// so we never clobber the real `dist-web/`. Finally we execute the emitted chunk
// in a `vm` context whose ambient `Buffer` is DELETED and asserted-gone BEFORE
// the bundle's polyfill import runs — a node-native Buffer would MASK the exact
// "Buffer is not defined" production failure this harness exists to catch.
//
// RR#7 / ENVIRONMENT HONESTY: the AUTHORITATIVE WebView env wants a headless
// browser (Playwright/puppeteer), because `delete globalThis.Buffer` does NOT
// stop a CJS `.cjs` module re-acquiring Buffer via `require('buffer')`. No
// headless browser is available in this workspace, so this `vm` run is the
// PRIMARY CI proof (it catches the ESM/aliasing/polyfill/curve failures at the
// bundler level), and the headless-browser WebView run remains a device/ops
// verification that this harness deliberately does NOT claim to cover.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { build, loadConfigFromFile } from 'vite';

const MARKER = '__STOA_WEBDIR_HARNESS_JSON__';
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOBILE_CONFIG = path.join(APP_ROOT, 'vite.config.ts');

async function loadMobileConfig() {
  // Load the SHIPPED mobile vite config so the harness consumes the exact same
  // plugins / resolve / define / outDir the production webDir build uses.
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    MOBILE_CONFIG,
    APP_ROOT,
  );
  if (loaded == null) {
    throw new Error(`could not load mobile vite config at "${MOBILE_CONFIG}"`);
  }
  return loaded.config;
}

async function buildHarnessThroughMobileConfig(mobileConfig) {
  const entry = path.join(APP_ROOT, 'harness', 'harnessEntry.ts');

  // The mobile config's declared webDir outDir. Surfaced so the test can prove
  // the artifact under test came from the webDir build target, not some other.
  const emittedWebDir = mobileConfig.build?.outDir ?? null;

  const output = await build({
    root: APP_ROOT,
    // Reuse the mobile config's plugins (react) + resolve (stoachainResolve:
    // the .cjs aliases, the node:buffer->buffer redirect, the polyfill alias,
    // the @noble/curves single-instance dedupe) + define. We override ONLY the
    // build input to the harness entry so we get one executable chunk; this is
    // the mobile config's correctness layer applied to the derive->sign probe.
    configFile: false,
    logLevel: 'error',
    plugins: mobileConfig.plugins,
    resolve: mobileConfig.resolve,
    define: { 'process.env.NODE_ENV': '"production"', ...(mobileConfig.define ?? {}) },
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
  const code = chunks
    .flatMap((o) => o.output)
    .filter((c) => c.type === 'chunk')
    .map((c) => c.code)
    .join('\n');

  return { code, emittedWebDir };
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
  // browser run that RR#7 leaves as a device/ops verification.
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
  const mobileConfig = await loadMobileConfig();
  const { code, emittedWebDir } = await buildHarnessThroughMobileConfig(mobileConfig);

  // `builtViaMobileConfig` is true only when the loaded mobile config actually
  // contributed the react plugin AND its outDir is the declared webDir — i.e.
  // the artifact is provably from the mobile webDir build target.
  const usesReactPlugin = (mobileConfig.plugins ?? [])
    .flat(Infinity)
    .some((p) => p != null && typeof p === 'object' && String(p.name).includes('react'));
  const builtViaMobileConfig = usesReactPlugin && emittedWebDir != null;

  const exec = await executeBundleWithoutBuffer(APP_ROOT, code);
  const result = { builtViaMobileConfig, emittedWebDir, ...exec };
  process.stdout.write(`${MARKER}${JSON.stringify(result)}\n`);
  if (
    result.error != null ||
    result.bufferWasDefinedBeforePolyfill ||
    !result.builtViaMobileConfig
  ) {
    process.exitCode = 1;
  }
}

await main();
