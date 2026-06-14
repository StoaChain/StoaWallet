import {
  fromKeypair,
  universalSignTransaction,
} from '@stoachain/stoa-core/signing';
import type { ICommand, IUnsignedCommand } from '@stoachain/kadena-stoic-legacy/types';
import type { EncryptedString } from '@stoachain/kadena-stoic-legacy/hd-wallet';

/**
 * Loosely-shaped keypair accepted by the signer. Mirrors what the SDK's
 * `fromKeypair` normalizes:
 *   - koala / foreign: `privateKey` (or `secretKey`) is a 64-char raw Ed25519
 *     hex key signed via nacl.
 *   - chainweaver / eckowallet: `encryptedSecretKey` + `password` signed via
 *     the @kadena/hd-wallet WASM path.
 */
export interface SignableKeypair {
  readonly publicKey?: string;
  readonly privateKey?: string;
  readonly secretKey?: string;
  readonly seedType?: string;
  readonly encryptedSecretKey?: EncryptedString;
  readonly password?: string;
}

/**
 * Sign an unsigned Pact transaction with a single keypair.
 *
 * Thin wrapper over `universalSignTransaction(tx, [fromKeypair(kp)])` — it does
 * NOT reimplement signing. The SDK routes the keypair to the correct algorithm
 * (nacl Ed25519 vs. WASM) based on its `seedType`/shape and attaches the
 * signature(s) to the transaction.
 */
export async function signTx(
  tx: IUnsignedCommand,
  keypair: SignableKeypair,
): Promise<IUnsignedCommand | ICommand> {
  return universalSignTransaction(tx, [fromKeypair(keypair)]);
}
