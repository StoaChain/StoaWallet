/**
 * Pure, I/O-free classification of a StoaChain payment-key address.
 *
 * Thin wrapper over `classifyPaymentKey` from `@stoachain/stoa-core/guard`:
 * it does NOT reimplement prefix parsing. It reshapes the SDK's nullable
 * `PaymentKeyInfo` into a discriminated result so callers branch on a typed
 * invalid outcome rather than catching a thrown error.
 *
 * - `k:<hex>`            -> k-account, pubkey = the hex (derivable, no fetch)
 * - `w:`/`r:`/`c:`/`u:`/named -> custom-account, pubkey null (guard fetch needed)
 * - null/empty/malformed -> { ok: false, reason: 'invalid-address' }
 */
import { classifyPaymentKey } from '@stoachain/stoa-core/guard';
import type { PaymentKeyType } from '@stoachain/stoa-core/guard';

export type { PaymentKeyType };

export interface AccountClassification {
  readonly type: PaymentKeyType;
  readonly pubkey: string | null;
}

export interface InvalidAccount {
  readonly ok: false;
  readonly reason: 'invalid-address';
}

export type ClassifyAccountResult = AccountClassification | InvalidAccount;

export function classifyAccount(address: string | null): ClassifyAccountResult {
  const info = classifyPaymentKey(address);
  if (info === null) {
    return { ok: false, reason: 'invalid-address' };
  }
  return { type: info.type, pubkey: info.pubkey };
}
