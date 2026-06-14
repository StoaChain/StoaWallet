import { SigningError } from '@stoachain/stoa-core/errors';

import { isSigningTimeout } from './timeout';

/**
 * Bounded SPV-proof poll budget: ~30 attempts × 5s ≈ 150s, which covers the
 * ~100-120s block-finality window before the on-chain proof becomes fetchable.
 * Named so the bound is auditable, never a magic literal at the call site.
 */
const SPV_MAX_ATTEMPTS = 30;

/** Delay between SPV-proof poll attempts, in milliseconds (~30×5s budget). */
const SPV_DELAY_MS = 5000;

/** Inputs that fully identify a single Step-1 continuation attempt. */
export interface PollProofAndContinueParams {
  /** The Step-0 (`C_TransferAcross`) submit request key — the SPV subject. */
  readonly requestKey: string;
  /** Source chain id (0..9) the burn committed on. */
  readonly sourceChain: string;
  /** Target chain id (0..9) the continuation mints on. */
  readonly targetChain: string;
}

/** Optional orchestration controls: progress reporting and cancellation. */
export interface PollProofAndContinueOptions {
  /** Forwarded into the poll loop so a UI can render attempt N / max. */
  readonly onProgress?: (attempt: number, maxAttempts: number) => void;
  /**
   * Abort the (idempotent) poll on caller unmount. Reads are safe to cancel;
   * the submit leg itself is NOT abortable. An aborted signal yields a
   * cancelled/pending outcome — never a thrown error, never a resubmit.
   */
  readonly signal?: AbortSignal;
}

/** A built (unsigned) continuation transaction as the SDK Pact builder emits it. */
export interface ContinuationTx {
  readonly cmd?: string;
  readonly [k: string]: unknown;
}

/**
 * Injectable seam over the three `@stoachain/ouronet-core` cross-chain
 * primitives this orchestrator composes. Tests inject doubles to stay fully
 * off-network; the production default lazily wires the live SDK functions
 * (see `pollAndContinue.live.ts`). The orchestrator does NOT reimplement any
 * of these — it only sequences them and maps their outcomes to a result union.
 */
export interface PollAndContinueDeps {
  /** Bounded SPV-proof poll. Resolves `{proof:null}` when still unavailable. */
  pollSpvProof: (
    requestKey: string,
    sourceChain: string,
    targetChain: string,
    maxAttempts: number,
    delayMs: number,
    onProgress?: (attempt: number, maxAttempts: number) => void,
  ) => Promise<{ proof: string | null; error?: string }>;
  /** Build the UNSIGNED Step-1 continuation (public gas-station path). */
  buildContinuationTransaction: (
    pactId: string,
    proof: string,
    targetChain: string,
  ) => ContinuationTx;
  /** Submit the continuation; THROWS on failure — resolves a request descriptor. */
  submitContinuation: (
    tx: ContinuationTx,
    targetChain: string,
  ) => Promise<{ requestKey: string }>;
  /** True iff the thrown value is a SigningError carrying `code: "TIMEOUT"`. */
  isSigningTimeout: (err: unknown) => boolean;
}

/**
 * The discriminated outcome of a poll-and-continue attempt. Every non-ok
 * variant carries the original Step-0 `requestKey` so the caller can re-check
 * or surface it WITHOUT re-submitting Step 0 (which would double-spend gas).
 *
 * - `spv-timeout` — proof never arrived within the bound (or the poll itself
 *   timed out, or the caller aborted). PENDING, not failed: no continuation
 *   was submitted; re-run the poll later.
 * - `continuation-pending` — submitContinuation timed out. The continuation
 *   MAY have committed on chain. Re-check via the request key; do NOT resubmit.
 * - `continuation-failed` — submitContinuation threw a definitive (non-timeout)
 *   error. The continuation did NOT land.
 */
export type PollProofAndContinueResult =
  | { readonly ok: true; readonly continuationKey: string }
  | {
      readonly ok: false;
      readonly reason: 'spv-timeout';
      readonly requestKey: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'continuation-pending';
      readonly requestKey: string;
      readonly detail?: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'continuation-failed';
      readonly requestKey: string;
      readonly detail: string;
    };

/** Pull a usable message out of an unknown thrown value (never the secret). */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}

/**
 * Default `isSigningTimeout`: a `SigningError` with `code === "TIMEOUT"`. The
 * SDK throws this from `submitContinuation`/`pollSpvProof` when the per-tier
 * deadline fires — which is a PENDING signal, not a definitive failure. Routes
 * through the single-sourced `isSigningTimeout` taxonomy (PAT-003) bound to the
 * real `SigningError` constructor.
 */
function defaultIsSigningTimeout(err: unknown): boolean {
  return isSigningTimeout(err, SigningError as unknown as Parameters<typeof isSigningTimeout>[1]);
}

/**
 * Resolve the live (node-backed) deps lazily so the barrel-reachable
 * orchestrator never statically imports the SDK cross-chain functions.
 */
async function defaultDeps(): Promise<PollAndContinueDeps> {
  const { makeLivePollAndContinueDeps } = await import('./pollAndContinue.live');
  return makeLivePollAndContinueDeps();
}

/**
 * Poll for the SPV proof of a committed Step-0 cross-chain burn, then submit
 * the Step-1 continuation that mints on the target chain. Pure orchestration
 * over the SDK — delegates entirely to `pollSpvProof`,
 * `buildContinuationTransaction`, and `submitContinuation`.
 *
 * Money-safety contract:
 *   - No proof (null) OR a poll TIMEOUT OR an aborted signal → `spv-timeout`
 *     PENDING. Step 0 already committed; never resubmit it, never submit a
 *     continuation without a proof.
 *   - A submit TIMEOUT → `continuation-pending` (may have committed; re-check).
 *   - A definitive submit error → `continuation-failed`.
 * Never auto-retries; the caller owns retry policy.
 */
export async function pollProofAndContinue(
  params: PollProofAndContinueParams,
  deps?: PollAndContinueDeps,
  options: PollProofAndContinueOptions = {},
): Promise<PollProofAndContinueResult> {
  const { requestKey, sourceChain, targetChain } = params;
  const { onProgress, signal } = options;
  const d = deps ?? (await defaultDeps());

  // A caller that already aborted (e.g. unmounted before we started) must not
  // poll or submit — surface a cancelled PENDING that carries the request key.
  if (signal?.aborted) {
    return { ok: false, reason: 'spv-timeout', requestKey };
  }

  let pollResult: { proof: string | null; error?: string };
  try {
    pollResult = await d.pollSpvProof(
      requestKey,
      sourceChain,
      targetChain,
      SPV_MAX_ATTEMPTS,
      SPV_DELAY_MS,
      onProgress,
    );
  } catch {
    // A poll TIMEOUT (or any thrown poll error — a wedged custom node with no
    // failover, per XP-18b) is a distinct PENDING: the proof is simply not
    // available yet. NEVER submit a continuation here, NEVER resubmit Step 0.
    return { ok: false, reason: 'spv-timeout', requestKey };
  }

  // An abort that landed mid-poll: stop here as a cancelled PENDING, do not
  // proceed to build/submit on a possibly-partial poll.
  if (signal?.aborted) {
    return { ok: false, reason: 'spv-timeout', requestKey };
  }

  // Null proof = bound reached / still unavailable = PENDING carrying the key.
  if (!pollResult.proof) {
    return { ok: false, reason: 'spv-timeout', requestKey };
  }

  // Public gas-station path: NO gasPayerAccount arg → unsigned continuation.
  const contTx = d.buildContinuationTransaction(
    requestKey,
    pollResult.proof,
    targetChain,
  );

  try {
    const result = await d.submitContinuation(contTx, targetChain);
    return { ok: true, continuationKey: result.requestKey };
  } catch (err) {
    const detail = errorMessage(err);
    // A submit TIMEOUT may have committed on chain — PENDING, re-check, do NOT
    // resubmit (resubmit would double-pay gas for a possibly-confirmed tx).
    if (d.isSigningTimeout(err)) {
      return { ok: false, reason: 'continuation-pending', requestKey, detail };
    }
    // A definitive (non-timeout) error: the continuation did NOT land.
    return { ok: false, reason: 'continuation-failed', requestKey, detail };
  }
}

export { SPV_MAX_ATTEMPTS, SPV_DELAY_MS, defaultIsSigningTimeout };
