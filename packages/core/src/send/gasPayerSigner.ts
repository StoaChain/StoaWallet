import type { SignableKeypair } from '../api/sign';

/**
 * Gas-payer cap signer resolution for a k:->k' SAME-CHAIN send.
 *
 * For this phase's same-chain transfer, the sender's own wallet key signs BOTH
 * the `(ouronet-ns.DALOS.GAS_PAYER "" 0 0.0)` cap AND the `(coin.TRANSFER ...)`
 * cap — a single signer. The send composer attaches both caps to this one
 * signer entry (see the reference wallet-sender path: the same `senderPub`
 * carries both caps).
 *
 * NOTE: Multi-guard selection — `selectCapsSigningKey`
 * (`@stoachain/stoa-core/guard`) and the `buildCodexPubSet` / impossible-refuse
 * (`no-eligible-gas-payer-key`) machinery — is DEFERRED to Phase 6 (advanced
 * accounts). This phase has exactly one eligible key: the sender's own.
 */

/**
 * The `signingKeypairs[]` SET for a k:->k' same-chain send: exactly the
 * sender's keypair. One signer, no codex/gas-payer second key this phase.
 */
export function signerSetForSameChain(
  senderKeypair: SignableKeypair,
): readonly SignableKeypair[] {
  return [senderKeypair];
}
