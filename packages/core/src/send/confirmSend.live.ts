/**
 * Live (node-backed) deps for {@link awaitSendConfirmation}.
 *
 * Wraps the failover-aware `listenForCompletion` (node1-primary + node2 failover
 * internally — NOT a raw `createClient.listen` that would bypass failover) and
 * normalizes its command result to a {@link ListenOutcome}. Kept OUT of the
 * package barrel so the barrel-reachable orchestrator never statically imports
 * the SDK transport. Imports no `node:` modules — browser-safe.
 *
 * `listenForCompletion` blocks until the tx is mined; a never-confirming tx would
 * hang the UI, so it is raced against a confirmation DEADLINE that rejects with a
 * TIMEOUT-coded error — the orchestrator maps that to its `timeout` result (the
 * submit landed; the user checks the explorer, never re-sends).
 */
import { listenForCompletion } from '@stoachain/ouronet-core/interactions/crossChainFunctions';

import type { ConfirmSendDeps, ListenOutcome } from './confirmSend';

/** Max wall-clock to wait for a mined result before reporting `timeout`. */
const CONFIRM_DEADLINE_MS = 90_000;

/** An Error carrying the TIMEOUT code the orchestrator treats as transient. */
class ConfirmTimeoutError extends Error {
  readonly code = 'TIMEOUT';
  constructor() {
    super('Confirmation deadline exceeded');
    this.name = 'ConfirmTimeoutError';
  }
}

/** Race a promise against the confirmation deadline. */
function withDeadline<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ConfirmTimeoutError()), CONFIRM_DEADLINE_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Pull the mined block height from the listen result's metaData, when present. */
function blockHeightOf(res: unknown): number | undefined {
  const meta = (res as { metaData?: { blockHeight?: unknown } } | null)?.metaData;
  const h = meta?.blockHeight;
  return typeof h === 'number' ? h : undefined;
}

/** Normalize the SDK `listen` command result to the orchestrator's outcome. */
function normalize(res: unknown): ListenOutcome {
  const result = (res as { result?: { status?: string; error?: { message?: string } } })
    ?.result;
  if (result?.status === 'success') {
    return { status: 'success', blockHeight: blockHeightOf(res) };
  }
  return { status: 'failure', detail: result?.error?.message ?? 'On-chain failure' };
}

/** Build the production confirmation seam over the failover-aware listen. */
export function makeLiveConfirmSendDeps(): ConfirmSendDeps {
  return {
    async listen(requestKey, chainId) {
      const res = await withDeadline(listenForCompletion(requestKey, chainId));
      return normalize(res);
    },
  };
}
