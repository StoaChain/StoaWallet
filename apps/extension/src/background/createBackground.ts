/**
 * The secure service-worker core, assembled from injected dependencies so it can
 * run under a real `chrome` global in production AND under a chrome double in
 * tests. The MV3 entry (`index.ts`) wires the REAL chrome runtime/idle/storage
 * into this factory; the test suite wires doubles.
 *
 * RESPONSIBILITIES (the security boundary):
 *   - SENDER VALIDATION (RR#1): every inbound message is rejected with
 *     `unauthorized` UNLESS it comes from this very extension — `sender.id` must
 *     equal `chrome.runtime.id`, and no web `origin`/`url` may be present. This
 *     runs BEFORE any manager op, so a foreign sender never reaches unlock/sign.
 *   - REQUEST ROUTING: a trusted request is dispatched to the {@link KeyringManager}
 *     via {@link routeRequest}; the reply is always secret-free wire data.
 *   - IDLE AUTO-LOCK (RR#4): uses `chrome.idle` (NOT a setTimeout, which an MV3
 *     worker cannot keep alive). On an `idle`/`locked` system state the KeyVault
 *     is locked (mnemonic + password cleared). Each serviced op RE-ARMS the idle
 *     detection window, so activity keeps the vault unlocked.
 *   - BOOT (XP-13): `configureNode(storage)` applies the persisted node preference
 *     BEFORE failover init, at real worker startup.
 *
 * The unlocked secret (decrypted mnemonic + wallet password) lives ONLY in the
 * manager's private state + the KeyVault, both inside this worker, both cleared
 * by `lock()`. It is never persisted plaintext and never crosses to the popup.
 */
import type { KeyringManager, KeyVault, StorageAdapter } from '@stoawallet/core';

import type { Request, Response } from '../messaging/protocol';
import { err } from '../messaging/protocol';
import type { DappRequest, DappResponse } from '../dapp/protocol';

import { routeRequest, type UrStoaCore } from './router';
import {
  createApprovalTokenRegistry,
  type ApprovalTokenRegistry,
} from './approvalTokens';

/** The minimal `chrome.idle` surface the auto-lock needs — injectable for tests. */
export interface IdleApi {
  setDetectionInterval(seconds: number): void;
  onStateChanged: {
    addListener(callback: (state: chrome.idle.IdleState | string) => void): void;
  };
}

export interface CreateBackgroundDeps {
  readonly manager: KeyringManager;
  readonly keyVault: KeyVault;
  /** This extension's id; an inbound message whose `sender.id` differs is foreign. */
  readonly runtimeId: string;
  /** XP-13 node boot. The entry injects core's real `configureNode`. */
  readonly configureNode: (storage: StorageAdapter) => Promise<void>;
  /** The at-rest storage handed to `configureNode` at boot. Defaults to the manager's. */
  readonly storage?: StorageAdapter;
  /** Idle threshold in seconds before auto-lock (chrome enforces a >=15 minimum). */
  readonly idleSeconds?: number;
  /** The idle API; defaults to the global `chrome.idle` when present. */
  readonly idle?: IdleApi;
  /**
   * The shared single-use approval-token registry (XP-3). When omitted, the
   * background creates its own — but the production wiring injects the SAME
   * registry the dApp command-signer consumes from, so a token minted on approve
   * is the one the dApp sign consumes.
   */
  readonly approvalTokens?: ApprovalTokenRegistry;
  /**
   * The dApp-request router (Phase 9). When wired, `kda_*` messages relayed from
   * a web page are dispatched here — it runs its OWN sender/origin trust gate
   * (RR#1/RR#7) over the raw web sender, distinct from the popup keyring path.
   */
  readonly dappRouter?: DappRouterPort;
  /**
   * SG-004 account-switch hook. Invoked AFTER a popup `setActiveAccount` succeeds,
   * with the NEW active account's PUBLIC fields. The entry wires this to push an
   * `accountsChanged` event to every connected dApp origin so a live wallet switch
   * propagates to pages (EIP-1193 parity). Never carries key material.
   */
  readonly onActiveAccountChanged?: (account: {
    readonly account: string;
    readonly publicKey: string;
  }) => void;
  /**
   * The UrStoa core executors (XP-12 background signing). When omitted the router
   * uses the real `@stoawallet/core` wrappers; tests inject off-network spies so a
   * full UrStoa op exercises the keypair-resolution + sender + idle-rearm path
   * without hitting node1.
   */
  readonly urstoaCore?: UrStoaCore;
}

/** The slice of the Phase-9 dApp router the background drives. */
export interface DappRouterPort {
  handle(
    request: DappRequest,
    sender: chrome.runtime.MessageSender,
  ): Promise<DappResponse>;
  /** Rehydrate the persisted rate-limiter state at boot (RR#9). */
  hydrate(): Promise<void>;
}

/**
 * A dApp message carries a `kda_*` `method` discriminant (the popup path is keyed
 * on `type`). This lets the background fork a relayed web-page request to the
 * dApp router — which applies the dApp trust gate — instead of the popup gate.
 */
function isDappMessage(message: unknown): message is DappRequest {
  return (
    typeof message === 'object' &&
    message !== null &&
    typeof (message as { method?: unknown }).method === 'string' &&
    (message as { method: string }).method.startsWith('kda_')
  );
}

/** The assembled worker surface the MV3 entry registers chrome listeners against. */
export interface Background {
  /**
   * Handle one inbound runtime message. Returns `true` synchronously so the MV3
   * runtime keeps the message channel open for the async `sendResponse`, per the
   * chrome.runtime.onMessage contract.
   */
  handleMessage(
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: Response | DappResponse) => void,
  ): true;
  /** One-time boot: configure the node and arm the idle auto-lock. */
  start(): Promise<void>;
  /**
   * Mint a single-use approval token (XP-3) the approval flow binds to a dApp
   * signing request; the matching `signTx` consumes it exactly once.
   */
  mintApprovalToken(): string;
}

/** chrome enforces a 15s floor on the idle detection interval. */
const DEFAULT_IDLE_SECONDS = 5 * 60;
const MIN_IDLE_SECONDS = 15;

/**
 * Trust gate (RR#1): only THIS extension's own contexts (popup / its pages) may
 * drive the keyring. A trusted sender has `sender.id === runtimeId` AND carries
 * no web `origin`/`url` (a content-script relay or a page message would). Any
 * other sender is foreign.
 */
function isTrustedSender(sender: chrome.runtime.MessageSender, runtimeId: string): boolean {
  if (sender.id !== runtimeId) return false;
  // A message from one of the extension's own pages has no web origin/url. A
  // value present here means the message hopped through a web page — reject it.
  if (sender.origin != null && !sender.origin.startsWith('chrome-extension://')) {
    return false;
  }
  if (sender.url != null && !sender.url.startsWith('chrome-extension://')) {
    return false;
  }
  return true;
}

export function createBackground(deps: CreateBackgroundDeps): Background {
  const { manager, keyVault, runtimeId, configureNode } = deps;
  const storage = deps.storage ?? extractStorage(manager);
  const idleSeconds = Math.max(MIN_IDLE_SECONDS, deps.idleSeconds ?? DEFAULT_IDLE_SECONDS);
  const approvalTokens: ApprovalTokenRegistry =
    deps.approvalTokens ?? createApprovalTokenRegistry();

  function getIdle(): IdleApi | undefined {
    if (deps.idle) return deps.idle;
    const g = globalThis as unknown as { chrome?: { idle?: IdleApi } };
    return g.chrome?.idle;
  }

  /** Re-arm the idle detection window. Called at start and on every serviced op. */
  function armIdle(): void {
    getIdle()?.setDetectionInterval(idleSeconds);
  }

  function handleMessage(
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: Response | DappResponse) => void,
  ): true {
    // A relayed web-page request (a `kda_*` method) forks to the dApp router,
    // which runs its OWN sender/origin trust gate (RR#1/RR#7) over the raw web
    // sender — distinct from the popup-only `isTrustedSender` gate below, which
    // would reject any web origin outright.
    if (deps.dappRouter !== undefined && isDappMessage(message)) {
      deps.dappRouter
        .handle(message, sender)
        .then(sendResponse)
        .catch(() => {
          // The router collapses every failure to a secret-free wire response;
          // this guard ensures even an unexpected throw crosses as plain data.
          sendResponse({
            id: (message as { id?: string }).id ?? '',
            method: message.method,
            status: 'fail',
            reason: 'invalid-request',
          });
        });
      return true;
    }

    if (!isTrustedSender(sender, runtimeId)) {
      // Reject BEFORE any dispatch — unlock/signTx are never invoked for a
      // foreign sender.
      sendResponse(err('unauthorized'));
      return true;
    }

    // A serviced op is activity: re-arm the auto-lock window so an active user
    // is never locked out mid-session.
    armIdle();

    routeRequest(manager, keyVault, message as Request, approvalTokens, deps.urstoaCore)
      .then((response) => {
        sendResponse(response);
        // SG-004: a SUCCESSFUL active-account switch fires the switch hook with
        // the new active account so the entry can push `accountsChanged` to every
        // connected dApp. Read AFTER the switch resolved, so the manager reflects
        // the new selection; a failed switch (response.ok === false) is skipped.
        if (
          (message as Request).type === 'setActiveAccount' &&
          response.ok &&
          deps.onActiveAccountChanged !== undefined
        ) {
          const active = manager.getActiveAccount();
          if (active !== null) {
            deps.onActiveAccountChanged({
              account: active.account,
              publicKey: active.publicKey,
            });
          }
        }
      })
      .catch(() => {
        // routeRequest already collapses every failure to a discriminated
        // reason; this catch is a belt-and-suspenders guard so a never-expected
        // throw still crosses as secret-free data, never an Error with a stack.
        sendResponse(err('corrupt-envelope'));
      });

    return true;
  }

  async function start(): Promise<void> {
    // XP-13: apply the persisted node preference BEFORE failover init.
    await configureNode(storage);

    // RR#9: rehydrate the dApp rate-limiter from storage so a respawn cannot
    // reset an origin's spent budget.
    if (deps.dappRouter !== undefined) {
      await deps.dappRouter.hydrate();
    }

    const idle = getIdle();
    if (idle) {
      idle.setDetectionInterval(idleSeconds);
      idle.onStateChanged.addListener((state) => {
        // `idle` (no input for the threshold) and `locked` (OS lock screen) both
        // mean the user stepped away → drop the in-memory secret. An `active`
        // transition re-arms the window instead.
        if (state === 'idle' || state === 'locked') {
          // Lock through the MANAGER, not just the KeyVault: `manager.lock()`
          // clears its private `unlocked` field (the decrypted mnemonic +
          // password) AND calls `keyVault.lock()`. Locking only the KeyVault
          // would leave that secret resident in the manager, derivable on a
          // later op — matching the explicit `lock` message path.
          void manager.lock();
        } else {
          armIdle();
        }
      });
    }
  }

  function mintApprovalToken(): string {
    return approvalTokens.mint();
  }

  return { handleMessage, start, mintApprovalToken };
}

/**
 * The manager was constructed with a StorageAdapter but does not re-expose it.
 * The entry passes `storage` explicitly; this fallback reads the private field
 * only when a caller omitted it, so `configureNode` still gets the SAME adapter.
 */
function extractStorage(manager: KeyringManager): StorageAdapter {
  const adapter = (manager as unknown as { storage?: StorageAdapter }).storage;
  if (adapter === undefined) {
    throw new Error('createBackground requires a storage adapter (none on the manager).');
  }
  return adapter;
}
