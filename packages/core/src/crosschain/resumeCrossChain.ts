/**
 * RECOVERY — resume a stalled cross-chain transfer by its source-chain request
 * key, WITHOUT ever restarting it. The source-chain burn (step 0) commits the
 * user's funds to the cross-chain escrow; if the UI dies between the burn and
 * the target-chain continuation (step 1), the funds are stranded. This pure
 * orchestrator re-derives the continuation from on-chain state and completes
 * step 1 — it NEVER rebuilds or resubmits the burn, which would double-spend.
 *
 * The flow holds NO key material: the continuation is the public gas-station
 * path (unsigned), executable by anyone. Returns a discriminated result and
 * never throws a secret-bearing Error across the boundary.
 */

import { isSigningTimeout, type SigningErrorClass } from './timeout';

export type { SigningErrorClass } from './timeout';

/** Source-chain poll shape from the SDK's `pollTransactionStatus`. */
export interface PollStatus {
  readonly status: 'pending' | 'success' | 'failure' | 'not-found';
  readonly continuation?: {
    readonly pactId: string;
    readonly step: number;
    readonly stepHasRollback: boolean;
  };
  readonly result?: unknown;
  readonly error?: string;
}

/** SPV proof shape: `proof` is null until block finality (pre-finality 400). */
export interface SpvProofResult {
  readonly proof: string | null;
  readonly error?: string;
}

/** Submit descriptor returned by the SDK's `submitContinuation`. */
export interface ContinuationDescriptor {
  readonly requestKey?: string;
}

/**
 * Injectable seam over the SDK's cross-chain functions plus the SigningError
 * constructor. Tests inject doubles to stay off-network and to pin the exact
 * call sequence; the production default lazily wires the real SDK so this
 * barrel-reachable module never statically imports node-only transport code.
 */
export interface ResumeDeps {
  pollTransactionStatus: (
    requestKey: string,
    chainId: string,
  ) => Promise<PollStatus>;
  fetchSpvProof: (
    requestKey: string,
    sourceChain: string,
    targetChain: string,
  ) => Promise<SpvProofResult>;
  buildContinuationTransaction: (
    pactId: string,
    proof: string,
    targetChain: string,
  ) => unknown;
  submitContinuation: (
    tx: unknown,
    targetChain: string,
  ) => Promise<ContinuationDescriptor>;
  SigningError: SigningErrorClass;
}

export interface ResumeParams {
  /** Request key of the SOURCE-chain burn (step 0). */
  readonly requestKey: string;
  /** Chain the burn landed on. */
  readonly sourceChain: string;
  /** Destination chain the continuation completes on. */
  readonly targetChain: string;
}

export type ResumeCrossChainResult =
  | { readonly ok: true; readonly continuationKey: string }
  | { readonly ok: false; readonly reason: 'same-source-target' }
  | { readonly ok: false; readonly reason: 'step0-pending' }
  | { readonly ok: false; readonly reason: 'step0-not-found' }
  | {
      readonly ok: false;
      readonly reason: 'step0-failed';
      readonly requestKey: string;
      readonly detail: string;
    }
  | { readonly ok: false; readonly reason: 'no-continuation' }
  | { readonly ok: false; readonly reason: 'spv-unavailable' }
  | {
      readonly ok: false;
      readonly reason: 'already-completed';
      readonly requestKey: string;
      readonly continuationKey?: string;
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

/** Pull a usable message out of an unknown thrown value (no secrets present). */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}

/**
 * Resolve the live SDK-backed deps lazily so the barrel-reachable orchestrator
 * never statically imports the SDK's node-only transport (`crossChainFunctions`)
 * or the error module — keeping this module browser-safe.
 */
async function defaultDeps(): Promise<ResumeDeps> {
  const cc = await import(
    '@stoachain/ouronet-core/interactions/crossChainFunctions'
  );
  const { SigningError } = await import('@stoachain/stoa-core/errors');
  return {
    pollTransactionStatus: cc.pollTransactionStatus,
    fetchSpvProof: cc.fetchSpvProof,
    buildContinuationTransaction: cc.buildContinuationTransaction,
    submitContinuation: cc.submitContinuation,
    SigningError: SigningError as unknown as SigningErrorClass,
  };
}

/**
 * Resume the cross-chain transfer identified by `requestKey`. RESUME, NEVER
 * RESTART: we proceed to the continuation ONLY when the burn is `success` AND
 * still carries a step-0 continuation that has NOT yet advanced. Every other
 * poll outcome maps to a discriminated reason without any submit. A null SPV
 * proof is a retryable PENDING (the burn is safe), not a failure. A continuation
 * submit timeout (SigningError code TIMEOUT) is PENDING — re-check, never
 * resubmit, because a double submit would double-execute step 1.
 */
export async function resumeCrossChain(
  params: ResumeParams,
  deps?: ResumeDeps,
): Promise<ResumeCrossChainResult> {
  const { requestKey, sourceChain, targetChain } = params;

  // A same-chain "cross-chain" resume is nonsensical — refuse before any network
  // read, mirroring `buildCrossChainStep0`'s leading guard (F-005). The burn and
  // mint must land on DIFFERENT chains; an equal pair could never have produced a
  // real step-0 cross-chain transfer.
  if (sourceChain === targetChain) {
    return { ok: false, reason: 'same-source-target' };
  }

  const d = deps ?? (await defaultDeps());

  const poll = await d.pollTransactionStatus(requestKey, sourceChain);

  if (poll.status === 'pending') return { ok: false, reason: 'step0-pending' };
  if (poll.status === 'not-found') return { ok: false, reason: 'step0-not-found' };
  if (poll.status === 'failure') {
    return {
      ok: false,
      reason: 'step0-failed',
      requestKey,
      detail: poll.error ?? 'Step 0 failed',
    };
  }

  // status === 'success'
  const continuation = poll.continuation;
  if (!continuation) return { ok: false, reason: 'no-continuation' };

  // NOTE: there is NO reliable PRE-submit `already-completed` signal. The source-
  // chain poll only ever reports the BURN's step-0 continuation (the SDK's
  // `getContinuationStatus` is itself just a source-chain `pollTransactionStatus`
  // wrapper); the mint/continuation lands on the TARGET chain under a SEPARATE
  // key and never advances this source-chain `step` past 0. So `already-completed`
  // is detected HONESTLY from the submit REJECTION below (a defpact-already-
  // executed signature) rather than from an unreachable step>=1 pre-check.

  const spv = await d.fetchSpvProof(requestKey, sourceChain, targetChain);
  if (spv.proof === null) {
    // Pre-finality: proof not yet available. Retryable pending, NOT a failure.
    return { ok: false, reason: 'spv-unavailable' };
  }

  const contTx = d.buildContinuationTransaction(
    continuation.pactId,
    spv.proof,
    targetChain,
  );

  try {
    const result = await d.submitContinuation(contTx, targetChain);
    return { ok: true, continuationKey: result.requestKey ?? '' };
  } catch (err) {
    const detail = errorMessage(err);
    if (isSigningTimeout(err, d.SigningError)) {
      // Timeout: the continuation may already be confirming. Re-check later;
      // a resubmit would double-execute step 1.
      return { ok: false, reason: 'continuation-pending', requestKey, detail };
    }
    // ALREADY-COMPLETED (the honest detection, F-001): the continuation/defpact
    // step already executed on the target chain — the node rejects the resubmit
    // with a "pact already completed / step already executed" signature. This is
    // NOT a hard failure: the transfer landed. Map to `already-completed` so the
    // UI surfaces success-without-resubmit, never a misleading `continuation-failed`.
    if (isAlreadyCompletedSignature(detail)) {
      return { ok: false, reason: 'already-completed', requestKey };
    }
    return { ok: false, reason: 'continuation-failed', requestKey, detail };
  }
}

/**
 * Recognize a continuation-submit rejection whose signature indicates the defpact
 * step has ALREADY executed (the transfer already completed on the target). The
 * Pact node rejects a resubmit of a completed defpact with such a message; we map
 * it to `already-completed` (success-without-resubmit) instead of a hard
 * `continuation-failed`. Conservative on purpose — only explicit already-
 * executed / pact-completed phrasings match, so a generic error stays a failure.
 */
function isAlreadyCompletedSignature(detail: string): boolean {
  return /already (executed|completed)|pact completed|step \d+ .*already|defpact already/i.test(
    detail,
  );
}
