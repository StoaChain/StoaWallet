/**
 * Cross-chain sub-barrel for `@stoawallet/core`.
 *
 * Exposes the browser-safe cross-chain orchestrators and their pure building
 * blocks: the step-0 build, the FULL step-0 sign/submit/confirm orchestration,
 * the SPV poll-and-continue (step 1), and the recovery resume flow. The
 * node-only SDK transport stays behind each module's lazily-imported `.live.ts`
 * — never re-exported here — so this barrel carries no `node:fs`/`node:path` and
 * no static SDK-client import.
 */
export {
  buildCrossChainStep0,
  type BuildStep0Input,
  type BuildStep0Deps,
  type BuildStep0Result,
  type BuildStep0Reason,
  type ReceiverGuard,
  type UnsignedTx,
  type GasMode,
} from './buildStep0';

export {
  sendCrossChainStep0,
  type SendCrossChainStep0Input,
  type SendCrossChainStep0Deps,
  type SendCrossChainStep0Result,
  type SendCrossChainStep0Reason,
  type ListenResult,
} from './sendCrossChainStep0';

export {
  pollProofAndContinue,
  type PollProofAndContinueParams,
  type PollProofAndContinueOptions,
  type PollProofAndContinueResult,
  type PollAndContinueDeps,
  type ContinuationTx,
} from './pollAndContinue';

export {
  resumeCrossChain,
  type ResumeParams,
  type ResumeCrossChainResult,
  type ResumeDeps,
} from './resumeCrossChain';

export {
  isSigningTimeout,
  isRecoverableSubmitError,
  type SigningErrorClass,
} from './timeout';
