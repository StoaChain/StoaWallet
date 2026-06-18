/**
 * Post-submit confirmation for a same-chain send.
 *
 * `sendSameChain` returns the instant the tx is SUBMITTED (it carries a request
 * key, not an on-chain outcome). This orchestrator closes that gap: it LISTENS
 * for the mined result so the UI can report a real terminal state — confirmed on
 * chain, failed on chain (with the scrubbed on-chain reason), or a timeout (the
 * submit landed but confirmation has not been observed yet; the user checks the
 * explorer — NEVER a re-send).
 *
 * Like the cross-chain orchestrators this is transport-agnostic behind an
 * injectable seam (`ConfirmSendDeps`) so it unit-tests fully offline; the live
 * default (`confirmSend.live.ts`) wraps the failover-aware `listenForCompletion`.
 */

/** A normalized listen outcome: the mined status + (on failure) a reason string. */
export interface ListenOutcome {
  readonly status: 'success' | 'failure';
  /** Present only on `failure` — the on-chain error message (already non-secret). */
  readonly detail?: string;
  /** The block height the tx was mined in, when the listen result exposes it. */
  readonly blockHeight?: number;
}

/** Injectable confirmation seam (the live default wraps `listenForCompletion`). */
export interface ConfirmSendDeps {
  /**
   * Block until the request key's tx is mined on `chainId`, resolving the
   * normalized outcome. MAY throw on a transport timeout / network loss — the
   * orchestrator maps that to the `timeout` result (submit landed, unconfirmed),
   * never a hard failure.
   */
  listen: (requestKey: string, chainId: string) => Promise<ListenOutcome>;
}

/**
 * The confirmation result. `confirmed` / `failed` are DEFINITIVE on-chain
 * outcomes; `timeout` is the ambiguous "submitted, not yet observed" state (the
 * tx may still confirm — the caller shows the explorer, never a re-send);
 * `listen-failed` is a non-timeout transport error.
 */
export type ConfirmSendResult =
  | { readonly ok: true; readonly status: 'confirmed'; readonly blockHeight?: number }
  | { readonly ok: true; readonly status: 'failed'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'timeout' | 'listen-failed' };

/** A network/timeout-class message → treat as `timeout` (submit may be on chain). */
const TRANSIENT_RE =
  /\b(fetch|network|socket|econn|timed out|timeout|aborted)\b/i;

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}

function isTransient(err: unknown): boolean {
  if ((err as { code?: unknown } | null)?.code === 'TIMEOUT') return true;
  return TRANSIENT_RE.test(errorMessage(err));
}

/**
 * Resolve the live (node-backed) deps lazily so the barrel-reachable orchestrator
 * never statically imports the SDK transport.
 */
async function defaultDeps(): Promise<ConfirmSendDeps> {
  const { makeLiveConfirmSendDeps } = await import('./confirmSend.live');
  return makeLiveConfirmSendDeps();
}

/**
 * Await the on-chain outcome of a submitted same-chain send. Never throws across
 * the boundary — a transport timeout / network loss maps to `timeout` (the tx
 * may be on chain; the caller must NOT resubmit), any other thrown error maps to
 * `listen-failed`. A mined `failure` carries the on-chain reason for display.
 */
export async function awaitSendConfirmation(
  requestKey: string,
  chainId: string,
  deps?: ConfirmSendDeps,
): Promise<ConfirmSendResult> {
  const d = deps ?? (await defaultDeps());

  let outcome: ListenOutcome;
  try {
    outcome = await d.listen(requestKey, chainId);
  } catch (err) {
    return { ok: false, reason: isTransient(err) ? 'timeout' : 'listen-failed' };
  }

  if (outcome.status === 'success') {
    return { ok: true, status: 'confirmed', blockHeight: outcome.blockHeight };
  }
  return { ok: true, status: 'failed', detail: outcome.detail ?? 'On-chain failure' };
}
