/**
 * Vault domain model + PURE (de)serialization.
 *
 * This module is the persisted shape of the wallet and NOTHING else: no crypto,
 * no storage I/O. It defines the at-rest types and a lossless string<->Vault
 * round-trip. Encryption of the seed phrase and reading/writing the blob live
 * in sibling modules (`encryptAtRest.ts`, the storage layer); keeping this file
 * pure makes the serialization independently testable and side-effect free.
 *
 * SECURITY INVARIANT: no plaintext secret is representable here. `encryptedPhrase`
 * is a branded `EncryptedBlob` (a plaintext string is not assignable to it), and
 * neither `StoredWallet` nor its accounts carry any `secretKey`/`privateKey`
 * field — a derived private key is STRUCTURALLY absent, so there is no compile-time
 * path that persists one. Per-account signing material is re-derived/decrypted at
 * sign time from `encryptedPhrase`; it is never stored alongside the account.
 */

/**
 * Opaque at-rest envelope of the wallet's seed phrase.
 *
 * Branded so a plaintext string cannot be assigned to `encryptedPhrase`. This
 * is a LOCAL brand rather than a reuse of the SDK's
 * `@stoachain/kadena-stoic-legacy/hd-wallet` `EncryptedString` on purpose:
 * `EncryptedString` brands a per-keypair encrypted SECRET KEY (what `deriveAccount`
 * returns), whereas this brands the encrypted whole-mnemonic PHRASE for the
 * vault. They are different envelopes with different lifetimes; conflating them
 * would let an account secret be stored where a vault phrase belongs (and vice
 * versa). The unique-symbol brand makes `EncryptedBlob` nominally distinct.
 */
export type EncryptedBlob = string & { readonly __encrypted: unique symbol };

/** A 24-word koala (BIP39) seed is the only seed type the wallet onboards. */
export type SeedType = 'koala';

/**
 * A raw keypair pasted/imported directly into the vault, NOT derived from a
 * wallet's seed. The private key is ALWAYS the `encryptedPrivateKey` field —
 * there is no plaintext private-key field — so the same at-rest invariant as
 * `encryptedPhrase` holds: no plaintext signing material is representable.
 *
 * Shape mirrors the SDK's `IPureKeypair` public surface (id/label/publicKey/
 * encryptedPrivateKey/createdAt). The SDK's codex-specific marker flags
 * (`isCodexGuard`, etc.) are intentionally DROPPED: this vault has no codex
 * lifecycle, so those roles do not apply here.
 *
 * Pure keypairs are VAULT-GLOBAL (not nested under a single `StoredWallet`).
 * A pasted key may satisfy the guard of an advanced account regardless of which
 * seed wallet is active, so scoping it to one wallet would wrongly hide it from
 * guards on others. Keeping the pool flat at the vault level lets any advanced
 * account locate a satisfying key (see `findPureKeypairByPubkey`).
 */
export interface IPureKeypair {
  readonly id: string;
  readonly label?: string;
  /** 64-char hex Ed25519 public key. */
  readonly publicKey: string;
  /** Encrypted at the vault password — the ONLY home of the private key. */
  readonly encryptedPrivateKey: string;
  readonly createdAt: string;
}

/** Capability flag for an advanced account. EXPLICIT and load-bearing. */
export type AdvancedAccountMode = 'watch-only' | 'send-capable';

/** Whether the advanced account is a single-key `k:` address or a custom guard. */
export type AdvancedAccountType = 'k-account' | 'custom-account';

/**
 * Summary of the on-chain guard protecting an advanced account, used to render
 * "needs N more keys" and to decide send-capability. `neededMore` is how many
 * more satisfying keys must be present to meet `threshold`; `predicateRecognized`
 * is whether the wallet understands `pred` (an unknown predicate is shown but
 * never auto-treated as send-capable).
 */
export interface GuardSummary {
  readonly pred: string;
  readonly threshold: number;
  readonly neededMore: number;
  readonly predicateRecognized: boolean;
  readonly keys: readonly string[];
}

/**
 * A non-seed account tracked by the vault: either a single-key `k:` account or a
 * custom-guard (multisig) account. `mode` is EXPLICIT — watch-only means
 * balances are visible but sending is disabled; send-capable means the guard is
 * satisfied. There is NO implicit send-capability and NO plaintext private-key
 * field here: signing material for these accounts lives only in vault-global
 * `pureKeypairs[].encryptedPrivateKey`.
 */
export interface AdvancedAccount {
  readonly id: string;
  readonly address: string;
  readonly type: AdvancedAccountType;
  readonly mode: AdvancedAccountMode;
  readonly guardSummary?: GuardSummary;
  readonly label?: string;
  readonly createdAt: string;
  /**
   * Chain the guard was read on, recorded so a paste-validation can RE-FETCH the
   * live keyset on that same chain (RR#5 stale-keyset protection). Optional for
   * backward compat: a legacy record without it re-fetches against chain "0".
   */
  readonly chainId?: string;
}

/**
 * One derived account within a wallet. Mirrors `deriveAccount`'s public outputs
 * (`account` is the on-chain `k:` single-key address; `publicKey` is the 64-char
 * Ed25519 key) plus the BIP44 derivation path. NO secret/private key field
 * exists here — signing material is never persisted per account.
 */
export interface StoredAccount {
  readonly index: number;
  readonly publicKey: string;
  /** On-chain `k:` address, e.g. `k:<publicKey>`, from the SDK derivation path. */
  readonly account: string;
  /** BIP44 path, formatted `m'/44'/626'/<index>'` (StoaChain coin type 626). */
  readonly derivationPath: string;
}

/**
 * A single onboarded wallet: its encrypted seed phrase plus the accounts derived
 * from it. `activeAccountIndex` points into `accounts`. There is intentionally
 * no `secretKey` field — see the module security invariant.
 */
export interface StoredWallet {
  readonly id: string;
  readonly name: string;
  readonly encryptedPhrase: EncryptedBlob;
  readonly accounts: readonly StoredAccount[];
  readonly activeAccountIndex: number;
  readonly seedType: SeedType;
  readonly createdAt: string;
}

/**
 * The full vault: an ORDERED list of wallets plus a pointer to the active one.
 * Order is meaningful — onboarding a new wallet APPENDS (non-destructive), so
 * existing wallets keep their position. `activeWalletId` selects the wallet the
 * UI currently operates on.
 */
export interface Vault {
  readonly wallets: readonly StoredWallet[];
  readonly activeWalletId: string;
  /**
   * Vault-global pool of pasted/imported keypairs (see `IPureKeypair`).
   * Optional for backward compatibility: a Phase-2-era blob has no such field
   * and `deserializeVault` defaults it to `[]`.
   */
  readonly pureKeypairs?: readonly IPureKeypair[];
  /**
   * Non-seed accounts (single-key or custom-guard) tracked by the vault.
   * Optional for backward compatibility; defaults to `[]` on legacy blobs.
   */
  readonly advancedAccounts?: readonly AdvancedAccount[];
}

/**
 * Thrown when a stored vault blob cannot be parsed back into a `Vault`. Distinct
 * from a raw `SyntaxError` so the manager can surface "corrupt vault" SEPARATELY
 * from "wrong password": both produce an unusable result, but only a corrupt
 * vault warrants a recovery/restore flow rather than a retry-the-password prompt.
 */
export class CorruptVaultError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CorruptVaultError';
  }
}

/** Lossless serialization of a vault to its persisted string form. */
export function serializeVault(vault: Vault): string {
  return JSON.stringify(vault);
}

function isStoredAccount(value: unknown): value is StoredAccount {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.index === 'number' &&
    typeof a.publicKey === 'string' &&
    typeof a.account === 'string' &&
    typeof a.derivationPath === 'string'
  );
}

function isStoredWallet(value: unknown): value is StoredWallet {
  if (typeof value !== 'object' || value === null) return false;
  const w = value as Record<string, unknown>;
  return (
    typeof w.id === 'string' &&
    typeof w.name === 'string' &&
    typeof w.encryptedPhrase === 'string' &&
    Array.isArray(w.accounts) &&
    w.accounts.every(isStoredAccount) &&
    typeof w.activeAccountIndex === 'number' &&
    w.seedType === 'koala' &&
    typeof w.createdAt === 'string'
  );
}

function isPureKeypair(value: unknown): value is IPureKeypair {
  if (typeof value !== 'object' || value === null) return false;
  const k = value as Record<string, unknown>;
  return (
    typeof k.id === 'string' &&
    (k.label === undefined || typeof k.label === 'string') &&
    typeof k.publicKey === 'string' &&
    typeof k.encryptedPrivateKey === 'string' &&
    typeof k.createdAt === 'string'
  );
}

function isGuardSummary(value: unknown): value is GuardSummary {
  if (typeof value !== 'object' || value === null) return false;
  const g = value as Record<string, unknown>;
  return (
    typeof g.pred === 'string' &&
    typeof g.threshold === 'number' &&
    typeof g.neededMore === 'number' &&
    typeof g.predicateRecognized === 'boolean' &&
    Array.isArray(g.keys) &&
    g.keys.every((key) => typeof key === 'string')
  );
}

function isAdvancedAccount(value: unknown): value is AdvancedAccount {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.id === 'string' &&
    typeof a.address === 'string' &&
    (a.type === 'k-account' || a.type === 'custom-account') &&
    (a.mode === 'watch-only' || a.mode === 'send-capable') &&
    (a.guardSummary === undefined || isGuardSummary(a.guardSummary)) &&
    (a.label === undefined || typeof a.label === 'string') &&
    typeof a.createdAt === 'string' &&
    (a.chainId === undefined || typeof a.chainId === 'string')
  );
}

function isVault(value: unknown): value is Vault {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  // The advanced collections are OPTIONAL (legacy blobs omit them), but when
  // present they must be well-formed — backward compat must not weaken
  // validation of the new shape.
  const pureKeypairsOk =
    v.pureKeypairs === undefined ||
    (Array.isArray(v.pureKeypairs) && v.pureKeypairs.every(isPureKeypair));
  const advancedAccountsOk =
    v.advancedAccounts === undefined ||
    (Array.isArray(v.advancedAccounts) && v.advancedAccounts.every(isAdvancedAccount));
  return (
    Array.isArray(v.wallets) &&
    v.wallets.every(isStoredWallet) &&
    typeof v.activeWalletId === 'string' &&
    pureKeypairsOk &&
    advancedAccountsOk
  );
}

/**
 * Parse a persisted vault string back into a `Vault`.
 *
 * Rejects BOTH malformed JSON and structurally-valid JSON that is not a vault
 * shape with `CorruptVaultError` (never a bare `SyntaxError`, never a later
 * undefined-deref), so callers get one diagnosable error type for any
 * unusable blob.
 */
export function deserializeVault(raw: string): Vault {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new CorruptVaultError('Vault blob is not valid JSON.', { cause });
  }

  if (!isVault(parsed)) {
    throw new CorruptVaultError(
      'Vault blob parsed but does not match the expected vault shape.',
    );
  }

  return parsed;
}

/**
 * Vault-global pure keypairs as a guaranteed array.
 *
 * The advanced collections are OPTIONAL on `Vault` so (de)serialization stays
 * LOSSLESS and backward compatible — a Phase-2-era blob has neither field and
 * round-trips byte-for-byte (no injected `[]` keys that would break equality).
 * Consumers that want to iterate without a null check use these accessors, which
 * return `[]` for a legacy vault. This keeps "legacy blob -> empty collections"
 * a CONSUMER guarantee without rewriting the persisted shape.
 */
export function pureKeypairsOf(vault: Vault): readonly IPureKeypair[] {
  return vault.pureKeypairs ?? [];
}

/** Advanced accounts as a guaranteed array (see `pureKeypairsOf`). */
export function advancedAccountsOf(vault: Vault): readonly AdvancedAccount[] {
  return vault.advancedAccounts ?? [];
}
