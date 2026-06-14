/**
 * Advanced-account key resolution: importing a pasted foreign key into the vault
 * and assembling the keypair SET that satisfies an advanced account's guard at
 * sign time. This module COMPOSES the pure analysis/validation primitives
 * (`analyzeWalletGuard`, `validatePastedKey`, `encryptPureKeypair`,
 * `selectCapsSigningKey`) — it never reimplements threshold, derivation, or
 * cap-selection math.
 *
 * SECRET HANDLING (highest priority):
 *  - The pasted PRIVATE key, the wallet PASSWORD, the wallet MNEMONIC, and any
 *    DECRYPTED pure-key material are secrets. None is ever logged (no console.*
 *    / logger call receives them) and none is persisted in plaintext.
 *  - Outcomes are DISCRIMINATED results, never thrown Errors that could carry
 *    secret-bearing messages.
 *  - Decrypted private keys produced by `resolveAdvancedSigningKeypairs` live
 *    ONLY on the returned in-memory keypair objects, handed straight to the
 *    Phase-4/5 signer; they are never written back to the vault.
 */

import { smartDecrypt } from '@stoachain/stoa-core/crypto';
import { classifyPaymentKey, selectCapsSigningKey } from '@stoachain/stoa-core/guard';
import { binToHex } from '@stoachain/kadena-stoic-legacy/cryptography-utils';
import { kadenaDecrypt } from '@stoachain/kadena-stoic-legacy/hd-wallet';

import type { StorageAdapter } from '../storage/StorageAdapter';
import type { SignableKeypair } from '../api/sign';
import { deriveAccount } from '../api/derive';
import { VAULT_KEY } from '../storage/storageKeys';
import {
  deserializeVault,
  serializeVault,
  advancedAccountsOf,
  pureKeypairsOf,
  type AdvancedAccount,
  type IPureKeypair,
  type Vault,
} from '../keyring/vault';
import { analyzeWalletGuard, buildWalletPubSet } from './analyzeWalletGuard';
import { validatePastedKey, encryptPureKeypair } from './pastedKey';
import { transitionAdvancedAccount } from './model';

/** A keyset guard as the SDK analysis layer consumes it. */
export interface Keyset {
  readonly keys: string[];
  readonly pred: string;
}

/** Inputs for {@link resolveForeignKey}. */
export interface ResolveForeignKeyInput {
  readonly account: AdvancedAccount;
  /** The user-pasted private key (64- or 128-char hex). SECRET — never logged. */
  readonly privateKey: string;
  /** Public keys the wallet can already sign for (derived + accepted pure keys). */
  readonly walletPubSet: Set<string>;
  /** The vault password binding both the new envelope and existing pure keys. */
  readonly walletPassword: string;
  /**
   * The keyset re-fetched fresh before validation (RR#5). When omitted, the
   * account's recorded `guardSummary` is used (tests may pass it explicitly).
   */
  readonly freshGuard?: Keyset;
}

/** Side-effect dependencies for {@link resolveForeignKey}. */
export interface ResolveForeignKeyDeps {
  readonly storage: StorageAdapter;
}

/** Discriminated outcome of {@link resolveForeignKey}. */
export type ResolveForeignKeyResult =
  | { ok: true; mode: 'send-capable' }
  | { ok: true; mode: 'watch-only'; neededMore: number }
  | {
      ok: false;
      reason: 'bad-format' | 'key-mismatch' | 'invalid-key' | 'guard-changed';
    };

/**
 * Read the vault blob from storage. The blob in this flow is plain serialized
 * vault JSON (the advanced collections live unencrypted alongside the encrypted
 * per-wallet phrase); `null` means an uninitialized vault.
 */
async function loadVault(storage: StorageAdapter): Promise<Vault | null> {
  const raw = await storage.get(VAULT_KEY);
  if (raw === null) return null;
  const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  return deserializeVault(text);
}

/** The keys of the guard to validate against, after the fresh re-fetch (RR#5). */
function resolveKeyset(input: ResolveForeignKeyInput): Keyset {
  if (input.freshGuard) return input.freshGuard;
  const summary = input.account.guardSummary;
  return { keys: [...(summary?.keys ?? [])], pred: summary?.pred ?? 'keys-all' };
}

/**
 * Has the fresh keyset diverged from what the account recorded in a way that
 * invalidates this resolution? Conservative (RR#5): if the account recorded a
 * guard and the fresh keyset no longer contains EVERY recorded key, the on-chain
 * keyset rotated under us — refuse rather than persist against a stale guard.
 */
function guardChanged(account: AdvancedAccount, fresh: Keyset): boolean {
  const recorded = account.guardSummary?.keys;
  if (!recorded || recorded.length === 0) return false;
  const freshSet = new Set(fresh.keys);
  return recorded.some((key) => !freshSet.has(key));
}

/**
 * Resolve a pasted foreign key for an advanced account.
 *
 * Validates the paste against the FRESH keyset, encrypts and persists the key on
 * success, then re-analyzes the guard through a SINGLE channel (the rebuilt pub
 * set — RR#4) to decide promotion. A promotion only ever follows a
 * guard-satisfying re-analysis; the function never auto-promotes.
 */
export async function resolveForeignKey(
  input: ResolveForeignKeyInput,
  deps: ResolveForeignKeyDeps,
): Promise<ResolveForeignKeyResult> {
  const { account, privateKey, walletPassword } = input;
  const guard = resolveKeyset(input);

  // RR#5: refuse before persisting anything if the re-fetched keyset rotated
  // away from what this account recorded.
  if (guardChanged(account, guard)) {
    return { ok: false, reason: 'guard-changed' };
  }

  // Validate against the FRESH keys — distinct failure reasons, nothing persisted.
  const validation = validatePastedKey(privateKey, guard.keys);
  if (!validation.ok) {
    return { ok: false, reason: validation.reason };
  }

  // Encrypt the validated key and persist it atomically: load -> append -> write.
  const record = await encryptPureKeypair(
    privateKey,
    validation.publicKey,
    walletPassword,
  );

  const vault = await loadVault(deps.storage);
  const existingPure: readonly IPureKeypair[] = vault ? pureKeypairsOf(vault) : [];
  const updatedPureKeypairs: IPureKeypair[] = [...existingPure, record];

  // RR#4: re-analyze through ONE channel — the rebuilt pub set with the new key
  // in the pureKeypairs slot, NO transient resolvedManualKeys. The key counts
  // EXACTLY ONCE.
  const walletAccounts = vault?.wallets.flatMap((w) => w.accounts) ?? [];
  const updatedPubSet = buildWalletPubSet(walletAccounts, updatedPureKeypairs);
  const analysis = analyzeWalletGuard(guard, updatedPubSet);

  const advancedAccounts = vault ? advancedAccountsOf(vault) : [];
  const promote = analysis.satisfied;
  const nextAccount = promote
    ? transitionAdvancedAccount(account, 'send-capable')
    : account;

  const nextVault: Vault = {
    wallets: vault?.wallets ?? [],
    activeWalletId: vault?.activeWalletId ?? '',
    pureKeypairs: updatedPureKeypairs,
    advancedAccounts: advancedAccounts.map((existing) =>
      existing.id === account.id ? nextAccount : existing,
    ),
  };

  await deps.storage.set(VAULT_KEY, serializeVault(nextVault));

  if (promote) {
    return { ok: true, mode: 'send-capable' };
  }
  return { ok: true, mode: 'watch-only', neededMore: analysis.neededMore };
}

/** Discriminated outcome of {@link resolveAdvancedSigningKeypairs}. */
export type ResolveSigningKeypairsResult =
  | {
      ok: true;
      /** The SET of keypairs satisfying the guard, for the Phase-4/5 signer. */
      keypairs: readonly SignableKeypair[];
      /** The selected gas-payer cap signer (never null on the ok path). */
      gasPayerSigner: SignableKeypair;
    }
  | { ok: false; reason: 'impossible-overlap' | 'insufficient-keys' };

/**
 * Assemble the keypair SET that satisfies an advanced account's guard.
 *
 * In-wallet guard keys are re-derived from the unlocked mnemonic
 * (`deriveAccount`), accepted pure keys are decrypted (`smartDecrypt`). The
 * gas-payer cap signer is chosen via `selectCapsSigningKey`.
 *
 * REFUSALS (never an unsignable / null-signer send path):
 *  - `impossible-overlap` — the only eligible cap-signer is itself a pure-signing
 *    key (RR#1: `selectCapsSigningKey` reports `impossible` or returns `key: null`).
 *  - `insufficient-keys` — not enough guard keys could be assembled to meet the
 *    threshold.
 *
 * Decrypted private keys live ONLY on the returned in-memory keypairs.
 */
export async function resolveAdvancedSigningKeypairs(
  account: AdvancedAccount,
  guard: Keyset,
  vault: Vault,
  unlockedMnemonic: string,
  walletPassword: string,
): Promise<ResolveSigningKeypairsResult> {
  const guardKeys = new Set(guard.keys);

  // Map every public key the wallet can derive to its source account index, so a
  // guard key can be re-derived on demand without scanning the whole wallet.
  const derivedIndexByPub = new Map<string, number>();
  for (const wallet of vault.wallets) {
    for (const acc of wallet.accounts) {
      if (guardKeys.has(acc.publicKey)) {
        derivedIndexByPub.set(acc.publicKey, acc.index);
      }
    }
  }

  const pureByPub = new Map<string, IPureKeypair>();
  for (const kp of pureKeypairsOf(vault)) {
    if (guardKeys.has(kp.publicKey)) {
      pureByPub.set(kp.publicKey, kp);
    }
  }

  // Assemble one keypair per guard key we can actually sign for. A guard key with
  // neither a derivable nor a decryptable source is simply unresolved.
  const keypairs: SignableKeypair[] = [];
  const pureSigningPubs = new Set<string>();
  const codexPubs = new Set<string>();

  for (const key of guard.keys) {
    const derivedIndex = derivedIndexByPub.get(key);
    if (derivedIndex !== undefined) {
      const derived = await deriveAccount(
        unlockedMnemonic,
        walletPassword,
        derivedIndex,
      );
      // Decrypt the at-rest secret back to its raw 32-byte private key so the
      // keypair is SIGN-READY on the koala nacl Ed25519 route — mirrors
      // KeyringManager.resolveActiveSigningKeypairs. Passing the still-encrypted
      // envelope here would route to nacl with an empty secret (broken signature).
      const rawSecret = await kadenaDecrypt(
        walletPassword,
        derived.encryptedSecretKey,
      );
      const secretBytes =
        rawSecret instanceof Uint8Array
          ? rawSecret
          : new Uint8Array(rawSecret as ArrayLike<number>);
      keypairs.push({
        publicKey: derived.publicKey,
        privateKey: binToHex(secretBytes),
        seedType: 'koala',
      });
      codexPubs.add(derived.publicKey);
      continue;
    }

    const pure = pureByPub.get(key);
    if (pure) {
      const privateKey = await smartDecrypt(
        pure.encryptedPrivateKey,
        walletPassword,
      );
      keypairs.push({ publicKey: pure.publicKey, privateKey });
      pureSigningPubs.add(pure.publicKey);
    }
  }

  // UNSATISFIABLE: we could not assemble enough keys to meet the threshold. The
  // threshold comes from the recorded guard summary; a malformed account with no
  // summary cannot be proven satisfiable, so it conservatively refuses rather
  // than throwing in this key-material-bearing path.
  const threshold = account.guardSummary?.threshold;
  if (threshold === undefined || keypairs.length < threshold) {
    return { ok: false, reason: 'insufficient-keys' };
  }

  // Gas-payer cap signer. The payment pubkey is the k-account's single pubkey
  // (null for a custom-account address, which selectCapsSigningKey tolerates).
  const paymentInfo = classifyPaymentKey(account.address);
  const paymentKeyPub = paymentInfo?.pubkey ?? null;
  const capSelection = selectCapsSigningKey(
    paymentKeyPub,
    codexPubs,
    pureSigningPubs,
  );

  // RR#1: never pass a null/empty cap-signer into a send path.
  if (capSelection.impossible || capSelection.key === null) {
    return { ok: false, reason: 'impossible-overlap' };
  }

  const gasPayerSigner = keypairs.find(
    (kp) => kp.publicKey === capSelection.key,
  );
  if (gasPayerSigner === undefined) {
    // The selected cap key is not among the assembled signers — treat as an
    // unsignable assembly rather than emitting a partial signer set.
    return { ok: false, reason: 'insufficient-keys' };
  }

  return { ok: true, keypairs, gasPayerSigner };
}
