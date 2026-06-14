/**
 * Advanced-account domain model: PURE helpers over the advanced types defined on
 * the vault. No crypto, no I/O, no network — this module only locates a stored
 * keypair and flips an account's capability mode.
 *
 * The types themselves (`AdvancedAccount`, `IPureKeypair`, `GuardSummary`, …)
 * live in `keyring/vault.ts` because the `Vault` shape references them and the
 * serialization layer must validate them. They are re-exported here so consumers
 * of the advanced model have a single import surface.
 *
 * SECURITY INVARIANT: an `AdvancedAccount` carries NO plaintext private-key
 * field — signing material exists only as `IPureKeypair.encryptedPrivateKey` in
 * the vault-global `pureKeypairs` pool. These helpers never read, log, or return
 * a decrypted key.
 */

import type {
  AdvancedAccount,
  AdvancedAccountMode,
  IPureKeypair,
  Vault,
} from '../keyring/vault';

export type {
  AdvancedAccount,
  AdvancedAccountMode,
  AdvancedAccountType,
  GuardSummary,
  IPureKeypair,
} from '../keyring/vault';

/**
 * Locate the vault-global pure keypair whose public key matches `pubkey`, so a
 * guard can find the signing key that satisfies it. Returns `undefined` when no
 * key matches OR when the vault predates the `pureKeypairs` field (legacy blob).
 */
export function findPureKeypairByPubkey(
  vault: Vault,
  pubkey: string,
): IPureKeypair | undefined {
  return vault.pureKeypairs?.find((keypair) => keypair.publicKey === pubkey);
}

/**
 * Return a NEW advanced account with `mode` flipped, leaving the input
 * untouched. The transition is mode-directed (not one-way), so it serves both
 * watch-only -> send-capable (guard satisfied) and the reverse.
 */
export function transitionAdvancedAccount(
  account: AdvancedAccount,
  mode: AdvancedAccountMode,
): AdvancedAccount {
  return { ...account, mode };
}
