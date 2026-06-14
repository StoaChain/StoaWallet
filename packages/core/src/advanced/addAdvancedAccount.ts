/**
 * Orchestrator for adding a non-seed (advanced) account to the vault.
 *
 * Composes the Wave-1 building blocks — `classifyAccount` (pure), the injectable
 * `fetchAccountGuard` read seam, and the pure `analyzeWalletGuard` — into a single
 * discriminated outcome and an ATOMIC persist. It never throws: every failure
 * surfaces as a typed `{ ok: false, reason }` so the UI branches on a value.
 *
 * BINDING DECISIONS encoded here:
 *  - A `k:` account whose pubkey is ALREADY a derived wallet account is NOT an
 *    advanced add — it is the wallet's own account — so it short-circuits to
 *    `already-derived` (no fetch, nothing persisted).
 *  - not-found vs not-key-guarded are DISTINCT reasons (a real account with an
 *    unsignable guard is a different problem from no account at all).
 *  - An UNRECOGNIZED predicate ALWAYS yields watch-only regardless of the SDK's
 *    keys-all fallback `satisfied` bit; the `predicateRecognized` flag is carried
 *    in the outcome so the UI can warn rather than offer a (wrongly) signable add.
 *
 * SECURITY: no `console.*`/logger; the non-keyset `detail` is scrubbed to a
 * stable label and never carries guard internals or key material.
 */

import type { StorageAdapter } from '../storage';
import { VAULT_KEY } from '../storage/storageKeys';
import {
  deserializeVault,
  serializeVault,
  advancedAccountsOf,
} from '../keyring/vault';
import type {
  AdvancedAccount,
  GuardSummary,
  Vault,
} from '../keyring/vault';
import { classifyAccount } from './classifyAccount';
import { fetchAccountGuard } from './fetchAccountGuard';
import type { AccountGuardResult } from './fetchAccountGuard';
import { analyzeWalletGuard } from './analyzeWalletGuard';

/** The guard read seam, injectable so tests stay fully off-network. */
export type FetchGuardFn = (
  address: string,
  chainId: string,
) => Promise<AccountGuardResult>;

export interface AddAdvancedAccountInput {
  readonly address: string;
  readonly chainId: string;
  /** Public keys the wallet can currently sign for (derived + pasted). */
  readonly walletPubSet: Set<string>;
}

export interface AddAdvancedAccountDeps {
  /** Defaults to `fetchAccountGuard`; overridden in tests with a stub. */
  readonly fetchGuard?: FetchGuardFn;
  readonly storage: StorageAdapter;
}

/** A send-capable add: the keyset is satisfied and its predicate recognized. */
export interface AddSendCapableResult {
  readonly ok: true;
  readonly mode: 'send-capable';
  readonly account: AdvancedAccount;
}

/**
 * A watch-only add: either the keyset is unsatisfiable (`neededMore > 0`) or its
 * predicate was unrecognized (`predicateRecognized === false`). Both flags are
 * surfaced so the UI can render "needs N more keys" and/or an unknown-predicate
 * warning. NEVER send-capable.
 */
export interface AddWatchOnlyResult {
  readonly ok: true;
  readonly mode: 'watch-only';
  readonly account: AdvancedAccount;
  readonly neededMore: number;
  readonly predicateRecognized: boolean;
}

export type AddAdvancedAccountFailureReason =
  | 'invalid-address'
  | 'already-derived'
  | 'account-not-found'
  | 'not-key-guarded';

export interface AddAdvancedAccountFailure {
  readonly ok: false;
  readonly reason: AddAdvancedAccountFailureReason;
  /** Scrubbed, key-free label for the not-key-guarded case. */
  readonly detail?: string;
}

export type AddAdvancedAccountResult =
  | AddSendCapableResult
  | AddWatchOnlyResult
  | AddAdvancedAccountFailure;

/** Append an advanced account and persist the WHOLE vault in one write. */
async function persistAppended(
  storage: StorageAdapter,
  vault: Vault,
  account: AdvancedAccount,
): Promise<void> {
  const next: Vault = {
    ...vault,
    advancedAccounts: [...advancedAccountsOf(vault), account],
  };
  await storage.set(VAULT_KEY, serializeVault(next));
}

function makeId(address: string): string {
  return `adv-${address}-${Date.now()}`;
}

export async function addAdvancedAccount(
  input: AddAdvancedAccountInput,
  deps: AddAdvancedAccountDeps,
): Promise<AddAdvancedAccountResult> {
  const { address, chainId, walletPubSet } = input;
  const fetchGuard = deps.fetchGuard ?? fetchAccountGuard;

  const classification = classifyAccount(address);
  if (!('type' in classification)) {
    return { ok: false, reason: 'invalid-address' };
  }

  // A k: account the wallet already derives is its own account, not an
  // advanced add — short-circuit before any network read or persist.
  if (
    classification.type === 'k-account' &&
    classification.pubkey !== null &&
    walletPubSet.has(classification.pubkey)
  ) {
    return { ok: false, reason: 'already-derived' };
  }

  const guard = await fetchGuard(address, chainId);

  if (!guard.exists) {
    return { ok: false, reason: 'account-not-found' };
  }
  if (!guard.isKeyset) {
    return {
      ok: false,
      reason: 'not-key-guarded',
      detail: 'Account guard is not a signable keyset.',
    };
  }

  const analysis = analyzeWalletGuard(
    { keys: guard.keys, pred: guard.pred },
    walletPubSet,
  );

  const summary: GuardSummary = {
    pred: analysis.pred,
    threshold: analysis.threshold,
    neededMore: analysis.neededMore,
    predicateRecognized: analysis.predicateRecognized,
    keys: analysis.keys,
  };

  const vault = deserializeVault((await deps.storage.get(VAULT_KEY)) as string);
  const base = {
    id: makeId(address),
    address,
    type: classification.type,
    guardSummary: summary,
    createdAt: new Date().toISOString(),
    // Record the chain the guard was read on so a later paste-validation can
    // re-fetch the LIVE keyset on the same chain (RR#5).
    chainId,
  } as const;

  // An unrecognized predicate ALWAYS forces watch-only, regardless of the SDK's
  // conservative keys-all-fallback `satisfied` bit.
  const sendCapable = analysis.satisfied && analysis.predicateRecognized;

  if (sendCapable) {
    const account: AdvancedAccount = { ...base, mode: 'send-capable' };
    await persistAppended(deps.storage, vault, account);
    return { ok: true, mode: 'send-capable', account };
  }

  const account: AdvancedAccount = { ...base, mode: 'watch-only' };
  await persistAppended(deps.storage, vault, account);
  return {
    ok: true,
    mode: 'watch-only',
    account,
    neededMore: analysis.neededMore,
    predicateRecognized: analysis.predicateRecognized,
  };
}
