/**
 * The PRODUCTION approval gateway (T9.6 / T9.7) — the seam the dApp router opens
 * to ask the user to approve a connect or a sign.
 *
 * In production this opens a `chrome.windows.create` popup at the framing-safe
 * `approval.html` surface, carrying the pending request on the URL (the exact
 * params {@link parseApprovalParams} decodes), and resolves when the user's
 * `approval-decision` arrives over `chrome.runtime` — or, if the user dismisses
 * the window first, on `chrome.windows.onRemoved` (a dismiss = reject, RR#13).
 *
 * SECURITY INVARIANTS this gateway upholds (each maps to a test):
 *   - RR#2 nonce match: only a decision whose `nonce` equals the request's nonce
 *     resolves it; a decision for any other nonce is IGNORED, so two concurrent
 *     approval windows never cross-resolve.
 *   - RR#13 dismiss = reject: a window closed before a decision resolves
 *     `{approved:false}`.
 *   - XP-3 token minted in the BACKGROUND: the single-use sign token is minted
 *     HERE (the secure side), never in the approval UI. The UI's decision carries
 *     NO token and NO accounts — those are sourced on this side.
 *   - No listener/promise leak: both the runtime and onRemoved listeners are
 *     detached and the created popup is closed on settle, exactly once
 *     (idempotent — a late duplicate decision or a window-close after settle is a
 *     no-op). The router applies its own bounded timeout on top; if the timeout
 *     wins, this gateway must still not leak.
 *   - SECRET-FREE: only PUBLIC data is placed on the URL (origin, nonce, the
 *     public `cmd` string). No key material ever crosses here.
 */
import type { ApprovalTokenRegistry } from './approvalTokens';
import type { ApprovalRequest, ApprovalResult } from '../dapp/dappRouter';

/** The minimal `chrome.windows` surface the gateway needs — injectable for tests. */
export interface ApprovalWindowsApi {
  create(opts: {
    url: string;
    type: string;
    width?: number;
    height?: number;
    focused?: boolean;
  }): Promise<{ id?: number } | undefined>;
  remove(windowId: number): Promise<void>;
  onRemoved: {
    addListener(callback: (windowId: number) => void): void;
    removeListener(callback: (windowId: number) => void): void;
  };
}

/** The minimal `chrome.runtime.onMessage` surface the gateway listens on. */
export interface ApprovalRuntimeApi {
  onMessage: {
    addListener(callback: (message: unknown) => void): void;
    removeListener(callback: (message: unknown) => void): void;
  };
}

export interface ChromeApprovalGatewayDeps {
  readonly chromeWindows: ApprovalWindowsApi;
  readonly chromeRuntime: ApprovalRuntimeApi;
  /** The SHARED single-use token registry (XP-3) the dApp signer consumes from. */
  readonly approvalTokens: ApprovalTokenRegistry;
  /** The current active public `k:` account(s) a connect approve exposes. */
  readonly getConnectAccounts: () => readonly string[];
  /** Whether the vault is locked at open time — surfaced as the `locked` param. */
  readonly isLocked: () => boolean;
  /** The resolved `approval.html` URL (chrome.runtime.getURL in production). */
  readonly approvalUrl: string;
  readonly windowWidth?: number;
  readonly windowHeight?: number;
}

const DEFAULT_WIDTH = 380;
const DEFAULT_HEIGHT = 620;

/** The approval-decision the approval window posts back over chrome.runtime. */
interface ApprovalDecisionMessage {
  readonly type: 'approval-decision';
  readonly decision: {
    readonly requestId: string;
    readonly nonce: string;
    readonly approved: boolean;
  };
}

function isApprovalDecision(message: unknown): message is ApprovalDecisionMessage {
  if (typeof message !== 'object' || message === null) return false;
  const m = message as Record<string, unknown>;
  if (m.type !== 'approval-decision') return false;
  const d = m.decision;
  if (typeof d !== 'object' || d === null) return false;
  const dec = d as Record<string, unknown>;
  return typeof dec.nonce === 'string' && typeof dec.approved === 'boolean';
}

/**
 * Build the approval-window URL with the params {@link parseApprovalParams}
 * decodes. The request's `nonce` doubles as the correlation `id` param — the
 * approval window echoes BOTH back on its decision (`requestId` + `nonce`), and
 * this gateway resolves only on the `nonce` match (RR#2). PUBLIC data only.
 */
function buildUrl(base: string, request: ApprovalRequest, locked: boolean): string {
  const params = new URLSearchParams();
  params.set('kind', request.kind);
  params.set('id', request.nonce);
  params.set('nonce', request.nonce);
  params.set('origin', request.origin);
  params.set('networkId', request.networkId);
  if (locked) params.set('locked', '1');
  if (request.kind === 'sign') {
    params.set('commandSigDatas', JSON.stringify(request.commandSigDatas));
  }
  return `${base}?${params.toString()}`;
}

export function createChromeApprovalGateway(
  deps: ChromeApprovalGatewayDeps,
): { open(request: ApprovalRequest): Promise<ApprovalResult> } {
  const {
    chromeWindows,
    chromeRuntime,
    approvalTokens,
    getConnectAccounts,
    isLocked,
    approvalUrl,
  } = deps;
  const width = deps.windowWidth ?? DEFAULT_WIDTH;
  const height = deps.windowHeight ?? DEFAULT_HEIGHT;

  async function open(request: ApprovalRequest): Promise<ApprovalResult> {
    const url = buildUrl(approvalUrl, request, isLocked());

    return new Promise<ApprovalResult>((resolve) => {
      let settled = false;
      let windowId: number | undefined;

      // Idempotent settle: detach BOTH listeners and close the popup exactly
      // once. A late duplicate decision, a window-close after settle, or the
      // router's timeout winning all collapse to this single cleanup.
      function settle(result: ApprovalResult): void {
        if (settled) return;
        settled = true;
        chromeRuntime.onMessage.removeListener(onDecision);
        chromeWindows.onRemoved.removeListener(onRemoved);
        if (windowId !== undefined) {
          void chromeWindows.remove(windowId).catch(() => {
            // An already-closed window has nothing to remove — dropping the
            // rejection is correct.
          });
        }
        resolve(result);
      }

      function onDecision(message: unknown): void {
        if (!isApprovalDecision(message)) return;
        // RR#2: only a decision carrying THIS request's nonce resolves it.
        if (message.decision.nonce !== request.nonce) return;

        if (!message.decision.approved) {
          settle({ nonce: request.nonce, approved: false });
          return;
        }
        if (request.kind === 'connect') {
          settle({
            nonce: request.nonce,
            approved: true,
            accounts: getConnectAccounts(),
          });
          return;
        }
        // XP-3: the single-use sign token is minted in the BACKGROUND here, never
        // in the approval UI.
        settle({
          nonce: request.nonce,
          approved: true,
          approvalToken: approvalTokens.mint(),
        });
      }

      function onRemoved(closedWindowId: number): void {
        // RR#13: the user dismissed the window before deciding → reject. A close
        // event for an unrelated window is ignored.
        if (windowId !== undefined && closedWindowId !== windowId) return;
        settle({ nonce: request.nonce, approved: false });
      }

      chromeRuntime.onMessage.addListener(onDecision);
      chromeWindows.onRemoved.addListener(onRemoved);

      void chromeWindows
        .create({ url, type: 'popup', width, height, focused: true })
        .then((win) => {
          windowId = win?.id;
          // If the request already settled before the create resolved (a
          // decision that raced ahead of the open completing), close the
          // now-known window so it is never orphaned.
          if (settled && windowId !== undefined) {
            void chromeWindows.remove(windowId).catch(() => {});
          }
        })
        .catch(() => {
          // The window could not be opened (e.g. a torn-down worker) — collapse
          // to a reject rather than leaving the dApp request hanging.
          settle({ nonce: request.nonce, approved: false });
        });
    });
  }

  return { open };
}
