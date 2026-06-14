import '@stoawallet/core/build/polyfills';

import { uiInfo } from '@stoawallet/ui';
import { coreInfo } from '@stoawallet/core';

import { runDeriveSignHarness } from './deriveSignHarness';
import type { DeriveSignHarnessResult } from './deriveSignHarness';

/**
 * Entry for the Chrome MV3 popup.
 *
 * The Buffer polyfill is the VERY FIRST import (before any @stoachain/core
 * crypto module) so the production bundle has a `Buffer` global at runtime —
 * the shipped upstream polyfill is tree-shaken out of the production build.
 *
 * Beyond the placeholder info string, the entry exposes a real derive->sign
 * execution path (`runDeriveSign`) so the production bundle can be EXERCISED,
 * not merely compiled.
 */
export function bootstrap(): string {
  return `${uiInfo.name} on ${coreInfo.name} (${String(coreInfo.chainCount)} chains)`;
}

export function runDeriveSign(): Promise<DeriveSignHarnessResult> {
  return runDeriveSignHarness();
}
