/**
 * The dApp-request ROUTER — the wallet's trust boundary (Phase 9).
 *
 * The background calls {@link DappRouter.handle} for every message that arrived
 * from a web page (relayed by the content script). This is the single place the
 * wallet decides whether a hostile origin may reach the signing surface, and it
 * composes the three Phase-9 building blocks into one gate:
 *
 *   - {@link DAppPermissionStore} (T9.2) — the reject-by-default allow-list.
 *   - {@link RequestRateLimiter}  (T9.4) — the per-origin spam cap.
 *   - an APPROVAL gateway (T9.7)         — the user-facing connect / sign prompt.
 *   - a background COMMAND-SIGNER        — resolves pubkeys → wallet keys and
 *                                          signs (XP-4), entirely on the secure side.
 *
 * SECURITY INVARIANTS (load-bearing — each maps to a test in
 * `__tests__/dappRouter.test.ts`):
 *
 *   - SENDER + ORIGIN TRUST (RR#1, RR#7): the message is rejected unless
 *     `sender.id === runtimeId`. The TRUSTED origin is derived from
 *     `sender.origin` (the frame that actually sent the message), NEVER from
 *     `sender.tab.url` (the top frame — a confused-deputy vector for iframes) or
 *     from any `origin` the page smuggled into its payload. A sender with no
 *     `origin` is un-grantable and rejected.
 *
 *   - REJECT-BY-DEFAULT (non-negotiable): any non-`kda_connect` request from an
 *     origin the store has NOT allowed returns `origin-not-allowed` WITHOUT
 *     signing or prompting. `kda_connect` from a fresh origin does NOT auto-allow
 *     — it routes to the connection prompt.
 *
 *   - RATE LIMIT (RR#9): before opening ANY approval window, the limiter is
 *     consulted; a blocked origin returns `rate-limited` without a prompt. The
 *     limiter state is PERSISTED under `DAPP_RATELIMIT_KEY` after each accounted
 *     request and rehydrated via {@link DappRouter.hydrate}, so an MV3 SW respawn
 *     cannot reset the budget.
 *
 *   - APPROVAL nonce (RR#2): every approval round-trip carries a unique
 *     unguessable nonce. Only the pending request whose nonce matches the gateway
 *     result is resolved; two concurrent approvals never cross-resolve.
 *
 *   - NO BAIT-AND-SWITCH (RR#1 TOCTOU): the exact immutable command payload is
 *     SNAPSHOT (deep-frozen) at intake and the SAME value is handed to BOTH the
 *     approval preview AND the signer — there is no re-read between.
 *
 *   - XP-3 single-use token: APPROVE mints a single-use token; the sign step
 *     validates-and-consumes it, so a replayed approved sign signs at most once.
 *
 *   - EVENTS (RR#11, RR#12): an active-account switch pushes `accountsChanged`
 *     (public `k:` accounts only) via the tab messenger to ONLY the matching
 *     origin's tabs; a page disconnect affects ONLY the verified sender origin.
 *
 *   - SECRET-FREE: only the signed public artifact crosses back; no key material
 *     is ever handled here, returned, or logged.
 */
import {
  DAPP_RATELIMIT_KEY,
  type StorageAdapter,
} from '@stoawallet/core';

import { DAppPermissionStore, type DAppAccount } from './permissionStore';
import { RequestRateLimiter, type RateLimiterState } from './rateLimiter';
import {
  dappFail,
  dappOk,
  stampOrigin,
  type CommandSigData,
  type DappAccount,
  type DappEvent,
  type DappRequest,
  type DappResponse,
  type QuickSignedCommand,
  type StampedRequest,
} from './protocol';

// --- external seams (injected so the router stays testable) ----------------

/**
 * What an approval round-trip needs from the user-facing prompt (T9.7). A
 * `connect` intent shows the origin requesting account access; a `sign` intent
 * shows the FROZEN command(s) to be signed. The `nonce` correlates the eventual
 * {@link ApprovalResult} back to exactly this pending request (RR#2).
 */
export type ApprovalRequest =
  | {
      readonly kind: 'connect';
      readonly nonce: string;
      readonly origin: string;
      readonly tabId?: number;
      readonly networkId: string;
    }
  | {
      readonly kind: 'sign';
      readonly nonce: string;
      readonly origin: string;
      readonly tabId?: number;
      readonly networkId: string;
      /** The FROZEN command(s) shown to the user — identical to what gets signed. */
      readonly commandSigDatas: readonly CommandSigData[];
    };

/** The outcome the user-facing prompt resolves an {@link ApprovalRequest} with. */
export interface ApprovalResult {
  /** Echoes the request nonce so the router resolves the right pending request. */
  readonly nonce: string;
  readonly approved: boolean;
  /** On an approved connect, the public accounts the user chose to expose. */
  readonly accounts?: readonly DappAccount[];
  /** On an approved sign, the single-use token (XP-3) the gateway minted. */
  readonly approvalToken?: string;
}

/**
 * The approval gateway seam. In production this opens a `chrome.windows.create`
 * popup and resolves on the user's choice OR on the window's `onRemoved` (a
 * dismiss = reject, RR#13). The router adds its OWN bounded timeout on top, so a
 * gateway that never resolves still collapses to `user-rejected`.
 */
export interface ApprovalGateway {
  open(request: ApprovalRequest): Promise<ApprovalResult>;
}

/** The signer's secret-free result: the filled commands, or a typed failure. */
export type CommandSignResult =
  | { readonly ok: true; readonly responses: readonly QuickSignedCommand[] }
  | { readonly ok: false; readonly reason: 'locked' | 'invalid-request' };

/**
 * The background-wired command signer (XP-4). Given the FROZEN
 * {@link CommandSigData}s and the consumed single-use token, it resolves each
 * requested `pubKey` to a wallet keypair and signs in the secure context,
 * returning ONLY the signed public artifact. Key material never crosses this
 * seam.
 */
export interface CommandSigner {
  sign(
    commandSigDatas: readonly CommandSigData[],
    approvalToken: string,
  ): Promise<CommandSignResult>;
}

/** The chrome.tabs.sendMessage seam for pushing events to a connected tab. */
export interface DappTabMessenger {
  sendToTab(tabId: number, message: DappEvent): void;
}

export interface DappRouterDeps {
  readonly store: DAppPermissionStore;
  readonly limiter: RequestRateLimiter;
  readonly adapter: StorageAdapter;
  readonly approvals: ApprovalGateway;
  readonly signer: CommandSigner;
  readonly messenger: DappTabMessenger;
  /** This extension's id; a message whose `sender.id` differs is foreign (RR#1). */
  readonly runtimeId: string;
  /** The wallet's active networkId, surfaced to the approval prompt + getNetwork. */
  readonly networkId: string;
  /**
   * The public accounts a connect prompt may expose by default. A STATIC fallback
   * used only when {@link accountsProvider} is absent — kept for back-compat with
   * callers (and tests) that pass a fixed set.
   */
  readonly grantedAccounts: readonly DAppAccount[];
  /**
   * A DYNAMIC seam read at request time, returning the wallet's CURRENT default
   * accounts (the active `k:` account). The router constructs BEFORE the vault is
   * unlocked, so a static `grantedAccounts` captured at construction is stale (an
   * empty set); this provider is consulted on each connect/checkStatus so the
   * REAL active account is sourced live. When omitted the router falls back to
   * `grantedAccounts`.
   */
  readonly accountsProvider?: () => readonly DAppAccount[];
  /** Bound on how long the router waits for an approval before giving up (RR#13). */
  readonly approvalTimeoutMs?: number;
}

/** A request whose secure single-use approval is being consumed by the signer. */
export interface ApprovedSignRequest {
  readonly id: string;
  readonly origin: string;
  readonly approvalToken: string;
  readonly commandSigDatas: readonly CommandSigData[];
}

export interface DappRouter {
  /** Route one page message; the trust boundary. Always resolves a wire response. */
  handle(
    request: DappRequest,
    sender: chrome.runtime.MessageSender,
  ): Promise<DappResponse>;
  /** Rehydrate the rate-limiter state from storage at boot (RR#9). */
  hydrate(): Promise<void>;
  /** Validate-and-consume an approval token, then sign (the XP-3 sign step). */
  consumeApprovedSign(request: ApprovedSignRequest): Promise<DappResponse>;
  /** Push an `accountsChanged` event to a connected origin's tabs only (RR#11). */
  notifyAccountsChanged(origin: string, accounts: readonly DappAccount[]): Promise<void>;
}

const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;

/** A cryptographically-unguessable nonce for an approval round-trip (RR#2). */
function freshNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Deep-freeze a command snapshot so the SAME immutable value reaches both the
 * approval preview and the signer (no bait-and-switch). The cmd string + sig
 * slots are copied into a frozen structure at intake.
 */
function freezeCommands(cmds: readonly CommandSigData[]): readonly CommandSigData[] {
  return Object.freeze(
    cmds.map((c) =>
      Object.freeze({
        cmd: c.cmd,
        sigs: Object.freeze(c.sigs.map((s) => Object.freeze({ pubKey: s.pubKey, sig: s.sig }))),
      }),
    ),
  );
}

export function createDappRouter(deps: DappRouterDeps): DappRouter {
  const {
    store,
    limiter,
    adapter,
    approvals,
    signer,
    messenger,
    runtimeId,
    grantedAccounts,
  } = deps;
  const approvalTimeoutMs = deps.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;

  /** The wallet's CURRENT default accounts, read live (falls back to the static set). */
  function defaultAccounts(): readonly DAppAccount[] {
    return deps.accountsProvider ? deps.accountsProvider() : grantedAccounts;
  }

  /** Tokens minted on approval and not yet consumed — single-use (XP-3). */
  const liveTokens = new Set<string>();

  async function hydrate(): Promise<void> {
    const raw = await adapter.get(DAPP_RATELIMIT_KEY);
    if (typeof raw === 'string') {
      try {
        limiter.loadState(JSON.parse(raw) as RateLimiterState);
      } catch {
        // A corrupt blob rehydrates as empty rather than crashing the worker; an
        // empty limiter merely starts every origin's budget fresh.
      }
    }
  }

  /** Account one request and persist the new state so it survives an SW respawn. */
  async function accountAndPersist(origin: string): Promise<boolean> {
    const decision = limiter.check(origin);
    await adapter.set(DAPP_RATELIMIT_KEY, JSON.stringify(limiter.getState()));
    return decision.allowed;
  }

  /**
   * Open one approval and race it against a bounded timeout. A timeout, a
   * window-close, or an explicit reject all collapse to `approved: false`. The
   * nonce on the gateway result MUST match the one we opened with (RR#2) — a
   * result for any other nonce is ignored and the request times out instead.
   */
  async function awaitApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    const rejected: ApprovalResult = { nonce: request.nonce, approved: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ApprovalResult>((resolve) => {
      timer = setTimeout(() => resolve(rejected), approvalTimeoutMs);
    });
    try {
      const result = await Promise.race([approvals.open(request), timeout]);
      // RR#2: only a result carrying OUR nonce may resolve this request.
      if (result.nonce !== request.nonce) return rejected;
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function handleConnect(
    req: StampedRequest,
    origin: string,
    tabId: number | undefined,
  ): Promise<DappResponse> {
    if (!(await accountAndPersist(origin))) {
      return dappFail(req.id, 'kda_connect', 'rate-limited');
    }

    const result = await awaitApproval({
      kind: 'connect',
      nonce: freshNonce(),
      origin,
      tabId,
      networkId: deps.networkId,
    });

    if (!result.approved) {
      return dappFail(req.id, 'kda_connect', 'user-rejected');
    }

    // The wallet's CURRENT default accounts, read live (post-unlock active set).
    const available = defaultAccounts();
    // The user may have approved a SUBSET of the available accounts; honor it.
    // Default to the full available set when the gateway returned no override.
    const approvedAddresses =
      result.accounts ?? available.map((a) => a.address);

    // Persist the APPROVED subset (not a static/global set), recovering each
    // address's public key from the available list so checkStatus + events can
    // return the same {address, publicKey} records the connect granted.
    const grantedSubset: DAppAccount[] = approvedAddresses.map((address) => {
      const match = available.find((a) => a.address === address);
      return match ?? { address, publicKey: '' };
    });
    await store.allow(origin, grantedSubset, tabId);
    return dappOk(req.id, 'kda_connect', { accounts: approvedAddresses });
  }

  async function handleSign(
    req: StampedRequest,
    origin: string,
    tabId: number | undefined,
    method: 'kda_requestSign' | 'kda_requestQuickSign',
    commandSigDatas: readonly CommandSigData[],
  ): Promise<DappResponse> {
    // Snapshot the exact payload ONCE; the same frozen value feeds both preview
    // and signer (no bait-and-switch).
    const frozen = freezeCommands(commandSigDatas);

    if (!(await accountAndPersist(origin))) {
      return dappFail(req.id, method, 'rate-limited');
    }

    const result = await awaitApproval({
      kind: 'sign',
      nonce: freshNonce(),
      origin,
      tabId,
      networkId: deps.networkId,
      commandSigDatas: frozen,
    });

    if (!result.approved || result.approvalToken === undefined) {
      return dappFail(req.id, method, 'user-rejected');
    }

    // Mint the single-use token (XP-3) and immediately route through the
    // consume-and-sign path so the same frozen commands are signed exactly once.
    liveTokens.add(result.approvalToken);
    const signed = await consumeApprovedSign({
      id: req.id,
      origin,
      approvalToken: result.approvalToken,
      commandSigDatas: frozen,
    });
    if (signed.status === 'fail' && method === 'kda_requestSign') {
      return { ...signed, method };
    }
    if (signed.status === 'success' && method === 'kda_requestSign' && 'responses' in signed) {
      // Legacy single-sign returns the one signed command.
      const first = signed.responses[0];
      return dappOk(req.id, 'kda_requestSign', { signedCmd: first.commandSigData });
    }
    return signed;
  }

  async function consumeApprovedSign(request: ApprovedSignRequest): Promise<DappResponse> {
    // XP-3: validate-and-consume. A token absent from the live set was never
    // minted or was already spent — a replay. Reject WITHOUT signing.
    if (!liveTokens.has(request.approvalToken)) {
      return dappFail(request.id, 'kda_requestQuickSign', 'user-rejected');
    }
    liveTokens.delete(request.approvalToken);

    const result = await signer.sign(request.commandSigDatas, request.approvalToken);
    if (!result.ok) {
      const reason = result.reason === 'locked' ? 'locked' : 'invalid-request';
      return dappFail(request.id, 'kda_requestQuickSign', reason);
    }
    return dappOk(request.id, 'kda_requestQuickSign', { responses: result.responses });
  }

  async function handleDisconnect(
    req: StampedRequest,
    origin: string,
  ): Promise<DappResponse> {
    // RR#12: the page payload cannot name another origin — only the verified
    // sender origin is affected. Emit the event to that origin's tabs first
    // (while we still know them), then revoke.
    const tabIds = await store.tabIdsForOrigin(origin);
    for (const tabId of tabIds) {
      messenger.sendToTab(tabId, { event: 'disconnect' });
    }
    await store.disconnect(origin);
    return dappOk(req.id, 'kda_disconnect', {});
  }

  async function handle(
    request: DappRequest,
    sender: chrome.runtime.MessageSender,
  ): Promise<DappResponse> {
    // RR#1: foreign extension id.
    if (sender.id !== runtimeId) {
      return dappFail(request.id, request.method, 'invalid-request');
    }
    // RR#7: the trusted origin is the SENDING FRAME's origin, never the top
    // frame (sender.tab.url) and never the page's payload claim. No origin =
    // un-grantable.
    const origin = sender.origin;
    if (origin == null || origin === '') {
      return dappFail(request.id, request.method, 'invalid-request');
    }
    const tabId = sender.tab?.id;
    const req = stampOrigin(request, origin);

    switch (req.method) {
      case 'kda_getNetwork':
        return dappOk(req.id, 'kda_getNetwork', { networkId: deps.networkId });

      case 'kda_checkStatus': {
        const connected = await store.isAllowed(origin);
        // Return the APPROVED subset persisted for THIS origin (not a static or
        // global set) so a page reads back exactly what it was granted.
        const stored = connected ? await store.accountsForOrigin(origin) : [];
        return dappOk(req.id, 'kda_checkStatus', {
          accounts: connected ? stored.map((a) => a.address) : undefined,
        });
      }

      case 'kda_connect':
        // A fresh origin does NOT auto-allow — it routes to the connect prompt.
        return handleConnect(req, origin, tabId);

      case 'kda_disconnect': {
        if (!(await store.isAllowed(origin))) {
          return dappFail(req.id, 'kda_disconnect', 'origin-not-allowed');
        }
        return handleDisconnect(req, origin);
      }

      case 'kda_requestQuickSign': {
        if (!(await store.isAllowed(origin))) {
          return dappFail(req.id, 'kda_requestQuickSign', 'origin-not-allowed');
        }
        return handleSign(
          req,
          origin,
          tabId,
          'kda_requestQuickSign',
          req.data.commandSigDatas,
        );
      }

      case 'kda_requestSign': {
        if (!(await store.isAllowed(origin))) {
          return dappFail(req.id, 'kda_requestSign', 'origin-not-allowed');
        }
        const { signingCmd } = req.data;
        const cmds: CommandSigData[] = [
          { cmd: signingCmd.cmd, sigs: signingCmd.sigs ?? [] },
        ];
        return handleSign(req, origin, tabId, 'kda_requestSign', cmds);
      }

      default: {
        const _exhaustive: never = req;
        void _exhaustive;
        return dappFail((request as { id: string }).id, 'kda_connect', 'invalid-request');
      }
    }
  }

  async function notifyAccountsChanged(
    origin: string,
    accounts: readonly DappAccount[],
  ): Promise<void> {
    // H2 defense-in-depth: enforce the "public `k:` accounts only" contract AT
    // THE BOUNDARY — a non-`k:` (e.g. a `w:`/`c:` multisig guard) or empty entry
    // is filtered out before it can reach a page, not merely documented.
    const publicAccounts = accounts.filter((a) => a.startsWith('k:'));
    // RR#11: route to ONLY this origin's connected tabs — never a broadcast.
    const tabIds = await store.tabIdsForOrigin(origin);
    for (const tabId of tabIds) {
      messenger.sendToTab(tabId, { event: 'accountsChanged', accounts: publicAccounts });
    }
  }

  return { handle, hydrate, consumeApprovedSign, notifyAccountsChanged };
}
