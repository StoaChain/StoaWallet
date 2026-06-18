import { KadenaWalletBuilder } from '@stoachain/stoa-core/wallet';
import type { EncryptedString } from '@stoachain/kadena-stoic-legacy/hd-wallet';

/**
 * A derived StoaChain account. `account` is the on-chain `k:` address for a
 * single-key guard; `publicKey` is the 64-char Ed25519 public key; and
 * `encryptedSecretKey` is the password-bound `EncryptedString` produced by the
 * SDK — NOT a raw private key. Signing later decrypts it with the SAME wallet
 * password used here. The plaintext secret never leaves the SDK.
 */
export interface DerivedAccount {
  readonly account: string;
  readonly publicKey: string;
  readonly encryptedSecretKey: EncryptedString;
}

/** The seed derivation schemes the builder routes by (mirrors the SDK's). */
export type DeriveSeedType = 'koala' | 'chainweaver' | 'eckowallet';

/**
 * Derive a wallet account from a mnemonic, routed by `seedType`:
 *   - `koala` (default) — 24-word BIP39, SLIP-10 nacl Ed25519.
 *   - `chainweaver` / `eckowallet` — 12-word Kadena BIP32-Ed25519 (WASM).
 *
 * Thin wrapper over `KadenaWalletBuilder.createWalletPairFromMnemonic` — it does
 * NOT reimplement HD derivation. The SDK arg order is password-FIRST, seedType
 * LAST. For koala the returned `encryptedSecretKey` decrypts to a raw nacl key;
 * for chainweaver/ecko it is the WASM `EncryptedString` the signer drives with
 * the same password.
 *
 * The password binds the returned `encryptedSecretKey`: the same quadruple
 * (mnemonic, password, index, seedType) deterministically reproduces the keypair,
 * which is what lets the at-rest encrypted secret be re-derived on unlock.
 *
 * @throws {Error} if `password` is empty — deriving under a default/empty
 *   password would leave the at-rest secret effectively unprotected.
 */
export async function deriveAccount(
  mnemonic: string,
  password: string,
  index: number,
  seedType: DeriveSeedType = 'koala',
): Promise<DerivedAccount> {
  if (password.length === 0) {
    throw new Error(
      'deriveAccount requires a non-empty wallet password; refusing to derive under an empty/default password.',
    );
  }

  const { publicKey, secretKey } =
    await KadenaWalletBuilder.createWalletPairFromMnemonic(
      password,
      mnemonic,
      index,
      seedType,
    );

  return {
    account: `k:${publicKey}`,
    publicKey,
    encryptedSecretKey: secretKey,
  };
}
