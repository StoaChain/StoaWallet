import {
  buildCrossChainTransfer,
  submitCrossChainTransfer,
} from '@stoachain/ouronet-core/interactions/crossChainFunctions';

import { formatStoaAmount } from '../send/buildTransferCode';
import { signTx, type SignableKeypair } from './sign';

// The FULL same-chain gasless orchestration lives in the send/ helper module
// and is re-exported here as the package's same-chain entry point. It supersedes
// the Phase-1 thin same-chain wrapper: it validates the recipient, resolves
// per-chain account existence, attaches both caps to the sender's signer, runs
// the simulate → auto-gas → re-build → sign(SET) → submit flow, and returns a
// discriminated result instead of throwing.
export {
  sendSameChain,
  type SameChainSendParams,
  type SameChainSendResult,
  type SameChainDeps,
  type BuiltTx,
  type SimulateResult,
  type BuildTxSpec,
} from '../send/sendSameChain';

// The FULL cross-chain step-0 orchestration (build → sign → submit → confirm)
// lives in the crosschain/ module and is re-exported here as the package's
// cross-chain entry point. It supersedes the Phase-1 thin `sendCrossChain`
// wrapper below: it composes the validated step-0 build with gas-mode signing,
// failover-wrapped submit, and the failover-aware completion confirm, returning
// a discriminated result instead of throwing a secret-bearing Error.
export {
  sendCrossChainStep0,
  type SendCrossChainStep0Input,
  type SendCrossChainStep0Result,
  type SendCrossChainStep0Deps,
  type SendCrossChainStep0Reason,
  type ListenResult,
} from '../crosschain/sendCrossChainStep0';

interface ReceiverGuard {
  readonly keys: string[];
  readonly pred: string;
}

export interface CrossChainParams {
  readonly sender: string;
  readonly receiver: string;
  readonly receiverGuard: ReceiverGuard;
  readonly amount: string;
  readonly sourceChain: string;
  readonly targetChain: string;
  readonly senderPublicKey: string;
}

export interface SendSigner {
  readonly keypair: SignableKeypair;
}

/**
 * Injectable build/sign/submit seam for the cross-chain step-1 flow. Tests
 * inject doubles to pin composition order; the production default delegates to
 * the SDK's cross-chain helpers.
 */
export interface SendDeps {
  buildTransfer: (params: Record<string, unknown>) => unknown;
  sign: (tx: unknown, keypair: SignableKeypair) => Promise<unknown>;
  submit: (signedTx: unknown, chainId: string) => Promise<unknown>;
}

const crossChainDefaults: SendDeps = {
  buildTransfer: (params) => buildCrossChainTransfer(params as never),
  sign: (tx, keypair) => signTx(tx as never, keypair),
  submit: (signedTx, chainId) => submitCrossChainTransfer(signedTx, chainId),
};

/**
 * Cross-chain transfer — THIN orchestration of step 1 (build -> sign -> submit
 * on the SOURCE chain), returning the source-chain request descriptor. SPV
 * proof retrieval + step-2 continuation on the target chain are a later-phase
 * flow and are deliberately NOT wired here. Does NOT reimplement continuation
 * logic.
 */
export async function sendCrossChain(
  params: CrossChainParams,
  signer: SendSigner,
  deps: SendDeps = crossChainDefaults,
): Promise<unknown> {
  const built = deps.buildTransfer({
    sender: params.sender,
    receiver: params.receiver,
    receiverGuard: params.receiverGuard,
    amount: formatStoaAmount(params.amount),
    sourceChain: params.sourceChain,
    targetChain: params.targetChain,
    senderPublicKey: params.senderPublicKey,
  });

  const signed = await deps.sign(built, signer.keypair);
  return deps.submit(signed, params.sourceChain);
}
