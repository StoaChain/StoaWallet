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

/**
 * Derive a wallet account from a 24-word koala (BIP39) mnemonic.
 *
 * Thin wrapper over `KadenaWalletBuilder.createWalletPairFromMnemonic` — it
 * does NOT reimplement HD derivation. The SDK arg order is password-FIRST.
 *
 * The password binds the returned `encryptedSecretKey`: the same triple
 * (mnemonic, password, index) deterministically reproduces the same keypair,
 * which is what lets the at-rest encrypted secret be re-derived on unlock.
 *
 * @throws {Error} if `password` is empty — deriving under a default/empty
 *   password would leave the at-rest secret effectively unprotected.
 */
export async function deriveAccount(
  mnemonic: string,
  password: string,
  index: number,
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
    );

  return {
    account: `k:${publicKey}`,
    publicKey,
    encryptedSecretKey: secretKey,
  };
}
