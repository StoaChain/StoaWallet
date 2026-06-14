import {
  pollSpvProof,
  buildContinuationTransaction,
  submitContinuation,
} from '@stoachain/ouronet-core/interactions/crossChainFunctions';

import {
  defaultIsSigningTimeout,
  type ContinuationTx,
  type PollAndContinueDeps,
} from './pollAndContinue';

/**
 * Live (node-backed) deps for `pollProofAndContinue`: thin adapters over the
 * `@stoachain/ouronet-core` cross-chain primitives. Constructed lazily behind
 * the orchestrator's dynamic import so the barrel-reachable orchestrator never
 * statically pulls the SDK transport in. We do NOT reimplement the primitives —
 * each dep just forwards to the SDK and narrows the `any` boundary to the
 * shapes the orchestrator consumes.
 */
export function makeLivePollAndContinueDeps(): PollAndContinueDeps {
  return {
    pollSpvProof: (requestKey, sourceChain, targetChain, maxAttempts, delayMs, onProgress) =>
      pollSpvProof(requestKey, sourceChain, targetChain, maxAttempts, delayMs, onProgress),
    buildContinuationTransaction: (pactId, proof, targetChain) =>
      buildContinuationTransaction(pactId, proof, targetChain) as ContinuationTx,
    submitContinuation: async (tx, targetChain) => {
      const descriptor = await submitContinuation(tx, targetChain);
      return { requestKey: descriptor.requestKey };
    },
    isSigningTimeout: defaultIsSigningTimeout,
  };
}
