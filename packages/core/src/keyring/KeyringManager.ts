/**
 * Orchestrates the wallet keyring over the platform-agnostic `StorageAdapter`
 * (at-rest encrypted vault blob) and `KeyVault` (in-memory unlocked secret).
 *
 * It composes the keyring primitives — mnemonic generate/validate, multi-account
 * derivation, encrypt-at-rest, and the pure vault (de)serialization — into the
 * user-facing flows the UI drives: create, import, unlock, lock, add account,
 * switch active account.
 *
 * SECURITY DISCIPLINE:
 *   - A SINGLE password seals the vault: the same value passed to derivation and
 *     to `encryptPhrase`. Derivation never runs under an empty/default password.
 *   - The decrypted mnemonic is the unlocked payload. On `unlock` it is loaded
 *     into the in-memory `KeyVault`; `addAccount` re-derives from that in-memory
 *     mnemonic (no password re-prompt); `lock()` clears it.
 *   - Create/import are APPEND-only and persist the complete next vault in a
 *     single `StorageAdapter.set` (atomic) — never an incremental per-account
 *     write, never a destructive overwrite.
 *   - The plaintext phrase is returned exactly ONCE from create/import for
 *     backup display. It is never persisted, never logged.
 */
import { binToHex } from '@stoachain/kadena-stoic-legacy/cryptography-utils';
import { kadenaDecrypt } from '@stoachain/kadena-stoic-legacy/hd-wallet';

import { deriveAccount } from '../api/derive';
import type { SignableKeypair } from '../api/sign';
import type { KeyVault, StorageAdapter } from '../storage';
import { VAULT_KEY } from '../storage/storageKeys';
import type {
  BiometricUnlock,
  BiometricUnlockFailureReason,
} from '../storage/BiometricUnlock';
import {
  addAdvancedAccount as coreAddAdvancedAccount,
  resolveForeignKey as coreResolveForeignKey,
  resolveAdvancedSigningKeypairs as coreResolveAdvancedSigningKeypairs,
  fetchAccountGuard,
  buildWalletPubSet,
  type AddAdvancedAccountResult,
  type AdvancedAccount,
  type FetchGuardFn,
  type Keyset,
  type ResolveForeignKeyResult,
  type ResolveSigningKeypairsResult,
} from '../advanced';

import { smartDecrypt, smartEncrypt } from '@stoachain/stoa-core/crypto';

import { importCodex as coreImportCodex, type ImportCodexOutcome } from '../codex';
import { deriveAccounts, type AccountRecord } from './deriveAccounts';
import { decryptPhrase, encryptPhrase } from './encryptAtRest';
import { generateMnemonic, validateMnemonic } from './mnemonic';
import {
  CorruptVaultError,
  deserializeVault,
  serializeVault,
  advancedAccountsOf,
  pureKeypairsOf,
  type SeedType,
  type StoredAccount,
  type StoredWallet,
  type Vault,
} from './vault';

/** Public per-seed summary the Advanced tab renders (no secret material). */
export interface WalletSummary {
  readonly id: string;
  readonly name: string;
  readonly seedType: SeedType;
  readonly isActive: boolean;
  readonly activeAccountIndex: number;
  readonly accounts: readonly StoredAccount[];
}

/** Public summary of a vault pure keypair (no secret material). */
export interface PureKeypairSummary {
  readonly id: string;
  readonly label?: string;
  readonly publicKey: string;
  /** The `k:` single-key account the pure key controls. */
  readonly account: string;
}

/** Options shared by `createWallet` / `importWallet`. */
export interface OnboardOptions {
  /** Human-readable wallet name; a default is assigned when omitted. */
  readonly name?: string;
  /** How many consecutive accounts to discover up front (default 1). */
  readonly accountCount?: number;
}

/** What create/import hands back: the active account + the ONE-TIME backup phrase. */
export interface OnboardResult {
  readonly walletId: string;
  /** The decrypted mnemonic, returned once for backup display. Never persisted. */
  readonly phrase: string;
  readonly account: StoredAccount;
}

/**
 * Thrown when `importWallet` is given a phrase that fails validation. Carries
 * the structured `reason` from `validateMnemonic` so the UI can show the exact
 * cause (wrong word count vs. invalid words) distinctly.
 */
export class InvalidMnemonicError extends Error {
  readonly reason: 'word-count' | 'invalid-words';

  constructor(reason: 'word-count' | 'invalid-words') {
    super(`Recovery phrase rejected: ${reason}.`);
    this.name = 'InvalidMnemonicError';
    this.reason = reason;
  }
}

/**
 * Thrown when signing-keypair resolution is attempted on a locked wallet. A
 * distinct class (matched by `name`) lets the UI seam map a locked vault to a
 * first-class `locked` outcome instead of calling the signer with null keys.
 */
export class WalletLockedError extends Error {
  constructor() {
    super('No wallet is unlocked; cannot resolve signing keypairs.');
    this.name = 'WalletLockedError';
  }
}

/**
 * Thrown by `unlockWithBiometric` when the `BiometricUnlock` backer returned a
 * `{ok:false}` result (unavailable / cancelled / failed). The biometric
 * CONTRACT itself never throws — it resolves a discriminated result — but the
 * keyring manager re-raises it so its "a failed unlock leaves no key resident"
 * invariant stays uniform with the password path, and callers branch on
 * `.reason`.
 */
export class BiometricUnlockFailedError extends Error {
  readonly reason: BiometricUnlockFailureReason;

  constructor(reason: BiometricUnlockFailureReason) {
    super(`Biometric unlock did not yield a secret: ${reason}.`);
    this.name = 'BiometricUnlockFailedError';
    this.reason = reason;
  }
}

export interface KeyringManagerDeps {
  readonly storage: StorageAdapter;
  readonly keyVault: KeyVault;
}

/** Encoder/decoder for putting the unlocked mnemonic into the KeyVault as bytes. */
const textEncoder = new TextEncoder();

function toStoredAccount(record: AccountRecord): StoredAccount {
  return {
    index: record.index,
    publicKey: record.publicKey,
    account: record.account,
    derivationPath: record.derivationPath,
  };
}

export class KeyringManager {
  private readonly storage: StorageAdapter;
  private readonly keyVault: KeyVault;

  /**
   * The plaintext mnemonic + sealing password of the CURRENTLY unlocked wallet.
   * Held only while unlocked so `addAccount` can re-derive without re-prompting.
   * Cleared by `lock()`. Never persisted, never logged.
   */
  private unlocked: { walletId: string; mnemonic: string; password: string } | null =
    null;

  constructor(deps: KeyringManagerDeps) {
    this.storage = deps.storage;
    this.keyVault = deps.keyVault;
  }

  /**
   * Generate a fresh 24-word wallet, derive its first account(s), encrypt the
   * phrase under `password`, APPEND it as the new active wallet, and persist the
   * complete next vault in one write. Returns the active account plus the
   * one-time backup phrase.
   */
  async createWallet(
    password: string,
    options: OnboardOptions = {},
  ): Promise<OnboardResult> {
    const phrase = await generateMnemonic();
    return this.onboard(phrase, password, options);
  }

  /**
   * Import an existing 24-word wallet. The phrase is validated FIRST; an invalid
   * phrase is rejected with `InvalidMnemonicError` (carrying a distinct reason)
   * BEFORE any derivation, encryption, or persistence touches the vault.
   */
  async importWallet(
    phrase: string,
    password: string,
    options: OnboardOptions = {},
  ): Promise<OnboardResult> {
    const validation = validateMnemonic(phrase);
    if (!validation.valid) {
      throw new InvalidMnemonicError(validation.reason);
    }
    return this.onboard(phrase, password, options);
  }

  /**
   * Unlock a stored wallet: read the vault, decrypt its phrase with `password`,
   * load the decrypted mnemonic into the in-memory KeyVault, and mark the wallet
   * unlocked. Surfaces `CorruptVaultError` (bad vault blob), and
   * `WrongPasswordError` / `CorruptEnvelopeError` / `UnsupportedFormatError`
   * (bad envelope / wrong password) distinctly — all propagated to the caller.
   */
  async unlock(walletId: string, password: string): Promise<void> {
    const vault = await this.readVault();
    if (vault === null) {
      throw new CorruptVaultError('No vault is stored; nothing to unlock.');
    }

    const wallet = this.findWallet(vault, walletId);

    let mnemonic: string;
    try {
      // Propagates WrongPasswordError / CorruptEnvelopeError / UnsupportedFormatError.
      mnemonic = await decryptPhrase(wallet.encryptedPhrase, password);
    } catch (error) {
      // A failed unlock must leave no key resident — clear any prior unlocked
      // state so a rejection never coincides with an unlocked vault.
      this.unlocked = null;
      await this.keyVault.lock();
      throw error;
    }

    await this.keyVault.unlock(textEncoder.encode(mnemonic));
    this.unlocked = { walletId, mnemonic, password };
  }

  /**
   * Unlock via a `BiometricUnlock`: obtain the password from the platform
   * authenticator, then run the SAME `unlock` path. The biometric contract
   * resolves a discriminated result (it never throws); on a `{ok:false}`
   * outcome (unavailable / cancelled / failed) this scrubs any resident key and
   * raises `BiometricUnlockFailedError` carrying the reason, so the failure path
   * is uniform with the password unlock.
   */
  async unlockWithBiometric(
    walletId: string,
    biometric: BiometricUnlock,
  ): Promise<void> {
    const result = await biometric.unlock();
    if (!result.ok) {
      // The authenticator was unavailable/cancelled/failed — leave no key
      // resident, mirroring the password path's failure guarantee.
      this.unlocked = null;
      await this.keyVault.lock();
      throw new BiometricUnlockFailedError(result.reason);
    }
    await this.unlock(walletId, result.secret);
  }

  /** Lock the vault: clear the in-memory unlocked mnemonic and KeyVault key. */
  async lock(): Promise<void> {
    this.unlocked = null;
    await this.keyVault.lock();
  }

  /**
   * Derive the next consecutive account for an unlocked wallet, append it,
   * make it active, and persist the complete next vault in one write. Re-derives
   * from the in-memory mnemonic + sealing password — takes no password argument.
   */
  async addAccount(walletId: string): Promise<StoredAccount> {
    const vault = await this.requireVault();
    const wallet = this.findWallet(vault, walletId);
    const nextIndex =
      wallet.accounts.reduce((max, a) => Math.max(max, a.index), -1) + 1;
    return this.deriveAndAppendAccount(walletId, nextIndex);
  }

  /**
   * Derive a SPECIFIC (possibly non-consecutive) account index for an unlocked
   * wallet, append it, make it active, and persist. The Advanced tab uses this for
   * "add account at index N"; `addAccount` is the consecutive convenience over it.
   * Rejects an index already present on the wallet.
   */
  async addAccountAtIndex(walletId: string, index: number): Promise<StoredAccount> {
    if (index < 0 || !Number.isInteger(index)) {
      throw new Error(`addAccountAtIndex: index must be a non-negative integer, got ${index}.`);
    }
    const vault = await this.requireVault();
    const wallet = this.findWallet(vault, walletId);
    if (wallet.accounts.some((a) => a.index === index)) {
      throw new Error(`Account index ${index} already exists on wallet ${walletId}.`);
    }
    return this.deriveAndAppendAccount(walletId, index);
  }

  /**
   * Derive one account at `index` for `walletId` from its seed (routed by the
   * wallet's `seedType`), append it, make it active, persist. Requires the wallet
   * to be the currently-unlocked one (its mnemonic is held in memory) — switching
   * seeds via `setActiveWallet` re-points the unlocked mnemonic first.
   */
  private async deriveAndAppendAccount(
    walletId: string,
    index: number,
  ): Promise<StoredAccount> {
    const unlocked = this.requireUnlocked(walletId);
    const vault = await this.requireVault();
    const wallet = this.findWallet(vault, walletId);

    const [record] = await deriveAccounts(
      unlocked.mnemonic,
      unlocked.password,
      index,
      1,
      wallet.seedType,
    );
    const account = toStoredAccount(record);

    const nextWallet: StoredWallet = {
      ...wallet,
      accounts: [...wallet.accounts, account].sort((a, b) => a.index - b.index),
      activeAccountIndex: account.index,
    };

    await this.persist(this.replaceWalletInVault(vault, nextWallet));
    return account;
  }

  /**
   * Switch the ACTIVE wallet (seed) — used by the Advanced tab's seed switcher.
   * Re-points the in-memory unlocked state to the target seed by decrypting its
   * phrase with the held vault password (all seeds share that password), so
   * subsequent `addAccount`/signing use the right mnemonic without a re-prompt,
   * and sets `vault.activeWalletId`. Rejects when locked or the wallet is unknown.
   */
  async setActiveWallet(walletId: string): Promise<void> {
    if (this.unlocked === null) {
      throw new WalletLockedError();
    }
    const vault = await this.requireVault();
    const wallet = this.findWallet(vault, walletId);
    const password = this.unlocked.password;
    const mnemonic =
      walletId === this.unlocked.walletId
        ? this.unlocked.mnemonic
        : await decryptPhrase(wallet.encryptedPhrase, password);
    this.unlocked = { walletId, mnemonic, password };
    await this.persist({ ...vault, activeWalletId: walletId });
  }

  /**
   * IMPORT an Ouronet Codex export into this vault. Requires an unlocked wallet
   * (the held vault password re-seals every imported secret). Decrypts each
   * seed's mnemonic + each pure key at the CODEX password via `smartDecrypt`,
   * re-seals them at the WALLET password (`encryptPhrase` / `smartEncrypt` "2" —
   * the SAME envelope the koala phrase + pasted pure keys already use, so signing
   * decrypts them identically), and APPENDS the new seeds/keys (idempotent —
   * already-present public keys are skipped). The decrypted secrets never leave
   * this method; only at-rest envelopes are persisted. Returns the discriminated
   * import outcome (summary on success, secret-free reason on failure).
   */
  async importCodex(
    json: string,
    codexPassword: string,
  ): Promise<ImportCodexOutcome> {
    if (this.unlocked === null) {
      throw new WalletLockedError();
    }
    const password = this.unlocked.password;
    const vault = await this.requireVault();

    const existingPubKeys = new Set<string>();
    for (const w of vault.wallets) {
      for (const acct of w.accounts) existingPubKeys.add(acct.publicKey);
    }
    for (const key of pureKeypairsOf(vault)) existingPubKeys.add(key.publicKey);

    // SAME-SEED views so the importer can MERGE a seed we already hold (with more
    // accounts) instead of duplicating it.
    const existingWallets = vault.wallets.map((w) => ({
      id: w.id,
      name: w.name,
      accountPubKeys: w.accounts.map((a) => a.publicKey),
    }));

    const takenWalletIds = new Set(vault.wallets.map((w) => w.id));
    let walletN = vault.wallets.length;
    let keyN = 0;

    const outcome = await coreImportCodex(json, {
      decrypt: (blob) => smartDecrypt(blob, codexPassword),
      encryptPhrase: (mnemonic) => encryptPhrase(mnemonic, password),
      encryptPrivateKey: (privateKey) => smartEncrypt(privateKey, password, '2'),
      existingPubKeys,
      existingWallets,
      genId: (kind) => {
        if (kind === 'wallet') {
          let id: string;
          do {
            walletN += 1;
            id = `wallet-${walletN}`;
          } while (takenWalletIds.has(id));
          takenWalletIds.add(id);
          return id;
        }
        keyN += 1;
        return `pure-import-${vault.wallets.length}-${keyN}`;
      },
      now: () => new Date().toISOString(),
    });

    if (!outcome.ok) return outcome;

    // Apply same-seed MERGES first: fold each merge's new accounts into the
    // existing wallet (deduped by index, sorted) and adopt the codex name. Then
    // append the brand-new seeds + pure keys. The active selection is kept — import
    // does NOT yank the user onto an imported seed. At-rest envelopes only.
    const mergeById = new Map(outcome.merges.map((m) => [m.walletId, m]));
    const mergedWallets = vault.wallets.map((w) => {
      const merge = mergeById.get(w.id);
      if (merge === undefined) return w;
      const byIndex = new Map(w.accounts.map((a) => [a.index, a]));
      for (const acct of merge.accounts) byIndex.set(acct.index, acct);
      return {
        ...w,
        name: merge.name,
        accounts: [...byIndex.values()].sort((a, b) => a.index - b.index),
      };
    });

    const nextVault: Vault = {
      ...vault,
      wallets: [...mergedWallets, ...outcome.wallets],
      pureKeypairs: [...pureKeypairsOf(vault), ...outcome.pureKeypairs],
    };
    await this.persist(nextVault);
    return outcome;
  }

  /**
   * Point the given wallet at one of its existing accounts (by HD index) and
   * persist. The wallet need not be unlocked — switching the displayed account
   * touches no secret material.
   */
  async setActiveAccount(walletId: string, index: number): Promise<void> {
    const vault = await this.requireVault();
    const wallet = this.findWallet(vault, walletId);

    if (!wallet.accounts.some((a) => a.index === index)) {
      throw new Error(
        `Account index ${index} does not exist on wallet ${walletId}.`,
      );
    }

    const nextWallet: StoredWallet = { ...wallet, activeAccountIndex: index };
    await this.persist(this.replaceWalletInVault(vault, nextWallet));
  }

  /**
   * Rename a seed (wallet). The name is non-secret vault metadata, so this does
   * NOT require an unlocked wallet and touches no key material. Rejects an
   * empty/whitespace-only name. The Advanced tab uses this to relabel seeds
   * (including codex-imported ones).
   */
  async renameWallet(walletId: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === '') {
      throw new Error('Wallet name cannot be empty.');
    }
    const vault = await this.requireVault();
    const wallet = this.findWallet(vault, walletId);
    const nextWallet: StoredWallet = { ...wallet, name: trimmed };
    await this.persist(this.replaceWalletInVault(vault, nextWallet));
  }

  /**
   * Remove a derived account from a seed. Account index #0 (the seed's primary,
   * always-present account) CANNOT be removed — it is the seed's anchor. Removing
   * an account drops only a re-derivable PUBLIC record: no secret is destroyed and
   * the same index re-derives from the seed later. If the removed account was the
   * active one, the active selection falls back to #0. Does NOT require an unlocked
   * wallet (no key material is touched).
   */
  async removeAccount(walletId: string, index: number): Promise<void> {
    if (index === 0) {
      throw new Error('Account #0 cannot be removed.');
    }
    const vault = await this.requireVault();
    const wallet = this.findWallet(vault, walletId);
    if (!wallet.accounts.some((a) => a.index === index)) {
      throw new Error(
        `Account index ${index} does not exist on wallet ${walletId}.`,
      );
    }
    const nextWallet: StoredWallet = {
      ...wallet,
      accounts: wallet.accounts.filter((a) => a.index !== index),
      activeAccountIndex:
        wallet.activeAccountIndex === index ? 0 : wallet.activeAccountIndex,
    };
    await this.persist(this.replaceWalletInVault(vault, nextWallet));
  }

  /**
   * The active account of the active wallet, or `null` when no vault is loaded
   * in memory yet. Reflects the latest persisted active-wallet / active-account
   * selection mutated by this manager during the session.
   */
  getActiveAccount(): StoredAccount | null {
    const vault = this.cachedVault;
    if (vault === null) return null;

    const wallet = vault.wallets.find((w) => w.id === vault.activeWalletId);
    if (wallet === undefined) return null;

    return (
      wallet.accounts.find((a) => a.index === wallet.activeAccountIndex) ?? null
    );
  }

  /**
   * The active wallet's full account list (every derived `k:` account), or an
   * empty array when no vault is loaded in memory yet. Reflects the latest
   * persisted state mutated by this manager during the session — the source the
   * UI's account switcher renders.
   */
  getActiveWalletAccounts(): readonly StoredAccount[] {
    const vault = this.cachedVault;
    if (vault === null) return [];

    const wallet = vault.wallets.find((w) => w.id === vault.activeWalletId);
    return wallet?.accounts ?? [];
  }

  /**
   * Public summary of EVERY seed (wallet) in the vault — id, name, seed type, its
   * accounts, and whether it is the active seed. The Advanced tab's seed switcher
   * renders this. Carries no secret material (no phrase, no keys). Reads the
   * in-memory cache, reflecting the latest persisted state.
   */
  listWallets(): readonly WalletSummary[] {
    const vault = this.cachedVault;
    if (vault === null) return [];
    return vault.wallets.map((w) => ({
      id: w.id,
      name: w.name,
      seedType: w.seedType,
      isActive: w.id === vault.activeWalletId,
      activeAccountIndex: w.activeAccountIndex,
      accounts: w.accounts,
    }));
  }

  /**
   * Public summary of every vault-global PURE keypair (the raw `-g` keys pasted in
   * or brought by a Codex import) — id, optional label, public key, and its `k:`
   * account. Carries NO secret material (never the encrypted/!plain private key).
   * Reads the in-memory cache. The Advanced tab's Pure Keys section renders this.
   */
  listPureKeypairs(): readonly PureKeypairSummary[] {
    const vault = this.cachedVault;
    if (vault === null) return [];
    return pureKeypairsOf(vault).map((k) => ({
      id: k.id,
      ...(k.label !== undefined ? { label: k.label } : {}),
      publicKey: k.publicKey,
      account: `k:${k.publicKey}`,
    }));
  }

  /**
   * Re-derive the active account's SIGN-READY keypair SET from the in-memory
   * unlocked mnemonic + sealing password — NO password re-prompt. Matches the
   * proven derive → decrypt → raw-key signing path (the koala nacl Ed25519
   * route): the at-rest `encryptedSecretKey` is decrypted back to its raw
   * 32-byte private key here so `universalSignTransaction` signs via nacl.
   *
   * The returned keypairs carry live key material; callers MUST use them inside
   * the signing boundary and never return/log them. A locked wallet (or no
   * active account) rejects with `WalletLockedError` so the caller maps it to a
   * `locked` outcome WITHOUT ever invoking the signer with null keys.
   */
  async resolveActiveSigningKeypairs(): Promise<readonly SignableKeypair[]> {
    if (this.unlocked === null) {
      throw new WalletLockedError();
    }
    const vault = await this.requireVault();
    const wallet = vault.wallets.find((w) => w.id === vault.activeWalletId);
    if (wallet === undefined) {
      throw new WalletLockedError();
    }
    const active = wallet.accounts.find(
      (a) => a.index === wallet.activeAccountIndex,
    );
    if (active === undefined) {
      throw new WalletLockedError();
    }

    const { password } = this.unlocked;
    // Decrypt the ACTIVE wallet's phrase. Every seed (the onboarded koala AND any
    // codex-imported one) is sealed at the SAME vault password, so a seed other
    // than the one unlocked at unlock-time still opens — multi-seed signing works
    // without a re-prompt. The unlocked seed uses its in-memory mnemonic (fast path).
    const mnemonic =
      wallet.id === this.unlocked.walletId
        ? this.unlocked.mnemonic
        : await decryptPhrase(wallet.encryptedPhrase, password);

    const derived = await deriveAccount(
      mnemonic,
      password,
      active.index,
      wallet.seedType,
    );

    if (wallet.seedType === 'koala') {
      // koala nacl Ed25519: decrypt the at-rest secret back to a raw 32-byte key.
      const rawSecret = await kadenaDecrypt(password, derived.encryptedSecretKey);
      const secretBytes =
        rawSecret instanceof Uint8Array
          ? rawSecret
          : new Uint8Array(rawSecret as ArrayLike<number>);
      return [
        {
          publicKey: derived.publicKey,
          privateKey: binToHex(secretBytes),
          seedType: 'koala',
        },
      ];
    }

    // chainweaver / eckowallet: do NOT decrypt to a raw key — the WASM signer
    // drives the BIP32-Ed25519 `EncryptedString` with the wallet password
    // (`fromKeypair` routes on the encryptedSecretKey + password shape).
    return [
      {
        publicKey: derived.publicKey,
        encryptedSecretKey: derived.encryptedSecretKey,
        password,
        seedType: wallet.seedType,
      },
    ];
  }

  /**
   * Build the public-key SET the wallet can currently sign for: every derived
   * `k:` account of the active wallet PLUS every accepted pure keypair in the
   * vault-global pool. This is the single source the advanced orchestrators
   * analyze a guard against — derived + pasted keys counted exactly once.
   *
   * Reads the freshly persisted vault (not just the in-memory cache) so a just-
   * added pure key is reflected. Returns an empty set when no vault is stored.
   */
  private async buildActiveWalletPubSet(): Promise<Set<string>> {
    const vault = await this.readVault();
    if (vault === null) return new Set();
    const wallet = vault.wallets.find((w) => w.id === vault.activeWalletId);
    const accounts = wallet?.accounts ?? [];
    return buildWalletPubSet(accounts, pureKeypairsOf(vault));
  }

  /**
   * Add a non-seed (advanced) account behind the keyring seam: build the wallet
   * pub set from the active wallet's accounts + the vault pure-key pool, then run
   * the core classify -> fetch -> analyze -> persist orchestration. No secret is
   * touched (an add reads only public guard data), but routing it through the
   * manager keeps the UI off the vault internals. Resolves the core discriminated
   * result verbatim; the optional `fetchGuard` seam lets tests stay off-network.
   */
  async addAdvancedAccount(
    address: string,
    chainId: string,
    fetchGuard?: FetchGuardFn,
  ): Promise<AddAdvancedAccountResult> {
    const walletPubSet = await this.buildActiveWalletPubSet();
    return coreAddAdvancedAccount(
      { address, chainId, walletPubSet },
      { storage: this.storage, fetchGuard },
    );
  }

  /**
   * Resolve a pasted foreign private key for an advanced account behind the
   * keyring seam. The wallet PASSWORD is read from the in-memory unlocked state
   * (NO re-prompt) and handed STRAIGHT to the core orchestrator; it never leaves
   * this method. The pasted private key transits as the argument and is forwarded
   * to core without being retained here. A locked wallet rejects with
   * `WalletLockedError` BEFORE core is called, so no key material is processed
   * against a locked vault.
   *
   * RR#5 (stale-keyset protection): the on-chain keyset is RE-FETCHED here on the
   * account's recorded chain (defaulting to "0" for legacy records) and passed to
   * core as `freshGuard`, so the paste is validated against the LIVE keyset and a
   * rotated keyset surfaces as `guard-changed`. The `fetchGuard` seam is injectable
   * so tests stay off-network; when a caller passes `freshGuard` explicitly (unit
   * tests) the re-fetch is skipped.
   */
  async resolveForeignKey(
    account: AdvancedAccount,
    privateKey: string,
    freshGuard?: { keys: string[]; pred: string },
    fetchGuard: FetchGuardFn = fetchAccountGuard,
  ): Promise<ResolveForeignKeyResult> {
    if (this.unlocked === null) {
      throw new WalletLockedError();
    }
    const walletPassword = this.unlocked.password;
    const walletPubSet = await this.buildActiveWalletPubSet();

    // Re-fetch the live keyset unless the caller injected one. The recorded
    // `chainId` pins the read to the chain the guard was read on; a legacy record
    // without it falls back to chain "0".
    let resolvedFreshGuard = freshGuard;
    if (resolvedFreshGuard === undefined) {
      const live = await fetchGuard(account.address, account.chainId ?? '0');
      if (live.exists && live.isKeyset) {
        resolvedFreshGuard = { keys: live.keys, pred: live.pred };
      }
    }

    return coreResolveForeignKey(
      {
        account,
        privateKey,
        walletPubSet,
        walletPassword,
        freshGuard: resolvedFreshGuard,
      },
      { storage: this.storage },
    );
  }

  /**
   * Resolve the SIGN-READY keypair SET that satisfies an advanced account's guard,
   * behind the keyring seam (XP-2). The unlocked mnemonic + sealing password stay
   * in the manager (XP-12) — in-wallet guard keys are re-derived and decrypted to
   * raw private keys, accepted pure keys are decrypted, and the gas-payer cap
   * signer is selected by core. The guard is RE-FETCHED live on the account's
   * recorded chain (falling back to "0"), with the recorded `guardSummary` as the
   * fallback when the live read yields no keyset; the `fetchGuard` seam is
   * injectable so tests stay off-network.
   *
   * The returned keypairs carry live key material; callers MUST consume them inside
   * the signing boundary and never return/log them. A locked wallet rejects with
   * `WalletLockedError` so the caller maps it to a `locked` outcome WITHOUT ever
   * invoking the signer with null keys.
   */
  async resolveAdvancedSigningKeypairs(
    account: AdvancedAccount,
    fetchGuard: FetchGuardFn = fetchAccountGuard,
  ): Promise<ResolveSigningKeypairsResult> {
    if (this.unlocked === null) {
      throw new WalletLockedError();
    }
    const { mnemonic, password } = this.unlocked;
    const vault = await this.requireVault();

    // Prefer the LIVE keyset on the recorded chain; fall back to the recorded
    // guard summary when the live read yields no usable keyset.
    const live = await fetchGuard(account.address, account.chainId ?? '0');
    const guard: Keyset =
      live.exists && live.isKeyset
        ? { keys: live.keys, pred: live.pred }
        : {
            keys: [...(account.guardSummary?.keys ?? [])],
            pred: account.guardSummary?.pred ?? 'keys-all',
          };

    return coreResolveAdvancedSigningKeypairs(
      account,
      guard,
      vault,
      mnemonic,
      password,
    );
  }

  /**
   * The advanced (non-seed) accounts currently tracked by the vault, read fresh
   * from storage so a just-added or just-promoted account is reflected. Returns
   * an empty array when no vault is stored. Carries no key material.
   */
  async listAdvancedAccounts(): Promise<readonly AdvancedAccount[]> {
    const vault = await this.readVault();
    if (vault === null) return [];
    return advancedAccountsOf(vault);
  }

  // --- internals -----------------------------------------------------------

  /** Most recently read/written vault, cached so `getActiveAccount` is sync. */
  private cachedVault: Vault | null = null;

  private async onboard(
    phrase: string,
    password: string,
    options: OnboardOptions,
  ): Promise<OnboardResult> {
    // Clamp to >=1 so a 0 (or negative) count can never derive an empty account
    // list and leave `accounts[0]` undefined while typed as StoredAccount.
    const accountCount = Math.max(1, options.accountCount ?? 1);

    const records = await deriveAccounts(phrase, password, 0, accountCount);
    const accounts = records.map(toStoredAccount);

    const encryptedPhrase = await encryptPhrase(phrase, password);

    const existing = (await this.readVault())?.wallets ?? [];
    const id = this.nextWalletId(existing);

    const wallet: StoredWallet = {
      id,
      name: options.name ?? `Wallet ${existing.length + 1}`,
      encryptedPhrase,
      accounts,
      activeAccountIndex: 0,
      seedType: 'koala',
      createdAt: new Date().toISOString(),
    };

    // APPEND — the new wallet becomes active, existing wallets stay intact.
    const nextVault: Vault = {
      wallets: [...existing, wallet],
      activeWalletId: id,
    };

    await this.persist(nextVault);

    // A freshly onboarded wallet is already unlocked: we hold its plaintext
    // mnemonic + sealing password here, so load them into the unlocked state and
    // the in-memory KeyVault. addAccount can then derive without a re-prompt.
    await this.keyVault.unlock(textEncoder.encode(phrase));
    this.unlocked = { walletId: id, mnemonic: phrase, password };

    return { walletId: id, phrase, account: accounts[0] };
  }

  private async readVault(): Promise<Vault | null> {
    const raw = await this.storage.get(VAULT_KEY);
    if (raw === null) {
      this.cachedVault = null;
      return null;
    }

    const vault = deserializeVault(this.asString(raw));
    this.cachedVault = vault;
    return vault;
  }

  private async requireVault(): Promise<Vault> {
    const vault = await this.readVault();
    if (vault === null) {
      throw new CorruptVaultError('No vault is stored.');
    }
    return vault;
  }

  private async persist(vault: Vault): Promise<void> {
    // Build the COMPLETE next state, then write it once — atomic.
    await this.storage.set(VAULT_KEY, serializeVault(vault));
    this.cachedVault = vault;
  }

  private findWallet(vault: Vault, walletId: string): StoredWallet {
    const wallet = vault.wallets.find((w) => w.id === walletId);
    if (wallet === undefined) {
      throw new Error(`No wallet with id ${walletId} in the vault.`);
    }
    return wallet;
  }

  private replaceWalletInVault(vault: Vault, nextWallet: StoredWallet): Vault {
    return {
      ...vault,
      wallets: vault.wallets.map((w) =>
        w.id === nextWallet.id ? nextWallet : w,
      ),
    };
  }

  private requireUnlocked(walletId: string): {
    mnemonic: string;
    password: string;
  } {
    if (this.unlocked === null || this.unlocked.walletId !== walletId) {
      throw new Error(
        `Wallet ${walletId} must be unlocked before deriving more accounts.`,
      );
    }
    return { mnemonic: this.unlocked.mnemonic, password: this.unlocked.password };
  }

  private nextWalletId(existing: readonly StoredWallet[]): string {
    const taken = new Set(existing.map((w) => w.id));
    let n = existing.length + 1;
    let id = `wallet-${n}`;
    while (taken.has(id)) {
      n += 1;
      id = `wallet-${n}`;
    }
    return id;
  }

  private asString(raw: string | Uint8Array): string {
    return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  }
}
