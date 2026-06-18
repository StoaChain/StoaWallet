import {
  InvalidMnemonicError,
  KeyringManager,
  UnsupportedBiometricUnlock,
  UnsupportedQrScanner,
  WalletLockedError,
  awaitSendConfirmation as coreAwaitSendConfirmation,
  setAutoLockMinutes as coreSetAutoLockMinutes,
  collectUrStoa as coreCollectUrStoa,
  sendCrossChainStep0 as coreSendCrossChainStep0,
  sendSameChain as coreSendSameChain,
  stakeUrStoa as coreStakeUrStoa,
  transferUrStoa as coreTransferUrStoa,
  unstakeUrStoa as coreUnstakeUrStoa,
  type AddAdvancedAccountResult,
  type AdvancedAccount,
  type BiometricUnlock,
  type KeyVault,
  type QrScanner,
  type RemoteSignTransaction,
  type ResolveForeignKeyResult,
  type ResolveSigningKeypairsResult,
  type ConfirmSendResult,
  type SameChainDeps,
  type SameChainSendResult,
  type SendCrossChainStep0Deps,
  type SendCrossChainStep0Result,
  type SignableKeypair,
  type StorageAdapter,
  type StoredAccount,
  type StoredBlob,
  type UnsignedTx,
  type CollectUrStoaParams,
  type CollectUrStoaResult,
  type TransferUrStoaParams,
  type TransferUrStoaResult,
  type UrStoaStakeParams,
  type UrStoaStakeResult,
  VAULT_KEY,
  deserializeVault,
  generateMnemonic,
} from '@stoawallet/core';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * The React surface the onboarding / wallet flows consume. It wraps the
 * platform-agnostic `KeyringManager` (injected with a `StorageAdapter` +
 * `KeyVault` so the extension and mobile apps swap concrete backers) and
 * exposes the state machine the screens render against.
 *
 * SECURITY DISCIPLINE:
 *   - The in-progress generated phrase (`words`) lives ONLY in this component's
 *     state. It is never lifted to a parent/global/persisted store and never
 *     logged. It is cleared on EVERY exit path: successful save, save error,
 *     flow abandon, and unmount.
 *   - Async actions return DISCRIMINATED RESULTS rather than throwing secret-
 *     bearing errors. Nothing here `console.error`s a value derived from the
 *     phrase or password.
 */

export type OnboardingMode = 'create' | 'import';

/** A wallet's plaintext metadata, readable from the vault WITHOUT unlocking. */
export interface ExistingWalletSummary {
  readonly id: string;
  readonly name: string;
}

/**
 * The ACTIVE wallet's plaintext summary — its name + seed type, readable from
 * the vault WITHOUT unlocking (the phrase is the only encrypted field). The
 * header renders the seed name and a color-coded seed-type chip from this. The
 * seed type widens beyond `koala` only when the wallet onboards other seed types
 * (chainweaver/eckowallet/pure); today the single seed is always koala.
 */
export interface ActiveWalletSummary {
  readonly id: string;
  readonly name: string;
  readonly seedType: string;
}

/** A discriminated unlock/action outcome as it crosses the remote-vault seam. */
export type RemoteUnlockResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: WalletActionReason };

/**
 * The OPTIONAL background-backed custody surface (XP-12). When a host injects a
 * `remoteVault`, the provider DELEGATES the secret-touching ops — unlock, lock,
 * the unlocked-session query, and signing — to it INSTEAD of running the local
 * `KeyringManager`'s decrypt/derive/sign path. The Chrome extension supplies one
 * that forwards every op to the background service worker, so the popup never
 * holds the mnemonic / keypair.
 *
 * The web/test path injects NO `remoteVault`, and the provider behaves EXACTLY as
 * before — local resolution — so all prior tests stay green.
 *
 * SECURITY: a `remoteVault` carries NO key material across its surface. `signTx`
 * returns ONLY the signed public transaction; the host resolves and consumes the
 * keypair entirely on its side.
 */
export interface RemoteVault {
  unlock(walletId: string, password: string): Promise<RemoteUnlockResult>;
  lock(): Promise<void>;
  isUnlocked(): Promise<boolean>;
  getActiveAccount(): Promise<RemoteAccount | null>;
  listAccounts(): Promise<readonly RemoteAccount[]>;
  addAccount(walletId: string): Promise<RemoteUnlockResult>;
  setActiveAccount(walletId: string, index: number): Promise<RemoteUnlockResult>;
  /**
   * Sign in the host (background) per a signer spec; returns only the signed tx.
   * Typed structurally so this UI package stays decoupled from the extension's
   * concrete protocol types — the signed value is opaque public data here.
   */
  signTx(
    signerSpec: unknown,
    tx: unknown,
    accountIndex?: number,
  ): Promise<RemoteSignOutcome>;
  /**
   * Run a full UrStoa write op (build+sign+submit) in the host (background). The
   * SDK `execute*UrStoa` executors bundle build+sign+submit around a LITERAL
   * keypair (no `signTransaction` seam), so for the extension the WHOLE op must run
   * where the unlocked key lives. The popup passes ONLY the `op` + PUBLIC params;
   * the host resolves the active keypair, runs the core wrapper, and returns the
   * discriminated result. No key material crosses this surface in either direction.
   *
   * Typed structurally (`unknown` params/result) so this UI package stays
   * decoupled from the extension's concrete protocol types — the public params and
   * the discriminated result are plain JSON-safe data here.
   */
  urstoaExecute(request: {
    readonly op: 'stake' | 'unstake' | 'collect' | 'transfer';
    readonly params: unknown;
  }): Promise<RemoteUrStoaOutcome>;
  /**
   * The auto-lock session TICK: polled by the popup (~every 10s) to (a) keep the
   * MV3 worker alive so the unlocked session survives form-filling, (b) drive the
   * auto-lock (the host locks if the window elapsed), and (c) report the live
   * expiry the popup counts down from. Read-only re: activity — it never re-arms.
   */
  getSession(): Promise<RemoteSessionStatus>;
  /** Set the auto-lock window (minutes, clamped host-side); returns the value used. */
  setAutoLock(minutes: number): Promise<number>;
  /** Every seed (wallet) in the vault — public summary, for the Advanced tab. */
  listWallets(): Promise<readonly RemoteWalletSummary[]>;
  /** Every vault pure keypair — public summary, for the Advanced tab. */
  listPureKeypairs(): Promise<readonly RemotePureKeypair[]>;
  /** Switch the active seed (re-points signing in the host); ack/locked. */
  setActiveWallet(walletId: string): Promise<RemoteUnlockResult>;
  /** Derive a specific (non-consecutive) account index on a seed; returns it. */
  addAccountAtIndex(walletId: string, index: number): Promise<RemoteUnlockResult>;
  /** Remove a derived account from a seed (index #0 is rejected host-side); ack. */
  removeAccount(walletId: string, index: number): Promise<RemoteUnlockResult>;
  /** Rename a seed (non-secret metadata); ack/failure. */
  renameWallet(walletId: string, name: string): Promise<RemoteUnlockResult>;
  /**
   * Import an Ouronet Codex export in the host: the codex password transits once,
   * secrets are decrypted + re-sealed entirely in the host, only counts return.
   */
  importCodex(json: string, codexPassword: string): Promise<RemoteImportCodexResult>;
}

/** A public per-seed summary the Advanced tab renders (no secret material). */
export interface RemoteWalletSummary {
  readonly id: string;
  readonly name: string;
  readonly seedType: string;
  readonly isActive: boolean;
  readonly activeAccountIndex: number;
  readonly accounts: readonly RemoteAccount[];
}

/** A public pure-keypair summary the Advanced tab renders (no secret material). */
export interface RemotePureKeypair {
  readonly id: string;
  readonly label?: string;
  readonly publicKey: string;
  readonly account: string;
}

/** The discriminated outcome of a Codex import — counts on success, reason on failure. */
export type RemoteImportCodexResult =
  | {
      readonly ok: true;
      readonly summary: {
        readonly seedsImported: number;
        readonly accountsImported: number;
        readonly keysImported: number;
        readonly skipped: number;
      };
    }
  | { readonly ok: false; readonly reason: string };

/** The live auto-lock snapshot the popup renders a countdown from. */
export interface RemoteSessionStatus {
  readonly unlocked: boolean;
  /** Epoch-ms when the wallet auto-locks, or null when locked. */
  readonly expiresAt: number | null;
  readonly autoLockMinutes: number;
}

/**
 * The remote UrStoa-op outcome: the public requestKey on success, or a
 * discriminated failure reason. Mirrors the core wrappers' discriminated result
 * (stake/unstake/collect/transfer collapse onto a shared shape here). Carries no
 * key material — the keypair was resolved+consumed entirely in the host.
 */
export type RemoteUrStoaOutcome =
  | { readonly ok: true; readonly requestKey: string; readonly status?: string }
  | { readonly ok: false; readonly reason: string; readonly detail?: string };

/** A public account record as it crosses the remote-vault seam (no key). */
export interface RemoteAccount {
  readonly index: number;
  readonly publicKey: string;
  readonly account: string;
  readonly derivationPath: string;
}

/** The remote signing outcome: the signed public tx, or a discriminated failure. */
export type RemoteSignOutcome =
  | { readonly ok: true; readonly signed: unknown }
  | { readonly ok: false; readonly reason: string };

/**
 * Why a discriminated action failed. `wrong-password`, `corrupt-envelope`,
 * `unsupported-format`, and `corrupt-vault` come from the decrypt/vault
 * taxonomy; `word-count` / `invalid-words` come from import validation;
 * `no-wallet` is "nothing stored to unlock"; `unknown` is the catch-all.
 */
export type WalletActionReason =
  | 'wrong-password'
  | 'corrupt-envelope'
  | 'unsupported-format'
  | 'corrupt-vault'
  | 'word-count'
  | 'invalid-words'
  | 'no-wallet'
  | 'locked'
  | 'unknown';

export type WalletActionResult =
  | { ok: true }
  | { ok: false; reason: WalletActionReason };

/** What the UI passes to the context send op — the sender is resolved inside. */
export interface ContextSendParams {
  readonly recipient: string;
  readonly amount: string;
  readonly chainId: string;
  /**
   * OPTIONAL same-chain deps override (read/build/simulate/submit/gas). Tests
   * inject stubs to stay off-network; production omits it and the core default
   * lazily wires the live SDK client. In remote-vault mode the context overrides
   * ONLY the `sign` leg of these deps to route signing through the background.
   */
  readonly sendDeps?: Partial<SameChainDeps>;
}

/**
 * The context send op's result: the core same-chain result UNION extended with
 * a local `locked` failure. `locked` is returned WITHOUT ever calling core when
 * the wallet is locked / has no active account, so the signer is never invoked
 * with null keys.
 */
export type ContextSendResult =
  | SameChainSendResult
  | { readonly ok: false; readonly reason: 'locked' };

/** What the UI passes to the context cross-chain step-0 op. */
export interface ContextCrossChainParams {
  readonly receiver: string;
  readonly amount: string;
  readonly sourceChain: string;
  readonly targetChain: string;
  /**
   * OPTIONAL step-0 deps override (build/sign/submit/listen). Tests inject stubs to
   * stay off-network; production omits it and core lazily wires the live SDK client.
   * In remote-vault mode the context overrides ONLY the `signTransaction` leg of
   * these deps to route signing through the background (mirroring `sendDeps`).
   */
  readonly crossDeps?: Partial<SendCrossChainStep0Deps>;
}

/**
 * The active-account signer resolution for a miner sweep (XP-1/XP-12). In LOCAL
 * mode `signingKeypairs` carry live key material resolved inside the context (core's
 * default signer runs, `signTransaction` absent); in REMOTE mode they are PUBLIC-only
 * (the sender's pubkey, empty secret) and `signTransaction` routes the real signature
 * through the background. The chain-0 gas-payer cap is signed by the sender's OWN key
 * (XP-8), so `gasStationKeypair` mirrors the sender. `locked` is returned WITHOUT
 * touching the keyring when no wallet is unlocked / no active account.
 */
export type ContextMinerSignersResult =
  | {
      readonly ok: true;
      readonly signingKeypairs: readonly SignableKeypair[];
      readonly gasStationKeypair?: SignableKeypair;
      readonly signTransaction?: RemoteSignTransaction;
    }
  | { readonly ok: false; readonly reason: 'locked' };

/**
 * The context cross-chain step-0 op's result: the core step-0 result UNION
 * extended with a local `locked` failure (returned WITHOUT ever calling core
 * when the wallet is locked / has no active account).
 */
export type ContextCrossChainStep0Result =
  | SendCrossChainStep0Result
  | { readonly ok: false; readonly reason: 'locked' };

/**
 * The context advanced-add op's result: the core add result UNION extended with
 * a local `locked` failure (returned WITHOUT ever calling core when the wallet is
 * locked / has no active account, so no vault read or persist runs locked).
 */
export type ContextAddAdvancedResult =
  | AddAdvancedAccountResult
  | { readonly ok: false; readonly reason: 'locked' };

/**
 * The context foreign-key-resolve op's result: the core resolve result UNION
 * extended with a local `locked` failure. The pasted private key passed in is
 * handed STRAIGHT to the keyring seam and NEVER retained by the context beyond
 * the call; `locked` short-circuits before the key is processed.
 */
export type ContextResolveForeignKeyResult =
  | ResolveForeignKeyResult
  | { readonly ok: false; readonly reason: 'locked' };

/**
 * The context advanced-signing-resolve op's result: the core keypair-SET result
 * UNION extended with a local `locked` failure. The returned keypairs carry live
 * key material — the send path consumes them INSIDE the signing boundary and never
 * returns/logs them (XP-2 reachable seam; XP-12 keeps password/mnemonic in the
 * manager). `locked` is returned WITHOUT touching core when no wallet is unlocked.
 */
export type ContextResolveAdvancedSigningResult =
  | ResolveSigningKeypairsResult
  | { readonly ok: false; readonly reason: 'locked' };

/**
 * Injectable LOCAL-mode UrStoa core wrappers (XP-12). Tests inject off-network
 * spies; production omits it so the seam uses the real `@stoawallet/core`
 * wrappers. Only the leg an op needs is consulted, so each is optional.
 */
export interface UrStoaCoreOverride {
  readonly stakeUrStoa?: (p: UrStoaStakeParams) => Promise<UrStoaStakeResult>;
  readonly unstakeUrStoa?: (p: UrStoaStakeParams) => Promise<UrStoaStakeResult>;
  readonly collectUrStoa?: (p: CollectUrStoaParams) => Promise<CollectUrStoaResult>;
  readonly transferUrStoa?: (p: TransferUrStoaParams) => Promise<TransferUrStoaResult>;
}

/** PUBLIC params for an UrStoa stake/unstake op — NO keypair crosses from the hook. */
export interface ContextUrStoaStakeParams {
  readonly paymentKeyAddress: string;
  readonly amount: string;
  /** Test-only LOCAL core override (mirrors `sendDeps`); omitted in production. */
  readonly urstoaCore?: UrStoaCoreOverride;
}
/** PUBLIC params for an UrStoa collect op. */
export interface ContextUrStoaCollectParams {
  readonly paymentKeyAddress: string;
  readonly urstoaCore?: UrStoaCoreOverride;
}
/** PUBLIC params for a native UrStoa transfer op. */
export interface ContextUrStoaTransferParams {
  readonly senderAddress: string;
  readonly receiverAddress: string;
  readonly amount: string;
  readonly urstoaCore?: UrStoaCoreOverride;
}

/**
 * The UrStoa op's result: the public requestKey on success, or a discriminated
 * failure. `locked` is returned WITHOUT touching core/the background when the
 * wallet is locked / has no active account, so the signer never runs with null
 * keys. The success/failure reasons mirror the core wrappers (the popup renders
 * the SAME reason the in-process path would).
 */
export type ContextUrStoaResult =
  | { readonly ok: true; readonly requestKey: string; readonly status?: string }
  | { readonly ok: false; readonly reason: string; readonly detail?: string };

export interface WalletContextValue {
  readonly mode: OnboardingMode;
  setMode(mode: OnboardingMode): void;

  /** The in-progress generated phrase (create flow), held only for display. */
  readonly words: string[];

  readonly hasConfirmedBackup: boolean;
  setHasConfirmedBackup(value: boolean): void;

  /** The active `k:` account of the active wallet, or `null` when none. */
  readonly activeAccount: StoredAccount | null;

  /**
   * True when a mid-session op reported `{ok:false, reason:'locked'}` — the
   * background session expired (idle auto-lock fired, or the MV3 service worker
   * respawned between ops). The popup uses this to frame the re-unlock as a
   * "session expired" event (distinct from a plain first-open lock). It is set by
   * {@link reportSessionLocked} and cleared on the next successful unlock. On the
   * web/test path (no remoteVault) it never sets — there is no background to expire.
   */
  readonly sessionExpired: boolean;

  /**
   * The REACTIVE background unlocked-state under MV3, or `null` when there is no
   * background (the web/test/mobile path → defer to the local `activeAccount`).
   * `null` until the first {@link refreshRemoteUnlocked} query resolves; then it
   * holds the background session's live boolean, flipped `true` on a successful
   * remote {@link unlock} and `false` on {@link lock} / {@link reportSessionLocked}.
   *
   * The lifecycle guard derives its `status` from THIS (not a one-shot mount query)
   * so an in-popup unlock/lock re-renders the shell to HOME / re-unlock. Carries no
   * key material — it is a single boolean across the seam.
   */
  readonly remoteUnlocked: boolean | null;

  /**
   * Flag that the background session expired mid-session — called by an op (or the
   * lifecycle guard) when it observes a `locked` reason after the popup had a live
   * session. Idempotent; cleared by the next successful {@link unlock}.
   */
  reportSessionLocked(): void;

  /**
   * Re-derive the unlocked-state from the BACKGROUND (the single source of truth
   * under MV3, where the worker can be terminated at any time). When a remoteVault
   * is injected, this queries `isUnlocked()` and — if unlocked — mirrors the
   * background's active selection into context so HOME renders the live account.
   * Returns the background's unlocked boolean.
   *
   * On the web/test path (no remoteVault) there is NO background to query, so it
   * returns `null` and the caller defers to the local `activeAccount` state — the
   * pre-existing branching stays unchanged.
   */
  refreshRemoteUnlocked(): Promise<boolean | null>;

  /** The active wallet's full derived account list (empty when no wallet). */
  readonly activeWalletAccounts: readonly StoredAccount[];

  readonly hasExistingWallet: boolean;
  readonly existingWallets: ExistingWalletSummary[];

  /**
   * The active wallet's plaintext summary (name + seed type), or `null` when no
   * wallet is stored. Sourced from the vault's `activeWalletId` pointer; refreshed
   * on mount and after every save/import. The header reads the seed name + the
   * seed-type chip from it.
   */
  readonly activeWallet: ActiveWalletSummary | null;

  startCreate(): Promise<void>;
  saveWallet(password: string): Promise<WalletActionResult>;
  importWallet(
    words: string[],
    password: string,
  ): Promise<WalletActionResult>;
  unlock(password: string): Promise<WalletActionResult>;
  lock(): Promise<void>;
  addAccount(): Promise<WalletActionResult>;
  switchAccount(index: number): Promise<WalletActionResult>;
  /** Set the selected account within a SPECIFIC seed (Advanced tab two-tier select). */
  setSeedActiveAccount(walletId: string, index: number): Promise<WalletActionResult>;

  /** Every seed (wallet) in the vault — public summaries for the Advanced tab. */
  listWallets(): Promise<readonly RemoteWalletSummary[]>;
  /** Every vault pure keypair — public summaries for the Advanced tab. */
  listPureKeypairs(): Promise<readonly RemotePureKeypair[]>;
  /** Switch the ACTIVE seed (re-points signing); mirrors the new selection. */
  switchWallet(walletId: string): Promise<WalletActionResult>;
  /** Derive a specific (non-consecutive) account index on a seed. */
  addAccountAtIndex(walletId: string, index: number): Promise<WalletActionResult>;
  /** Remove a derived account from a seed. Account #0 cannot be removed. */
  removeAccount(walletId: string, index: number): Promise<WalletActionResult>;
  /** Rename a seed (wallet); mirrors the updated summary. */
  renameWallet(walletId: string, name: string): Promise<WalletActionResult>;
  /**
   * Import an Ouronet Codex export — decrypt at the codex password, re-seal at the
   * wallet password, merge the seeds/keys. The decrypted secrets never reach the
   * popup (the host does it). Returns the count summary or a discriminated reason.
   */
  importCodex(json: string, codexPassword: string): Promise<RemoteImportCodexResult>;

  /**
   * Sign + submit a same-chain transfer behind the keyring seam. Resolves the
   * sender from the active account, resolves the sign-ready keypair SET via the
   * KeyringManager, and calls core `sendSameChain`. The keypairs are used INSIDE
   * this op and NEVER returned to the caller (XP-12). Returns `locked` without
   * touching core when no wallet is unlocked.
   */
  sendSameChain(params: ContextSendParams): Promise<ContextSendResult>;

  /**
   * Await the ON-CHAIN outcome of a submitted same-chain send (the request key
   * carries only "submitted", not "mined"). A pure read — no key material — so it
   * forwards straight to core `awaitSendConfirmation`. Returns a definitive
   * confirmed/failed, or a `timeout` (submit landed, not yet observed — show the
   * explorer, never resubmit).
   */
  awaitSendConfirmation(
    requestKey: string,
    chainId: string,
  ): Promise<ConfirmSendResult>;

  /**
   * The auto-lock session tick (extension only). Polled by the auto-lock hook to
   * keep the worker alive + drive the lock + read the countdown expiry. Resolves
   * `null` on the web/mobile path (no background worker — no auto-lock window).
   */
  getSession(): Promise<RemoteSessionStatus | null>;
  /**
   * Set the auto-lock window in minutes. In the extension this updates the live
   * background window; elsewhere it persists the preference. Returns the clamped
   * minutes actually used.
   */
  setAutoLock(minutes: number): Promise<number>;

  /**
   * Build + sign + submit + confirm a cross-chain transfer's step-0 burn behind
   * the keyring seam. Resolves the sender from the active account, resolves the
   * sign-ready keypair SET via the KeyringManager, sets the gas-station co-signer
   * to the sender's OWN key on chain 0 (the base single-account wallet pays its
   * own gas-payer cap; XP-8 descope), and calls core `sendCrossChainStep0`. The
   * keypairs are used INSIDE this op and NEVER returned to the caller (XP-12).
   * Returns `locked` without touching core when no wallet is unlocked.
   */
  sendCrossChainStep0(
    params: ContextCrossChainParams,
  ): Promise<ContextCrossChainStep0Result>;

  /**
   * Stake UrStoa behind the keyring seam (XP-12). LOCAL mode resolves the active
   * account's keypair via the manager and calls the core `stakeUrStoa`; REMOTE
   * mode routes the whole op to the background (which holds the key). The popup
   * passes ONLY the public payment-key address + amount — no keypair crosses.
   * Returns `locked` WITHOUT touching core/the background when no wallet is unlocked.
   */
  urstoaStake(params: ContextUrStoaStakeParams): Promise<ContextUrStoaResult>;
  /** Unstake UrStoa — symmetric to {@link urstoaStake}; public params only. */
  urstoaUnstake(params: ContextUrStoaStakeParams): Promise<ContextUrStoaResult>;
  /** Collect accrued UrStoa earnings — public payment-key address only. */
  urstoaCollect(params: ContextUrStoaCollectParams): Promise<ContextUrStoaResult>;
  /** Native UrStoa transfer — public sender/receiver/amount only, no keypair. */
  urstoaTransfer(params: ContextUrStoaTransferParams): Promise<ContextUrStoaResult>;

  /**
   * Resolve the active account's signers for a miner sweep through the keyring
   * seam, in BOTH modes (XP-1/XP-12): local mode returns the real keypair SET (+ a
   * gas-station co-signer mirroring the sender for chain 0); remote mode returns a
   * PUBLIC-only set plus a `signTransaction` override that routes signing through
   * the background. The keys NEVER leave the context in either mode. Returns
   * `locked` WITHOUT touching the keyring when no wallet is unlocked / no active
   * account. `needsGasStation` controls whether the chain-0 gas co-signer is resolved.
   */
  resolveActiveMinerSigners(
    needsGasStation: boolean,
  ): Promise<ContextMinerSignersResult>;

  /**
   * Add a non-seed (advanced) account behind the keyring seam. Builds the wallet
   * pub set from the active wallet's accounts + the vault pure-key pool INSIDE the
   * manager and runs the core classify/fetch/analyze/persist orchestration. No
   * secret is involved (an add reads only public guard data). Returns `locked`
   * WITHOUT touching core when no wallet is unlocked / no active account.
   */
  addAdvancedAccount(
    address: string,
    chainId: string,
  ): Promise<ContextAddAdvancedResult>;

  /**
   * Resolve a pasted foreign private key for an advanced account behind the
   * keyring seam. The wallet password is read from the unlocked KeyringManager (NO
   * re-prompt) and handed STRAIGHT to core; the pasted `privateKey` transits to
   * the manager and is NEVER retained by the context beyond this call (RR#8).
   * Returns `locked` WITHOUT processing the key when no wallet is unlocked.
   */
  resolveForeignKey(
    account: AdvancedAccount,
    privateKey: string,
  ): Promise<ContextResolveForeignKeyResult>;

  /**
   * Resolve the SIGN-READY keypair SET that satisfies an advanced account's guard
   * behind the keyring seam (XP-2). The password/mnemonic stay in the
   * KeyringManager (XP-12); the returned keypairs carry live key material the
   * advanced send path consumes INSIDE the signing boundary. Returns `locked`
   * WITHOUT touching core when no wallet is unlocked.
   */
  resolveAdvancedSigningKeypairs(
    account: AdvancedAccount,
  ): Promise<ContextResolveAdvancedSigningResult>;

  /** The advanced accounts tracked by the vault, read fresh (carries no key). */
  listAdvancedAccounts(): Promise<readonly AdvancedAccount[]>;

  /**
   * The injected at-rest storage adapter, exposed so durable cross-chain
   * in-flight state (the anti-fund-stranding rehydrate seam) persists under the
   * SAME backend the vault uses. It carries only opaque/plaintext blobs the
   * caller writes — never key material.
   */
  readonly storage: StorageAdapter;

  /**
   * The injected platform biometric authenticator, surfaced so the UnlockScreen
   * gates its biometric affordance on the REAL backer (the mobile app injects a
   * capable one; the web/extension path defaults to `UnsupportedBiometricUnlock`,
   * whose `isAvailable()` is false → the affordance stays hidden). Threading it
   * through context lets the shared `<WalletApp/>` enable biometrics on mobile
   * with NO UI fork.
   */
  readonly biometric: BiometricUnlock;

  /**
   * The injected platform QR scanner for the Send flow's recipient-address scan.
   * The mobile app injects a camera-backed scanner; the web/extension path
   * defaults to `UnsupportedQrScanner` (no camera) so the Send UI degrades to
   * manual entry without branching.
   */
  readonly qrScanner: QrScanner;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export interface WalletProviderProps {
  readonly storage: StorageAdapter;
  readonly keyVault: KeyVault;
  /**
   * OPTIONAL background-backed custody (XP-12). When present, unlock / lock / the
   * unlocked query are DELEGATED to it instead of the local KeyringManager, so a
   * host (the Chrome popup) can keep the mnemonic + keypair out of this context
   * entirely. Omitted on the web/test path → unchanged local resolution.
   */
  readonly remoteVault?: RemoteVault;
  /**
   * OPTIONAL platform biometric authenticator. Defaults to
   * `UnsupportedBiometricUnlock` (web/extension: no biometrics) so the affordance
   * stays hidden; the mobile app injects a capable backer to reveal it with no UI
   * fork. Carries no key material — biometric unlock only returns the vault
   * password through the ordinary unlock path.
   */
  readonly biometric?: BiometricUnlock;
  /**
   * OPTIONAL platform QR scanner for the Send flow. Defaults to
   * `UnsupportedQrScanner` (web/extension: no camera) so the Send UI degrades to
   * manual entry; the mobile app injects a camera-backed scanner.
   */
  readonly qrScanner?: QrScanner;
  /**
   * OPTIONAL pre-built KeyringManager. When omitted the provider builds one from
   * the injected `storage`+`keyVault` (the web/extension path — unchanged). The
   * mobile app injects ONE shared manager so its app-background auto-lock locks
   * the SAME manager the provider runs, clearing the live `{mnemonic, password}`
   * session — not a second, disconnected manager.
   */
  readonly manager?: KeyringManager;
  readonly children: ReactNode;
}

/** A remote public account record mapped into a local `StoredAccount`. */
function fromRemoteAccount(remote: RemoteAccount): StoredAccount {
  return {
    index: remote.index,
    publicKey: remote.publicKey,
    account: remote.account,
    derivationPath: remote.derivationPath,
  };
}

/**
 * Translate a thrown unlock/decrypt error into a discriminated reason.
 *
 * Discrimination is by the error's stable `name` rather than `instanceof`: the
 * crypto/vault error classes live in `@stoachain/stoa-core` and `@stoawallet/
 * core`, and matching on `name` keeps this UI package from importing those
 * crypto internals just to compare constructors. Each class sets its `name` in
 * its constructor, so the mapping is exact.
 */
function reasonForUnlockError(error: unknown): WalletActionReason {
  const name = error instanceof Error ? error.name : '';
  switch (name) {
    case 'WrongPasswordError':
      return 'wrong-password';
    case 'CorruptEnvelopeError':
      return 'corrupt-envelope';
    case 'UnsupportedFormatError':
      return 'unsupported-format';
    case 'CorruptVaultError':
      return 'corrupt-vault';
    default:
      return 'unknown';
  }
}

/**
 * Map a thrown account-mutation error (addAccount / switchAccount) to a
 * discriminated reason. The KeyringManager's `requireUnlocked` rejects with a
 * "must be unlocked" message when the wallet is locked — matching on that
 * phrase keeps the UI from importing the manager's error internals. Anything
 * else falls through to `unknown`.
 */
function reasonForActionError(error: unknown): WalletActionReason {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('must be unlocked')) {
    return 'locked';
  }
  return 'unknown';
}

function asString(raw: StoredBlob): string {
  return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
}

/** A built (unsigned/signed) tx as it crosses the same-chain deps `sign` leg. */
type BuiltTxLike = { readonly cmd: string; readonly hash?: string; readonly sigs?: unknown };

/**
 * Resolve a complete {@link SameChainDeps} from an optional partial override:
 * lazily wire the live SDK-backed defaults (browser-safe — the live module imports
 * no node-only deps) and layer the caller's overrides on top. Returns `undefined`
 * when no override is supplied so the local send path keeps using core's own
 * default-deps lazy path unchanged.
 *
 * The lazy import keeps the live SDK client OUT of this module's eval graph, so
 * the web/test path that never sends does not pull the node-active client.
 */
async function resolveSameChainDeps(
  override?: Partial<SameChainDeps>,
): Promise<SameChainDeps> {
  // The live factory lives behind a NARROW subpath so the SDK client stays out
  // of the main barrel's static graph (mirrors core's `./testing` convention).
  const { makeLiveSameChainDeps } = await import('@stoawallet/core/send-live');
  return { ...makeLiveSameChainDeps(), ...(override ?? {}) };
}

/**
 * Resolve a complete {@link SendCrossChainStep0Deps} from an optional partial
 * override: lazily wire the live SDK-backed defaults (behind a narrow subpath so
 * the node-only cross-chain transport stays out of this module's eval graph) and
 * layer the caller's overrides on top. Returns `undefined` when no override is
 * supplied so the local cross-chain path keeps using core's own default-deps lazy
 * path unchanged.
 */
async function resolveCrossChainDeps(
  override?: Partial<SendCrossChainStep0Deps>,
): Promise<SendCrossChainStep0Deps> {
  const { makeLiveSendCrossChainStep0Deps } = await import(
    '@stoawallet/core/crosschain-live'
  );
  return { ...makeLiveSendCrossChainStep0Deps(), ...(override ?? {}) };
}

export function WalletProvider({
  storage,
  keyVault,
  remoteVault,
  biometric = new UnsupportedBiometricUnlock(),
  qrScanner = new UnsupportedQrScanner(),
  manager: injectedManager,
  children,
}: WalletProviderProps): ReactNode {
  // The KeyringManager is bound to the injected adapter for the provider's life.
  // An injected manager (mobile) is used verbatim so app-background auto-lock and
  // the provider share ONE manager; otherwise build one from the injected backers.
  const manager = useMemo(
    () => injectedManager ?? new KeyringManager({ storage, keyVault }),
    [injectedManager, storage, keyVault],
  );

  const [mode, setMode] = useState<OnboardingMode>('create');
  const [words, setWordsState] = useState<string[]>([]);
  const [hasConfirmedBackup, setHasConfirmedBackup] = useState(false);
  const [activeAccount, setActiveAccount] = useState<StoredAccount | null>(null);
  const [activeWalletAccounts, setActiveWalletAccounts] = useState<
    readonly StoredAccount[]
  >([]);
  const [existingWallets, setExistingWallets] = useState<
    ExistingWalletSummary[]
  >([]);
  const [activeWallet, setActiveWallet] = useState<ActiveWalletSummary | null>(
    null,
  );
  const [sessionExpired, setSessionExpired] = useState(false);
  // The REACTIVE background unlocked-state (null until the first query resolves /
  // no background). The lifecycle guard derives its status from this so an
  // in-popup unlock/lock re-renders the shell. In LOCAL mode (no remoteVault) it
  // stays null forever and the guard defers to `activeAccount`.
  const [remoteUnlocked, setRemoteUnlocked] = useState<boolean | null>(null);

  // The in-progress phrase's authoritative copy. It is held in a ref (not just
  // state) so an action can read the freshly generated phrase WITHIN the same
  // render cycle that `startCreate` produced it — React state would still be
  // the stale pre-generation value inside a synchronous closure. The state copy
  // (`words`) mirrors it purely for display. Both are cleared together on every
  // exit path so the plaintext phrase never lingers.
  const phraseWordsRef = useRef<string[]>([]);

  const setWords = useCallback((next: string[]) => {
    phraseWordsRef.current = next;
    setWordsState(next);
  }, []);

  // Pull the active account AND the active wallet's full account list off the
  // manager in one step, so every action that mutates the active selection keeps
  // both context values in sync (the switcher renders the list, not just the
  // single active account).
  const syncActiveSelection = useCallback(() => {
    setActiveAccount(manager.getActiveAccount());
    setActiveWalletAccounts(manager.getActiveWalletAccounts());
  }, [manager]);

  // The active-wallet id resolved from the stored vault pointer. Consumers never
  // pass a walletId; the context threads it into KeyringManager calls.
  const activeWalletIdRef = useRef<string | null>(null);

  // The active (public-only) account when running in remote-vault mode. The
  // local manager never decrypts in that mode, so its `getActiveAccount()` is
  // null; the send seam reads the sender from here instead. Carries no key.
  const remoteActiveAccountRef = useRef<StoredAccount | null>(null);

  /**
   * Re-read the stored vault to refresh `existingWallets` and the active-wallet
   * pointer. The vault's wallet metadata is plaintext (only the phrase is
   * encrypted-at-rest), so this works without unlocking.
   */
  const refreshFromStorage = useCallback(async () => {
    const raw = await storage.get(VAULT_KEY);
    if (raw === null) {
      activeWalletIdRef.current = null;
      setExistingWallets([]);
      setActiveWallet(null);
      return;
    }
    try {
      const vault = deserializeVault(asString(raw));
      activeWalletIdRef.current = vault.activeWalletId;
      setExistingWallets(
        vault.wallets.map((w) => ({ id: w.id, name: w.name })),
      );
      const active =
        vault.wallets.find((w) => w.id === vault.activeWalletId) ?? null;
      setActiveWallet(
        active === null
          ? null
          : { id: active.id, name: active.name, seedType: active.seedType },
      );
    } catch {
      // A vault blob that does not deserialize is surfaced through the next
      // unlock attempt's discriminated result, not by throwing during refresh.
      activeWalletIdRef.current = null;
      setExistingWallets([]);
      setActiveWallet(null);
    }
  }, [storage]);

  // Discover any pre-existing wallet on mount so onboarding can offer
  // "a wallet already exists → add another".
  useEffect(() => {
    void refreshFromStorage();
  }, [refreshFromStorage]);

  // Clear the in-progress phrase on unmount — the final exit path. Combined with
  // the explicit clears in saveWallet (success AND error), the phrase never
  // survives create-flow teardown, abandon, or a failed save. The unmount path
  // clears the authoritative ref directly: a `setState` after unmount is a
  // no-op, so scrubbing the ref is what actually drops the plaintext.
  useEffect(() => {
    return () => {
      phraseWordsRef.current = [];
    };
  }, []);

  /**
   * Generate a fresh phrase for the create flow and hold its words in state for
   * the backup screen. Generation is decoupled from persistence: the phrase is
   * NOT written here (no password is chosen yet). `saveWallet` later seals it
   * under the user's password via the same import path used by the import flow.
   */
  const startCreate = useCallback(async () => {
    setMode('create');
    setHasConfirmedBackup(false);
    const phrase = await generateMnemonic();
    setWords(phrase.split(/\s+/));
  }, [setWords]);

  const saveWallet = useCallback(
    async (password: string): Promise<WalletActionResult> => {
      const phrase = phraseWordsRef.current.join(' ');
      try {
        const { walletId } = await manager.importWallet(phrase, password);
        activeWalletIdRef.current = walletId;
        syncActiveSelection();
        await refreshFromStorage();
        return { ok: true };
      } catch (error) {
        if (error instanceof InvalidMnemonicError) {
          return { ok: false, reason: error.reason };
        }
        return { ok: false, reason: 'unknown' };
      } finally {
        // Clear the phrase on BOTH success and error — it is never read back.
        setWords([]);
      }
    },
    [manager, refreshFromStorage, setWords, syncActiveSelection],
  );

  const importWallet = useCallback(
    async (
      candidateWords: string[],
      password: string,
    ): Promise<WalletActionResult> => {
      try {
        const { walletId } = await manager.importWallet(
          candidateWords.join(' '),
          password,
        );
        activeWalletIdRef.current = walletId;
        syncActiveSelection();
        await refreshFromStorage();
        return { ok: true };
      } catch (error) {
        if (error instanceof InvalidMnemonicError) {
          return { ok: false, reason: error.reason };
        }
        return { ok: false, reason: 'unknown' };
      }
    },
    [manager, refreshFromStorage, syncActiveSelection],
  );

  /**
   * Pull the active account + the active wallet's account list off the REMOTE
   * vault (the background) and mirror them into context state. Used after a
   * remote unlock / account mutation so the screens render the background's
   * authoritative selection — the local manager never decrypted, so its cache is
   * empty in remote mode.
   */
  const syncRemoteSelection = useCallback(async () => {
    if (remoteVault === undefined) return;
    const [active, accounts] = await Promise.all([
      remoteVault.getActiveAccount(),
      remoteVault.listAccounts(),
    ]);
    const mapped = active === null ? null : fromRemoteAccount(active);
    // Mirror into a ref so the send seam reads the authoritative (public-only)
    // sender synchronously inside a closure, without waiting for a re-render.
    remoteActiveAccountRef.current = mapped;
    setActiveAccount(mapped);
    setActiveWalletAccounts(accounts.map(fromRemoteAccount));
  }, [remoteVault]);

  const unlock = useCallback(
    async (password: string): Promise<WalletActionResult> => {
      await refreshFromStorage();
      const walletId = activeWalletIdRef.current;
      if (walletId === null) {
        return { ok: false, reason: 'no-wallet' };
      }

      // XP-12: delegate to the background so the popup never decrypts the
      // mnemonic. The wire reasons are the SAME discriminated set the local path
      // produces, so the unlock UI branches unchanged.
      if (remoteVault !== undefined) {
        const result = await remoteVault.unlock(walletId, password);
        if (result.ok) {
          await syncRemoteSelection();
          // A fresh unlock re-populates the background session: the prior expiry
          // is resolved, so drop the "session expired" framing and flip the
          // reactive unlocked-state so the lifecycle guard re-renders to HOME.
          setSessionExpired(false);
          setRemoteUnlocked(true);
        }
        return result;
      }

      try {
        await manager.unlock(walletId, password);
        syncActiveSelection();
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: reasonForUnlockError(error) };
      }
    },
    [manager, refreshFromStorage, syncActiveSelection, remoteVault, syncRemoteSelection],
  );

  const reportSessionLocked = useCallback(() => {
    // Only meaningful with a background owner. The web/test path never reaches a
    // mid-session expiry (the local manager's locked-state drives the UI directly).
    if (remoteVault === undefined) return;
    setSessionExpired(true);
    // The background session is gone: flip the reactive unlocked-state so the
    // guard re-derives to the re-unlock screen.
    setRemoteUnlocked(false);
  }, [remoteVault]);

  const refreshRemoteUnlocked =
    useCallback(async (): Promise<boolean | null> => {
      // No background ⇒ the local `activeAccount` is the source of truth; signal
      // that by returning null so the caller keeps the unchanged local branching.
      if (remoteVault === undefined) return null;
      const unlocked = await remoteVault.isUnlocked();
      // Store the queried value as the reactive baseline the guard derives from.
      setRemoteUnlocked(unlocked);
      if (unlocked) {
        // Mirror the background's live selection so HOME renders the active
        // account immediately on popup open without an explicit unlock step.
        await syncRemoteSelection();
      } else {
        // The worker holds no session (terminated / auto-locked). Drop any stale
        // mirrored account so the shell routes to re-unlock.
        remoteActiveAccountRef.current = null;
        setActiveAccount(null);
        setActiveWalletAccounts([]);
      }
      return unlocked;
    }, [remoteVault, syncRemoteSelection]);

  const lock = useCallback(async () => {
    if (remoteVault !== undefined) {
      await remoteVault.lock();
      remoteActiveAccountRef.current = null;
      setActiveAccount(null);
      setActiveWalletAccounts([]);
      // Flip the reactive unlocked-state so the guard re-derives to re-unlock.
      setRemoteUnlocked(false);
      return;
    }
    await manager.lock();
  }, [manager, remoteVault]);

  const addAccount = useCallback(async (): Promise<WalletActionResult> => {
    const walletId = activeWalletIdRef.current;
    if (walletId === null) return { ok: false, reason: 'no-wallet' };
    // XP-12: in remote mode the local manager is an inert/always-locked proxy
    // holder — adding through it hits `requireUnlocked` and throws, and the
    // background's account set is never mutated. Route the add through the
    // background and re-mirror its authoritative selection.
    if (remoteVault !== undefined) {
      const result = await remoteVault.addAccount(walletId);
      if (result.ok) await syncRemoteSelection();
      return result;
    }
    try {
      await manager.addAccount(walletId);
      syncActiveSelection();
      return { ok: true };
    } catch (error) {
      // A locked manager rejects via requireUnlocked — surface it as a
      // discriminated failure instead of an unhandled rejection.
      return { ok: false, reason: reasonForActionError(error) };
    }
  }, [manager, syncActiveSelection, remoteVault, syncRemoteSelection]);

  const switchAccount = useCallback(
    async (index: number): Promise<WalletActionResult> => {
      const walletId = activeWalletIdRef.current;
      if (walletId === null) return { ok: false, reason: 'no-wallet' };
      // XP-12: in remote mode the local manager never decrypted, so switching
      // through it leaves the BACKGROUND's active-account pointer untouched — a
      // later `signTx {kind:'active'}` would sign for the OLD account while the
      // UI shows the new one (wrong-account fund movement). Route the switch
      // through the background, then mirror its authoritative selection.
      if (remoteVault !== undefined) {
        const result = await remoteVault.setActiveAccount(walletId, index);
        if (result.ok) await syncRemoteSelection();
        return result;
      }
      try {
        await manager.setActiveAccount(walletId, index);
        syncActiveSelection();
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: reasonForActionError(error) };
      }
    },
    [manager, syncActiveSelection, remoteVault, syncRemoteSelection],
  );

  /**
   * Set the selected account WITHIN a SPECIFIC seed, without changing which seed
   * is active. The Advanced tab's two-tier selector uses this: each seed remembers
   * its own selected account, and the account in SERVICE for operations is the
   * active seed's selected account. Setting the active seed's account moves the
   * operational selection; setting a non-active seed's account only updates that
   * seed's own pointer (it becomes operational once that seed is made active).
   */
  const setSeedActiveAccount = useCallback(
    async (walletId: string, index: number): Promise<WalletActionResult> => {
      if (remoteVault !== undefined) {
        const result = await remoteVault.setActiveAccount(walletId, index);
        if (result.ok) await syncRemoteSelection();
        return result;
      }
      try {
        await manager.setActiveAccount(walletId, index);
        syncActiveSelection();
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: reasonForActionError(error) };
      }
    },
    [manager, syncActiveSelection, remoteVault, syncRemoteSelection],
  );

  // ── Advanced / Codex (multi-seed) ──

  const listWallets = useCallback(async (): Promise<
    readonly RemoteWalletSummary[]
  > => {
    if (remoteVault !== undefined) return remoteVault.listWallets();
    return manager.listWallets();
  }, [manager, remoteVault]);

  const listPureKeypairs = useCallback(async (): Promise<
    readonly RemotePureKeypair[]
  > => {
    if (remoteVault !== undefined) return remoteVault.listPureKeypairs();
    return manager.listPureKeypairs();
  }, [manager, remoteVault]);

  const switchWallet = useCallback(
    async (walletId: string): Promise<WalletActionResult> => {
      // Remote mode: switch the SEED in the background (which re-points signing),
      // then mirror its authoritative selection — same discipline as switchAccount.
      if (remoteVault !== undefined) {
        const result = await remoteVault.setActiveWallet(walletId);
        if (result.ok) {
          // The active SEED is now `walletId` — re-point the ref so a subsequent
          // `switchAccount` (which keys off it) targets THIS seed, not the prior
          // one. `syncRemoteSelection` mirrors only the active account, not the id.
          activeWalletIdRef.current = walletId;
          await syncRemoteSelection();
        }
        return result;
      }
      try {
        await manager.setActiveWallet(walletId);
        activeWalletIdRef.current = walletId;
        syncActiveSelection();
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: reasonForActionError(error) };
      }
    },
    [manager, syncActiveSelection, remoteVault, syncRemoteSelection],
  );

  const addAccountAtIndex = useCallback(
    async (walletId: string, index: number): Promise<WalletActionResult> => {
      if (remoteVault !== undefined) {
        const result = await remoteVault.addAccountAtIndex(walletId, index);
        if (result.ok) await syncRemoteSelection();
        return result;
      }
      try {
        await manager.addAccountAtIndex(walletId, index);
        syncActiveSelection();
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: reasonForActionError(error) };
      }
    },
    [manager, syncActiveSelection, remoteVault, syncRemoteSelection],
  );

  const removeAccount = useCallback(
    async (walletId: string, index: number): Promise<WalletActionResult> => {
      if (remoteVault !== undefined) {
        const result = await remoteVault.removeAccount(walletId, index);
        if (result.ok) await syncRemoteSelection();
        return result;
      }
      try {
        await manager.removeAccount(walletId, index);
        syncActiveSelection();
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: reasonForActionError(error) };
      }
    },
    [manager, syncActiveSelection, remoteVault, syncRemoteSelection],
  );

  const renameWallet = useCallback(
    async (walletId: string, name: string): Promise<WalletActionResult> => {
      if (remoteVault !== undefined) {
        const result = await remoteVault.renameWallet(walletId, name);
        if (result.ok) await syncRemoteSelection();
        return result;
      }
      try {
        await manager.renameWallet(walletId, name);
        syncActiveSelection();
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: reasonForActionError(error) };
      }
    },
    [manager, syncActiveSelection, remoteVault, syncRemoteSelection],
  );

  const importCodex = useCallback(
    async (
      json: string,
      codexPassword: string,
    ): Promise<RemoteImportCodexResult> => {
      if (remoteVault !== undefined) {
        const result = await remoteVault.importCodex(json, codexPassword);
        // A successful import added seeds; re-mirror the (unchanged active)
        // selection so a freshly imported seed is visible to the switcher.
        if (result.ok) await syncRemoteSelection();
        return result;
      }
      try {
        const outcome = await manager.importCodex(json, codexPassword);
        if (outcome.ok) {
          syncActiveSelection();
          return { ok: true, summary: outcome.summary };
        }
        return { ok: false, reason: outcome.reason };
      } catch {
        // The only throw is a locked wallet (manager.importCodex requires unlock).
        return { ok: false, reason: 'locked' };
      }
    },
    [manager, syncActiveSelection, remoteVault, syncRemoteSelection],
  );

  const sendSameChain = useCallback(
    async (params: ContextSendParams): Promise<ContextSendResult> => {
      const sendParams = {
        recipient: params.recipient,
        amount: params.amount,
        chainId: params.chainId,
      };

      // XP-12 remote-sign path (the extension popup): resolve NO keypair locally.
      // The active account's PUBLIC key alone seeds the signer set so core builds
      // the correct signer cap; the `sign` leg of the deps is overridden to route
      // through the background, which holds the keypair and returns only the
      // signed public transaction. Every other deps leg (read/build/simulate/
      // submit/gas) is the production default unless a test injects a stub.
      if (remoteVault !== undefined) {
        const active = remoteActiveAccountRef.current;
        if (active === null) {
          return { ok: false, reason: 'locked' };
        }

        // A PUBLIC-ONLY pseudo-keypair: empty secret fields so `scrub` finds no
        // secret and the signer set carries the sender's pubkey only.
        const publicOnly = [
          { publicKey: active.publicKey, privateKey: '', seedType: 'koala' as const },
        ];

        const remoteSign = async (tx: BuiltTxLike): Promise<BuiltTxLike> => {
          const result = await remoteVault.signTx({ kind: 'active' }, tx);
          if (!result.ok) {
            // Surface as a thrown locked so the orchestrator's submit/precheck
            // boundary collapses it — the catch maps it back to a discriminated
            // result below.
            throw new WalletLockedError();
          }
          return result.signed as BuiltTxLike;
        };

        const baseDeps = await resolveSameChainDeps(params.sendDeps);
        try {
          return await coreSendSameChain(
            { ...sendParams, sender: active.account },
            publicOnly,
            { ...baseDeps, sign: remoteSign },
          );
        } catch (error) {
          if (error instanceof WalletLockedError) {
            return { ok: false, reason: 'locked' };
          }
          throw error;
        }
      }

      const active = manager.getActiveAccount();
      if (active === null) {
        return { ok: false, reason: 'locked' };
      }

      let keypairs;
      try {
        // Re-derive the sign-ready keypair SET from the in-memory unlocked
        // mnemonic + password. A locked wallet rejects here BEFORE core is
        // called, so the signer never runs with null keys.
        keypairs = await manager.resolveActiveSigningKeypairs();
      } catch (error) {
        if (error instanceof WalletLockedError) {
          return { ok: false, reason: 'locked' };
        }
        throw error;
      }

      // The keypair SET is consumed INSIDE this op and never returned (XP-12).
      return coreSendSameChain(
        { ...sendParams, sender: active.account },
        keypairs,
        params.sendDeps !== undefined
          ? await resolveSameChainDeps(params.sendDeps)
          : undefined,
      );
    },
    [manager, remoteVault],
  );

  const awaitSendConfirmation = useCallback(
    (requestKey: string, chainId: string): Promise<ConfirmSendResult> =>
      // A pure on-chain read (no key material) — forward straight to core. The
      // live seam resolves the active node + failover itself.
      coreAwaitSendConfirmation(requestKey, chainId),
    [],
  );

  const getSession = useCallback(
    async (): Promise<RemoteSessionStatus | null> =>
      // Extension only: poll the background's auto-lock tick. No background (the
      // web/mobile path) means no auto-lock window — resolve null so the UI hides
      // the countdown there.
      remoteVault !== undefined ? remoteVault.getSession() : null,
    [remoteVault],
  );

  const setAutoLock = useCallback(
    async (minutes: number): Promise<number> => {
      if (remoteVault !== undefined) return remoteVault.setAutoLock(minutes);
      // No background: just persist the preference (clamped) over storage.
      return coreSetAutoLockMinutes(storage, minutes);
    },
    [remoteVault, storage],
  );

  const sendCrossChainStep0 = useCallback(
    async (
      params: ContextCrossChainParams,
    ): Promise<ContextCrossChainStep0Result> => {
      // XP-12 remote-sign path (the extension popup): resolve NO keypair locally.
      // The active account's PUBLIC key seeds the signer set so core builds the
      // correct signer caps; the cross-chain deps' `signTransaction` leg is
      // overridden to route signing through the background, which holds the keypair
      // and returns only the signed public transaction. On chain 0 the gas-payer
      // cap is signed by the sender's OWN key (XP-8), so both caps carry the
      // sender's pubkey and a single `signTx {kind:'active'}` fills both slots.
      // This is the SAME shape `sendSameChain` uses, and it makes Phase-5
      // cross-chain functional in the extension (the deferred carry-forward gap).
      if (remoteVault !== undefined) {
        const active = remoteActiveAccountRef.current;
        if (active === null) {
          return { ok: false, reason: 'locked' };
        }

        const publicOnly = [
          { publicKey: active.publicKey, privateKey: '', seedType: 'koala' as const },
        ];

        const remoteSignTransaction = async (
          tx: UnsignedTx,
        ): Promise<UnsignedTx> => {
          const result = await remoteVault.signTx({ kind: 'active' }, tx);
          if (!result.ok) {
            throw new WalletLockedError();
          }
          return result.signed as UnsignedTx;
        };

        const gasStationPublicKey =
          params.sourceChain === '0' ? active.publicKey : undefined;

        const baseDeps = await resolveCrossChainDeps(params.crossDeps);
        try {
          return await coreSendCrossChainStep0(
            {
              sender: active.account,
              receiver: params.receiver,
              amount: params.amount,
              sourceChain: params.sourceChain,
              targetChain: params.targetChain,
              senderPublicKey: active.publicKey,
              gasStationPublicKey,
            },
            publicOnly,
            { ...baseDeps, signTransaction: remoteSignTransaction },
          );
        } catch (error) {
          if (error instanceof WalletLockedError) {
            return { ok: false, reason: 'locked' };
          }
          throw error;
        }
      }

      const active = manager.getActiveAccount();
      if (active === null) {
        return { ok: false, reason: 'locked' };
      }

      let keypairs;
      try {
        // Re-derive the sign-ready keypair SET from the in-memory unlocked
        // mnemonic + password. A locked wallet rejects here BEFORE core is
        // called, so the signer never runs with null keys.
        keypairs = await manager.resolveActiveSigningKeypairs();
      } catch (error) {
        if (error instanceof WalletLockedError) {
          return { ok: false, reason: 'locked' };
        }
        throw error;
      }

      // On chain 0 the Ouronet Gas Station requires a co-signer cap; for the
      // base single-account wallet the sender's OWN key signs that cap (XP-8),
      // so the gas-station public key is the sender's own pub. On any other
      // source chain there is no gas-station co-signer (xchain-gas path).
      const gasStationPublicKey =
        params.sourceChain === '0' ? active.publicKey : undefined;

      // The keypair SET is consumed INSIDE this op and never returned (XP-12).
      return coreSendCrossChainStep0(
        {
          sender: active.account,
          receiver: params.receiver,
          amount: params.amount,
          sourceChain: params.sourceChain,
          targetChain: params.targetChain,
          senderPublicKey: active.publicKey,
          gasStationPublicKey,
        },
        keypairs,
        params.crossDeps !== undefined
          ? await resolveCrossChainDeps(params.crossDeps)
          : undefined,
      );
    },
    [manager, remoteVault],
  );

  // The UrStoa op surface (XP-12). LOCAL mode resolves the active keypair via the
  // manager and runs the core wrapper in-process (mobile/web); REMOTE mode routes
  // the WHOLE op to the background (which holds the unlocked key) because the SDK
  // executors bundle build+sign+submit around a literal keypair — there is no
  // single-signature seam to route back. The popup hooks pass PUBLIC params only;
  // no keypair ever crosses from the hook into these ops.

  const urstoaStake = useCallback(
    async (params: ContextUrStoaStakeParams): Promise<ContextUrStoaResult> => {
      if (remoteVault !== undefined) {
        if (remoteActiveAccountRef.current === null) {
          return { ok: false, reason: 'locked' };
        }
        return remoteVault.urstoaExecute({
          op: 'stake',
          params: {
            paymentKeyAddress: params.paymentKeyAddress,
            amount: params.amount,
          },
        });
      }
      const active = manager.getActiveAccount();
      if (active === null) {
        return { ok: false, reason: 'locked' };
      }
      let keypairs;
      try {
        keypairs = await manager.resolveActiveSigningKeypairs();
      } catch (error) {
        if (error instanceof WalletLockedError) {
          return { ok: false, reason: 'locked' };
        }
        throw error;
      }
      const op = params.urstoaCore?.stakeUrStoa ?? coreStakeUrStoa;
      // The active account's own keypair signs BOTH the gas-payer and op caps
      // (RR#1); it is consumed INSIDE the wrapper and never returned (XP-12).
      return op({
        paymentKeyAddress: params.paymentKeyAddress,
        amount: params.amount,
        gasStationKey: keypairs[0] as UrStoaStakeParams['gasStationKey'],
      });
    },
    [manager, remoteVault],
  );

  const urstoaUnstake = useCallback(
    async (params: ContextUrStoaStakeParams): Promise<ContextUrStoaResult> => {
      if (remoteVault !== undefined) {
        if (remoteActiveAccountRef.current === null) {
          return { ok: false, reason: 'locked' };
        }
        return remoteVault.urstoaExecute({
          op: 'unstake',
          params: {
            paymentKeyAddress: params.paymentKeyAddress,
            amount: params.amount,
          },
        });
      }
      const active = manager.getActiveAccount();
      if (active === null) {
        return { ok: false, reason: 'locked' };
      }
      let keypairs;
      try {
        keypairs = await manager.resolveActiveSigningKeypairs();
      } catch (error) {
        if (error instanceof WalletLockedError) {
          return { ok: false, reason: 'locked' };
        }
        throw error;
      }
      const op = params.urstoaCore?.unstakeUrStoa ?? coreUnstakeUrStoa;
      return op({
        paymentKeyAddress: params.paymentKeyAddress,
        amount: params.amount,
        gasStationKey: keypairs[0] as UrStoaStakeParams['gasStationKey'],
      });
    },
    [manager, remoteVault],
  );

  const urstoaCollect = useCallback(
    async (params: ContextUrStoaCollectParams): Promise<ContextUrStoaResult> => {
      if (remoteVault !== undefined) {
        if (remoteActiveAccountRef.current === null) {
          return { ok: false, reason: 'locked' };
        }
        return remoteVault.urstoaExecute({
          op: 'collect',
          params: { paymentKeyAddress: params.paymentKeyAddress },
        });
      }
      const active = manager.getActiveAccount();
      if (active === null) {
        return { ok: false, reason: 'locked' };
      }
      let keypairs;
      try {
        keypairs = await manager.resolveActiveSigningKeypairs();
      } catch (error) {
        if (error instanceof WalletLockedError) {
          return { ok: false, reason: 'locked' };
        }
        throw error;
      }
      const op = params.urstoaCore?.collectUrStoa ?? coreCollectUrStoa;
      return op({
        paymentKeyAddress: params.paymentKeyAddress,
        gasStationKey: keypairs[0] as CollectUrStoaParams['gasStationKey'],
      });
    },
    [manager, remoteVault],
  );

  const urstoaTransfer = useCallback(
    async (params: ContextUrStoaTransferParams): Promise<ContextUrStoaResult> => {
      if (remoteVault !== undefined) {
        if (remoteActiveAccountRef.current === null) {
          return { ok: false, reason: 'locked' };
        }
        return remoteVault.urstoaExecute({
          op: 'transfer',
          params: {
            senderAddress: params.senderAddress,
            receiverAddress: params.receiverAddress,
            amount: params.amount,
          },
        });
      }
      const active = manager.getActiveAccount();
      if (active === null) {
        return { ok: false, reason: 'locked' };
      }
      let keypairs;
      try {
        keypairs = await manager.resolveActiveSigningKeypairs();
      } catch (error) {
        if (error instanceof WalletLockedError) {
          return { ok: false, reason: 'locked' };
        }
        throw error;
      }
      const op = params.urstoaCore?.transferUrStoa ?? coreTransferUrStoa;
      // The sender IS the payment key (PAT-004); the active keypair signs both caps.
      return op({
        senderAddress: params.senderAddress,
        receiverAddress: params.receiverAddress,
        amount: params.amount,
        paymentKeyAddress: params.senderAddress,
        paymentKeypair: keypairs[0] as TransferUrStoaParams['paymentKeypair'],
      });
    },
    [manager, remoteVault],
  );

  const resolveActiveMinerSigners = useCallback(
    async (needsGasStation: boolean): Promise<ContextMinerSignersResult> => {
      // XP-12 remote-sign path: NO keypair is resolved locally. The active
      // account's PUBLIC key seeds a public-only set (empty secret) and a
      // `signTransaction` override routes the real signature through the
      // background. The chain-0 gas-payer cap is the sender's own key (XP-8), so
      // its stub mirrors the sender's pubkey — a single background `signTx
      // {kind:'active'}` fills BOTH the transfer and gas-payer cap slots.
      if (remoteVault !== undefined) {
        const active = remoteActiveAccountRef.current;
        if (active === null) {
          return { ok: false, reason: 'locked' };
        }
        const publicKeypair: SignableKeypair = {
          publicKey: active.publicKey,
          privateKey: '',
          seedType: 'koala',
        };
        const remoteSignTransaction = async (
          tx: UnsignedTx,
        ): Promise<UnsignedTx> => {
          const result = await remoteVault.signTx({ kind: 'active' }, tx);
          if (!result.ok) {
            throw new WalletLockedError();
          }
          return result.signed as UnsignedTx;
        };
        return {
          ok: true,
          signingKeypairs: [publicKeypair],
          gasStationKeypair: needsGasStation ? publicKeypair : undefined,
          signTransaction: remoteSignTransaction,
        };
      }

      // LOCAL path: re-derive the real sign-ready SET from the in-memory unlocked
      // state INSIDE the context (XP-2). The keys are returned for the sweep to
      // consume inside the signing boundary and are never logged. The chain-0
      // gas-payer cap is the sender's OWN key (XP-8), so the gas-station keypair
      // mirrors the first sender keypair. No remote override — core's signer runs.
      const active = manager.getActiveAccount();
      if (active === null) {
        return { ok: false, reason: 'locked' };
      }
      let keypairs: readonly SignableKeypair[];
      try {
        keypairs = await manager.resolveActiveSigningKeypairs();
      } catch (error) {
        if (error instanceof WalletLockedError) {
          return { ok: false, reason: 'locked' };
        }
        throw error;
      }
      return {
        ok: true,
        signingKeypairs: keypairs,
        gasStationKeypair: needsGasStation ? keypairs[0] : undefined,
      };
    },
    [manager, remoteVault],
  );

  const addAdvancedAccount = useCallback(
    async (
      address: string,
      chainId: string,
    ): Promise<ContextAddAdvancedResult> => {
      // No active account ⇒ no wallet to attribute the add to: short-circuit
      // BEFORE any vault read or core call, mirroring the send seams' locked gate.
      if (manager.getActiveAccount() === null) {
        return { ok: false, reason: 'locked' };
      }
      return manager.addAdvancedAccount(address, chainId);
    },
    [manager],
  );

  const resolveForeignKey = useCallback(
    async (
      account: AdvancedAccount,
      privateKey: string,
    ): Promise<ContextResolveForeignKeyResult> => {
      try {
        // The manager reads the unlocked password internally and hands the pasted
        // key straight to core. The context retains NO reference to `privateKey`
        // beyond this call — it is only the argument forwarded here (RR#8).
        return await manager.resolveForeignKey(account, privateKey);
      } catch (error) {
        // A locked wallet rejects in the manager BEFORE the key is processed;
        // map it to the discriminated `locked` outcome instead of throwing.
        if (error instanceof WalletLockedError) {
          return { ok: false, reason: 'locked' };
        }
        throw error;
      }
    },
    [manager],
  );

  const resolveAdvancedSigningKeypairs = useCallback(
    async (
      account: AdvancedAccount,
    ): Promise<ContextResolveAdvancedSigningResult> => {
      try {
        // The manager re-derives/decrypts the keypair SET from the in-memory
        // unlocked state internally (XP-12). The keypairs are returned for the
        // advanced send path to consume inside the signing boundary.
        return await manager.resolveAdvancedSigningKeypairs(account);
      } catch (error) {
        // A locked wallet rejects in the manager BEFORE any key is processed;
        // map it to the discriminated `locked` outcome instead of throwing.
        if (error instanceof WalletLockedError) {
          return { ok: false, reason: 'locked' };
        }
        throw error;
      }
    },
    [manager],
  );

  const listAdvancedAccounts = useCallback(
    (): Promise<readonly AdvancedAccount[]> => manager.listAdvancedAccounts(),
    [manager],
  );

  const value: WalletContextValue = {
    mode,
    setMode,
    words,
    hasConfirmedBackup,
    setHasConfirmedBackup,
    activeAccount,
    sessionExpired,
    remoteUnlocked,
    reportSessionLocked,
    refreshRemoteUnlocked,
    activeWalletAccounts,
    hasExistingWallet: existingWallets.length > 0,
    existingWallets,
    activeWallet,
    startCreate,
    saveWallet,
    importWallet,
    unlock,
    lock,
    addAccount,
    switchAccount,
    setSeedActiveAccount,
    sendSameChain,
    awaitSendConfirmation,
    getSession,
    setAutoLock,
    listWallets,
    listPureKeypairs,
    switchWallet,
    addAccountAtIndex,
    removeAccount,
    renameWallet,
    importCodex,
    sendCrossChainStep0,
    urstoaStake,
    urstoaUnstake,
    urstoaCollect,
    urstoaTransfer,
    resolveActiveMinerSigners,
    addAdvancedAccount,
    resolveForeignKey,
    resolveAdvancedSigningKeypairs,
    listAdvancedAccounts,
    storage,
    biometric,
    qrScanner,
  };

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (ctx === null) {
    throw new Error('useWallet must be used within a WalletProvider');
  }
  return ctx;
}

/**
 * Non-throwing context read for hooks that can run with their storage seam fully
 * INJECTED (and thus do not require a provider). Returns `null` when no provider
 * is mounted instead of throwing, so a recovery hook used standalone (the
 * Continue tab, tests injecting an in-memory storage double) still mounts.
 */
export function useOptionalWallet(): WalletContextValue | null {
  return useContext(WalletContext);
}
