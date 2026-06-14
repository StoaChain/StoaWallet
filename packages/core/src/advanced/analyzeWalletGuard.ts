/**
 * Pure, I/O-free guard-satisfaction analysis for the wallet.
 *
 * Thin wrapper over `buildCodexPubSet` + `analyzeGuard` from
 * `@stoachain/stoa-core/guard`. It does NOT reimplement threshold or predicate
 * math — that lives in the SDK. Its job is to bridge the wallet's persisted
 * account shape to the SDK and to surface the SDK's analysis verbatim.
 *
 * SECURITY: `resolvedManualKeys` maps a public key to a pasted PRIVATE key for a
 * transient pre-persist re-analysis. It is threaded straight through to the SDK
 * and is NEVER logged here. No code in this module prints key material.
 */
import { analyzeGuard, buildCodexPubSet } from '@stoachain/stoa-core/guard';
import type { GuardAnalysis } from '@stoachain/stoa-core/guard';
import type { StoredAccount } from '../keyring/vault';

export type { GuardAnalysis };

/** A bare public-key carrier — the minimum the Codex set builder reads. */
export interface PubKeyCarrier {
  readonly publicKey: string;
}

/**
 * Build the set of public keys the wallet can sign for.
 *
 * Delegates to `buildCodexPubSet(kadenaSeeds?, kadenaAccounts?, pureKeypairs?)`.
 * The wallet's DERIVED accounts are a FLAT list of `{publicKey, ...}` records,
 * so they go in the SECOND argument (`kadenaAccounts`) — the slot whose elements
 * are read as `a.publicKey` directly. The first slot (`kadenaSeeds`) expects
 * objects with a nested `.accounts[]`; passing flat accounts there would add
 * NOTHING to the set and make every account wrongly appear watch-only.
 */
export function buildWalletPubSet(
  walletAccounts: readonly StoredAccount[],
  pureKeypairs?: readonly PubKeyCarrier[],
): Set<string> {
  // buildCodexPubSet reads each element's `.publicKey`; the SDK params are
  // mutable `any[]`, so copy our readonly inputs into plain arrays.
  return buildCodexPubSet(
    undefined,
    [...walletAccounts],
    pureKeypairs ? [...pureKeypairs] : undefined,
  );
}

/**
 * Analyze a keyset guard against the wallet's signable public keys.
 *
 * Delegates to `analyzeGuard` and returns the SDK's `GuardAnalysis` unchanged,
 * including `predicateRecognized` (false when the SDK fell back to conservative
 * keys-all semantics for an unfamiliar predicate) so the caller can warn rather
 * than sign blindly.
 */
export function analyzeWalletGuard(
  guard: { keys: string[]; pred: string },
  walletPubSet: Set<string>,
  resolvedManualKeys?: Record<string, string>,
): GuardAnalysis {
  return analyzeGuard(guard, walletPubSet, resolvedManualKeys);
}
