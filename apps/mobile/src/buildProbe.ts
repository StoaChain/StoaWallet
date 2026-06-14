// Build-correctness probe (owned by the shared build layer, NOT app business
// logic). Its sole purpose is to make a production `vite build` actually
// exercise the @stoachain build-correctness aliases:
//   - the Buffer polyfill must be the FIRST import (before any @stoachain code)
//   - a named import from a legacy `.cjs` subpath must resolve through the
//     anchored alias without an "unresolved import" / "no named export" error
//
// The real derive->sign entry path is wired in a later phase; this probe is
// only here so the build proves the alias + polyfill work end to end.
import '@stoawallet/core/build/polyfills';

import { kadenaGenMnemonic } from '@stoachain/kadena-stoic-legacy/hd-wallet';

export function buildProbe(): boolean {
  // Touch both the polyfilled global and the aliased named export so the
  // bundler cannot tree-shake either away.
  return typeof globalThis.Buffer !== 'undefined' && typeof kadenaGenMnemonic === 'function';
}
