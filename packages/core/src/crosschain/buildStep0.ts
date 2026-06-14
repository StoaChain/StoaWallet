import { buildCTransferAcross } from '@stoachain/ouronet-core/interactions/crossChainFunctions';

import { formatStoaAmount } from '../send/buildTransferCode.js';

/**
 * A Kadena keyset guard. `pred` is intentionally a free string so on-chain
 * stoic-predicates (keys-1/3/4, M-of-N, percentages) survive verbatim — never
 * downgraded to one of the three standard predicates.
 */
export interface ReceiverGuard {
  keys: string[];
  pred: string;
}

/** The unsigned transaction the SDK builder returns ({ cmd, hash, sigs }). */
export interface UnsignedTx {
  cmd: string;
  hash: string;
  sigs: unknown[];
}

export type GasMode = 'gas-station' | 'xchain-gas';

export interface BuildStep0Input {
  sender: string;
  receiver: string;
  /** Decimal STRING; normalized internally via formatStoaAmount (no float drift). */
  amount: string;
  sourceChain: string;
  targetChain: string;
  senderPublicKey: string;
  /** Required on chain 0 (the Ouronet Gas Station co-signer); ignored otherwise. */
  gasStationPublicKey?: string;
}

export type BuildStep0Reason =
  | 'same-source-target'
  | 'invalid-recipient'
  | 'invalid-amount'
  | 'no-gas-station-key'
  | 'guard-unavailable';

export type BuildStep0Result =
  | {
      ok: true;
      tx: UnsignedTx;
      receiverGuard: ReceiverGuard;
      gasMode: GasMode;
      signerPubs: string[];
    }
  | { ok: false; reason: BuildStep0Reason };

/**
 * The single network read boundary, injected so the pure build logic stays
 * unit-testable offline. `getBalanceOnChain` reports account existence on the
 * TARGET chain; `fetchGuard` reads `(coin.details "<receiver>")` to recover an
 * existing account's authoritative keyset.
 */
export interface BuildStep0Deps {
  getBalanceOnChain: (
    account: string,
    chainId: string,
  ) => Promise<{ exists: boolean }>;
  fetchGuard: (
    account: string,
    chainId: string,
  ) => Promise<{ ok: true; guard: ReceiverGuard } | { ok: false }>;
}

/** k: account = "k:" prefix + exactly 64 hex chars (an ED25519 pubkey). */
const K_ACCOUNT = /^k:[0-9a-fA-F]{64}$/;

/**
 * Build step 0 of a cross-chain transfer: validate, resolve the receiver guard
 * on the target chain, then delegate the coin.C_TransferAcross build to the SDK.
 *
 * Pure except for the injected guard read. The returned `tx` is UNSIGNED — this
 * function never signs and never submits.
 *
 * Validation refuses BEFORE any build or network read, in this order:
 *   1. source ≠ target
 *   2. receiver is a valid k: account and not a self-send
 *   3. amount is a positive ≤12-decimal value
 *   4. chain 0 has a gas-station pubkey
 */
export async function buildCrossChainStep0(
  input: BuildStep0Input,
  deps: BuildStep0Deps,
): Promise<BuildStep0Result> {
  const {
    sender,
    receiver,
    amount,
    sourceChain,
    targetChain,
    senderPublicKey,
    gasStationPublicKey,
  } = input;

  if (sourceChain === targetChain) {
    return { ok: false, reason: 'same-source-target' };
  }

  // The k: prefix MUST be confirmed before stripping it; classifyPaymentKey from
  // the SDK accepts any "k:" body length, so a precise regex guards the pubkey.
  if (!K_ACCOUNT.test(receiver) || receiver === sender) {
    return { ok: false, reason: 'invalid-recipient' };
  }
  const receiverPubKey = receiver.slice(2);

  let normalizedAmount: string;
  try {
    normalizedAmount = formatStoaAmount(amount);
  } catch {
    return { ok: false, reason: 'invalid-amount' };
  }
  // formatStoaAmount accepts "0"/"0.0" as a well-formed decimal; a transfer of
  // zero is still invalid here.
  if (Number(normalizedAmount) <= 0) {
    return { ok: false, reason: 'invalid-amount' };
  }

  const isChainZero = sourceChain === '0';
  if (isChainZero && !gasStationPublicKey) {
    return { ok: false, reason: 'no-gas-station-key' };
  }

  const guardResult = await resolveReceiverGuard(
    receiver,
    receiverPubKey,
    targetChain,
    deps,
  );
  if (!guardResult.ok) {
    return guardResult;
  }
  const receiverGuard = guardResult.guard;

  const gasMode: GasMode = isChainZero ? 'gas-station' : 'xchain-gas';
  const signerPubs = isChainZero
    ? [senderPublicKey, gasStationPublicKey as string]
    : [senderPublicKey];

  const tx = buildCTransferAcross({
    sender,
    receiver,
    receiverGuard,
    amount: normalizedAmount,
    sourceChain,
    targetChain,
    senderPublicKey,
    ...(isChainZero ? { gasStationPublicKey } : {}),
  }) as UnsignedTx;

  return { ok: true, tx, receiverGuard, gasMode, signerPubs };
}

/**
 * Resolve the receiver's keyset on the target chain.
 *
 * - Absent account: we own the guard — keys-all over the receiver's own pubkey.
 * - Present + read OK: honor the fetched on-chain keyset verbatim.
 * - Present + read FAILS: REFUSE. Fabricating keys-all for an existing account
 *   would lock or misdirect its funds; a failed read is retryable, not a
 *   license to invent a guard.
 */
async function resolveReceiverGuard(
  receiver: string,
  receiverPubKey: string,
  targetChain: string,
  deps: BuildStep0Deps,
): Promise<{ ok: true; guard: ReceiverGuard } | { ok: false; reason: 'guard-unavailable' }> {
  const balance = await deps.getBalanceOnChain(receiver, targetChain);

  if (!balance.exists) {
    return { ok: true, guard: { keys: [receiverPubKey], pred: 'keys-all' } };
  }

  const fetched = await deps.fetchGuard(receiver, targetChain);
  if (fetched.ok && fetched.guard.keys?.length && fetched.guard.pred) {
    return { ok: true, guard: fetched.guard };
  }

  return { ok: false, reason: 'guard-unavailable' };
}
