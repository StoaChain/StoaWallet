/**
 * Barrel for the same-chain send building blocks: the pure transfer-code/cap
 * builder, the gas-payer signer resolution, and the FULL gasless orchestration.
 *
 * Browser-safe: this re-exports only the SDK-backed flow (no `node:fs`/
 * `node:path`). The orchestration's live client boundary is reached lazily
 * through the SDK's `createClient`, never a node-only import.
 */
export {
  buildTransferCode,
  formatStoaAmount,
  type BuildTransferCodeInput,
  type BuildTransferCodeResult,
} from './buildTransferCode';

export { signerSetForSameChain } from './gasPayerSigner';

export {
  sendSameChain,
  type SameChainSendParams,
  type SameChainSendResult,
  type SameChainDeps,
  type BuiltTx,
  type SimulateResult,
  type BuildTxSpec,
} from './sendSameChain';

export {
  awaitSendConfirmation,
  type ConfirmSendDeps,
  type ConfirmSendResult,
  type ListenOutcome,
} from './confirmSend';
