/**
 * Native UrStoa TRANSFER core wrapper (chain 0, gasless).
 *
 * Wraps the SDK `executeNativeUrStoaTransfer`, moving native UrStoa from the
 * active `k:` account to a recipient. It chooses the on-chain verb by RESOLVING
 * the receiver's existence (never accepting it as a caller flag):
 *
 * - receiver does NOT exist -> `coin.C_UR|TransferAnew` with a `(read-keyset "ks")`
 *   built from the RECIPIENT's pubkey (`{ keys: [recipientPubkey], pred: "keys-all" }`).
 * - receiver exists          -> `coin.C_UR|Transfer` (no keyset).
 *
 * The recipient is validated FIRST via the Phase-4 path (`classifyPaymentKey` →
 * `classifyAccount`): non-empty, a valid `k:` account, a 64-char ED25519 pubkey,
 * and not a self-send. The pubkey used to build the keyset is the one the
 * classifier extracted after confirming the `k:` prefix — never a blind
 * `addr.slice(2)` (the Phase-4 RR#2 unspendable-account guard).
 *
 * SECRET HANDLING (highest priority): outcomes are a DISCRIMINATED result, never
 * a thrown secret-bearing Error. The `paymentKeypair` / its secret material and
 * the recipient pubkey are NEVER logged. The `amount` is the pre-formatted
 * 24-decimal injection-safe string from the caller and is passed through
 * unchanged (no reformat).
 *
 * RR#1 (Transfer signer model, PAT-004): the active account's `paymentKeypair`
 * signs both caps; there is NO separate gas-station signer in the pact sense, so
 * `senderGuardKeys` is `[]` and `isTransferFamily` is computed (true for the
 * k:-only self-as-sender norm where the sender pubkey === payment-key pubkey).
 * The SDK `ExecuteNativeUrStoaParams` has no `gasStationKey` field, so the
 * wrapper does not carry one.
 */
import {
  executeNativeUrStoaTransfer as sdkExecuteNativeUrStoaTransfer,
  getUrStoaGuard as sdkGetUrStoaGuard,
  checkCoinAccountExists as sdkCheckCoinAccountExists,
  type ExecuteNativeUrStoaParams,
  type UrStoaKeypair,
} from '@stoachain/ouronet-core/interactions/urStoaFunctions';
import { classifyAccount } from '../advanced/classifyAccount';

/** A k:-account pubkey is exactly 64 hex chars (ED25519), anchored. */
const ED25519_PUBKEY = /^[0-9a-fA-F]{64}$/;

/**
 * Gas-payer/sponsor refusal signature — the SAME pattern `stake.ts` classifies
 * with (Rule 7: adopt the stake pattern). A true sponsor refusal (the `DALOS`
 * module/namespace token or the `GAS_PAYER` capability token) is distinguished
 * from a generic submit failure so the modal can offer the right affordance. A
 * bare mention of "gas" must NOT over-match.
 */
const GAS_PAYER_REJECTION_RE = /\bDALOS\b|gas[\s-]?payer|GAS_PAYER/i;

/** Pull a usable message out of an unknown thrown value (never a secret). */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return '';
}

/**
 * Injectable seam over the three live SDK calls this wrapper composes. Tests
 * inject stubs to stay off-network; the production default wires the real SDK.
 */
export interface TransferUrStoaDeps {
  getUrStoaGuard: typeof sdkGetUrStoaGuard;
  checkCoinAccountExists: typeof sdkCheckCoinAccountExists;
  executeNativeUrStoaTransfer: typeof sdkExecuteNativeUrStoaTransfer;
}

const liveDeps: TransferUrStoaDeps = {
  getUrStoaGuard: sdkGetUrStoaGuard,
  checkCoinAccountExists: sdkCheckCoinAccountExists,
  executeNativeUrStoaTransfer: sdkExecuteNativeUrStoaTransfer,
};

export interface TransferUrStoaParams {
  /** The active `k:` account funding the transfer (sender === payment key). */
  senderAddress: string;
  /** The destination `k:` account. */
  receiverAddress: string;
  /** Pre-formatted 24-decimal Pact decimal string. Passed through unchanged. */
  amount: string;
  /** The payment-key (gasless fee) account — the active `k:` account. */
  paymentKeyAddress: string;
  /** The active account's keypair; signs both caps. Never logged. */
  paymentKeypair: UrStoaKeypair;
}

export type TransferUrStoaResult =
  | { ok: true; requestKey: string }
  | {
      ok: false;
      reason: 'invalid-recipient' | 'submit-failed' | 'gas-payer-rejected';
    };

/**
 * Resolve whether the receiver already exists in the coin table on chain 0.
 *
 * The guard read is authoritative when it returns a result; an inconclusive
 * guard read (null) falls back to the account-existence probe. A null/false
 * existence collapses to "does not exist" so the new-account branch creates the
 * receiver with its own keyset rather than assuming a present account.
 */
async function resolveReceiverExists(
  receiverAddress: string,
  deps: TransferUrStoaDeps,
): Promise<boolean> {
  const guard = await deps.getUrStoaGuard(receiverAddress);
  if (guard !== null) {
    return guard.exists === true;
  }
  const exists = await deps.checkCoinAccountExists(receiverAddress);
  return exists === true;
}

export async function transferUrStoa(
  params: TransferUrStoaParams,
  deps: TransferUrStoaDeps = liveDeps,
): Promise<TransferUrStoaResult> {
  const { senderAddress, receiverAddress, amount, paymentKeyAddress, paymentKeypair } = params;

  // Validate the recipient FIRST via the Phase-4 classifier: a valid k:-account
  // yields its derivable pubkey; anything else (empty, non-k:, malformed,
  // short/long key) is rejected before any tx is built.
  const classified = classifyAccount(receiverAddress);
  if (
    'ok' in classified ||
    classified.type !== 'k-account' ||
    classified.pubkey === null ||
    !ED25519_PUBKEY.test(classified.pubkey)
  ) {
    return { ok: false, reason: 'invalid-recipient' };
  }
  if (receiverAddress === senderAddress) {
    return { ok: false, reason: 'invalid-recipient' };
  }

  const recipientPubkey = classified.pubkey;

  const receiverExists = await resolveReceiverExists(receiverAddress, deps);

  const sdkParams: ExecuteNativeUrStoaParams = {
    senderAddress,
    receiverAddress,
    amount,
    paymentKeyAddress,
    paymentKeypair,
    senderGuardKeys: [],
    isTransferFamily: paymentKeypair.publicKey === classifySenderPubkey(senderAddress),
    receiverExists,
  };

  if (!receiverExists) {
    sdkParams.receiverKeyset = { keys: [recipientPubkey], pred: 'keys-all' };
  }

  try {
    const res = await deps.executeNativeUrStoaTransfer(sdkParams);
    return { ok: true, requestKey: res?.requestKey ?? '' };
  } catch (err) {
    if (GAS_PAYER_REJECTION_RE.test(errorMessage(err))) {
      return { ok: false, reason: 'gas-payer-rejected' };
    }
    return { ok: false, reason: 'submit-failed' };
  }
}

/**
 * Extract the sender's pubkey via the same Phase-4 classifier (k:-prefix
 * confirmed) so `isTransferFamily` is computed against a real pubkey, never a
 * blind slice. Returns null for a non-k: sender, which makes the family check
 * fall to false.
 */
function classifySenderPubkey(senderAddress: string): string | null {
  const c = classifyAccount(senderAddress);
  if ('ok' in c) {
    return null;
  }
  return c.pubkey;
}
