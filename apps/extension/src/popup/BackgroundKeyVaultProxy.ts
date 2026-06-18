import type {
  RemoteVault,
  RemoteUnlockResult,
  RemoteUrStoaOutcome,
  RemoteWalletSummary,
  RemotePureKeypair,
  RemoteImportCodexResult,
  WalletActionReason,
} from '@stoawallet/ui';

import type {
  FailureReason,
  Request,
  RequestType,
  ResponseFor,
  SignerSpec,
  UrStoaOpRequest,
  WireAccount,
  WireCommand,
} from '../messaging/protocol';

/**
 * Collapse a wire {@link FailureReason} onto the Phase-2 {@link WalletActionReason}
 * the unlock UI branches on. The shared reasons (`wrong-password` /
 * `corrupt-envelope` / `unsupported-format` / `locked` / `no-wallet`) pass
 * through verbatim; the SW-only `unauthorized` / `unsupported-signer` (which the
 * popup's own trusted, single-account flow never legitimately hits) collapse to
 * `unknown` so the UI shows a generic failure rather than a leaked wire detail.
 */
function mapReason(reason: FailureReason): WalletActionReason {
  switch (reason) {
    case 'wrong-password':
    case 'corrupt-envelope':
    case 'unsupported-format':
    case 'locked':
    case 'no-wallet':
      return reason;
    default:
      return 'unknown';
  }
}

/**
 * The popup-side custody client: it speaks the {@link RemoteVault} delegation
 * surface the shared `WalletProvider` consumes, but holds NO key material. Every
 * keyring op is forwarded over the T7.2 wire (`chrome.runtime.sendMessage`) to
 * the background service worker — the session owner that holds the unlocked
 * mnemonic + sealing password behind the runtime boundary.
 *
 * SECURITY POSTURE (load-bearing):
 *   - NO local mnemonic / privateKey / secretKey / password / unlockedKey field.
 *     The unlocked-key getter is NOT a field here: the key lives only in the
 *     worker, and a memory inspection of this object finds nothing to leak.
 *   - {@link signTx} sends a {@link SignerSpec} (WHAT to sign with), never a key,
 *     and the reply carries ONLY the signed public transaction.
 *   - The discriminated `{ok:false, reason}` failures are surfaced VERBATIM so
 *     the Phase-2 unlock UI branches UNCHANGED (wrap-not-fork): the wire reason
 *     strings (`wrong-password` / `corrupt-envelope` / `unsupported-format` /
 *     `locked` / `no-wallet`) are exactly the reasons the context already maps.
 */
export class BackgroundKeyVaultProxy implements RemoteVault {
  /**
   * Send one typed protocol request to the background and await its response.
   * The only external boundary; structured-clone-safe plain data crosses it.
   */
  private async send<T extends RequestType>(
    message: Extract<Request, { type: T }>,
  ): Promise<ResponseFor<T>> {
    const chrome = (globalThis as unknown as { chrome?: ChromeRuntime }).chrome;
    if (chrome?.runtime?.sendMessage === undefined) {
      throw new Error('chrome.runtime.sendMessage is unavailable in this context.');
    }
    return (await chrome.runtime.sendMessage(message)) as ResponseFor<T>;
  }

  /**
   * Unlock the active wallet in the background. The password transits the wire
   * ONCE (popup → worker) and is never retained here. The success/failure result
   * is the protocol's discriminated outcome, mapped to the Phase-2 reason set.
   */
  async unlock(walletId: string, password: string): Promise<RemoteUnlockResult> {
    const res = await this.send({ type: 'unlock', walletId, password });
    if (res.ok) return { ok: true };
    return { ok: false, reason: mapReason(res.reason) };
  }

  /** Lock the background session (clears the worker's in-memory mnemonic + key). */
  async lock(): Promise<void> {
    await this.send({ type: 'lock' });
  }

  /** Query whether the worker currently holds an unlocked session. */
  async isUnlocked(): Promise<boolean> {
    const res = await this.send({ type: 'isUnlocked' });
    return res.ok === true && res.unlocked === true;
  }

  /**
   * The auto-lock TICK: poll the worker's session status. This message keeps the
   * MV3 worker alive (each inbound message resets its idle-termination timer) and
   * the worker pokes the auto-lock + reports the live expiry for the countdown.
   */
  async getSession(): Promise<{
    unlocked: boolean;
    expiresAt: number | null;
    autoLockMinutes: number;
  }> {
    const res = await this.send({ type: 'getSession' });
    if (res.ok) {
      return {
        unlocked: res.unlocked,
        expiresAt: res.expiresAt,
        autoLockMinutes: res.autoLockMinutes,
      };
    }
    return { unlocked: false, expiresAt: null, autoLockMinutes: 0 };
  }

  /** Set the auto-lock window (minutes); the worker clamps + persists it. */
  async setAutoLock(minutes: number): Promise<number> {
    const res = await this.send({ type: 'setAutoLock', minutes });
    return res.ok ? res.autoLockMinutes : minutes;
  }

  /** Every seed (wallet) in the vault — public summaries for the Advanced tab. */
  async listWallets(): Promise<readonly RemoteWalletSummary[]> {
    const res = await this.send({ type: 'listWallets' });
    return res.ok ? res.wallets : [];
  }

  /** Every vault pure keypair — public summaries for the Advanced tab. */
  async listPureKeypairs(): Promise<readonly RemotePureKeypair[]> {
    const res = await this.send({ type: 'listPureKeypairs' });
    return res.ok ? res.keys : [];
  }

  /** Switch the active seed in the worker (re-points signing). */
  async setActiveWallet(walletId: string): Promise<RemoteUnlockResult> {
    const res = await this.send({ type: 'setActiveWallet', walletId });
    return res.ok ? { ok: true } : { ok: false, reason: mapReason(res.reason) };
  }

  /** Derive a specific account index on a seed (returns ack; the UI re-lists). */
  async addAccountAtIndex(
    walletId: string,
    index: number,
  ): Promise<RemoteUnlockResult> {
    const res = await this.send({ type: 'addAccountAtIndex', walletId, index });
    return res.ok ? { ok: true } : { ok: false, reason: mapReason(res.reason) };
  }

  /** Rename a seed (non-secret metadata); ack/failure. */
  async renameWallet(walletId: string, name: string): Promise<RemoteUnlockResult> {
    const res = await this.send({ type: 'renameWallet', walletId, name });
    return res.ok ? { ok: true } : { ok: false, reason: mapReason(res.reason) };
  }

  /** Remove a derived account (index #0 is rejected host-side); ack/failure. */
  async removeAccount(walletId: string, index: number): Promise<RemoteUnlockResult> {
    const res = await this.send({ type: 'removeAccount', walletId, index });
    return res.ok ? { ok: true } : { ok: false, reason: mapReason(res.reason) };
  }

  /** Import an Ouronet Codex export in the worker; only counts return. */
  async importCodex(
    json: string,
    codexPassword: string,
  ): Promise<RemoteImportCodexResult> {
    const res = await this.send({ type: 'importCodex', json, codexPassword });
    return res.ok
      ? { ok: true, summary: res.summary }
      : { ok: false, reason: res.reason };
  }

  /** The active account of the unlocked wallet, or null. Carries no key. */
  async getActiveAccount(): Promise<WireAccount | null> {
    const res = await this.send({ type: 'getActiveAccount' });
    return res.ok ? res.account : null;
  }

  /** The active wallet's derived accounts (public records only). */
  async listAccounts(): Promise<readonly WireAccount[]> {
    const res = await this.send({ type: 'listAccounts' });
    return res.ok ? res.accounts : [];
  }

  /** Derive the next account in the background; returns the new public record. */
  async addAccount(walletId: string): Promise<RemoteUnlockResult> {
    const res = await this.send({ type: 'addAccount', walletId });
    return res.ok ? { ok: true } : { ok: false, reason: mapReason(res.reason) };
  }

  /** Point the active wallet at one of its existing accounts (no secret). */
  async setActiveAccount(walletId: string, index: number): Promise<RemoteUnlockResult> {
    const res = await this.send({ type: 'setActiveAccount', walletId, index });
    return res.ok ? { ok: true } : { ok: false, reason: mapReason(res.reason) };
  }

  /**
   * Sign a transaction in the background. The popup sends the {@link SignerSpec}
   * (WHAT to sign with) — never a key — and the worker resolves the keypair set,
   * signs, and returns ONLY the signed public transaction. A locked session
   * replies `{ok:false, reason:'locked'}` so the UI routes to re-unlock.
   */
  async signTx(
    signerSpec: unknown,
    tx: unknown,
    accountIndex = 0,
  ): Promise<SignTxOutcome> {
    const res = await this.send({
      type: 'signTx',
      tx: tx as WireCommand,
      accountIndex,
      signerSpec: signerSpec as SignerSpec,
    });
    if (res.ok && 'signed' in res) {
      return { ok: true, signed: res.signed };
    }
    // A non-success signTx reply is always a discriminated failure.
    const reason = 'reason' in res ? res.reason : 'locked';
    return { ok: false, reason };
  }

  /**
   * Run a full UrStoa write op (stake/unstake/collect/transfer) in the background
   * (XP-12). The popup sends ONLY the `op` discriminant + PUBLIC params — never a
   * keypair; the worker resolves the active account's key, runs the core wrapper,
   * and returns the discriminated result. The keypair never crosses this surface.
   */
  async urstoaExecute(request: {
    readonly op: 'stake' | 'unstake' | 'collect' | 'transfer';
    readonly params: unknown;
  }): Promise<RemoteUrStoaOutcome> {
    // The op + public params are JSON-safe plain data; the structural-decoupling
    // cast bridges the UI package's `unknown` params to the concrete wire union.
    const message = {
      type: 'urstoaOp',
      op: request.op,
      params: request.params,
    } as unknown as UrStoaOpRequest;
    const res = await this.send(message);
    if (res.ok) {
      return { ok: true, requestKey: res.requestKey, status: res.status };
    }
    return { ok: false, reason: res.reason, detail: res.detail };
  }
}

/** The signTx outcome the popup surfaces: the signed public tx, or a failure. */
export type SignTxOutcome =
  | { readonly ok: true; readonly signed: WireCommand }
  | { readonly ok: false; readonly reason: string };

/** The minimal `chrome.runtime` surface this client uses — injectable in tests. */
interface ChromeRuntime {
  readonly runtime?: {
    readonly id?: string;
    sendMessage?(message: unknown): Promise<unknown>;
  };
}
