// Build entry for the production derive->sign EXECUTION harness.
//
// The polyfill-first import chain lives in `runDeriveSignHarness`; this entry
// only publishes it onto a global so the runner can invoke it after loading
// the built bundle in a Buffer-free context.
import { runDeriveSignHarness } from '../src/deriveSignHarness';

(globalThis as { __STOA_RUN_DERIVE_SIGN__?: typeof runDeriveSignHarness }).__STOA_RUN_DERIVE_SIGN__ =
  runDeriveSignHarness;
