// @crxjs SERVICE-WORKER build entry for the derive->sign EXECUTION harness.
//
// A harness-only @crxjs manifest points its `background.service_worker` at THIS
// file, so it goes through the exact Rollup-input + tree-shaking treatment the
// real `src/background/index.ts` SW gets — the separate-input pass that a green
// popup/lib bundle does NOT prove. The polyfill-first import chain lives in
// `runDeriveSignHarness`; this entry only publishes it onto a global so the
// runner can invoke it after loading the emitted SW chunk in a Buffer-free
// context. The real SW imports the polyfill FIRST for the same reason, so this
// entry mirrors that ordering by re-exporting through `deriveSignHarness`.
import { runDeriveSignHarness } from '../src/deriveSignHarness';

(globalThis as { __STOA_RUN_DERIVE_SIGN__?: typeof runDeriveSignHarness }).__STOA_RUN_DERIVE_SIGN__ =
  runDeriveSignHarness;
