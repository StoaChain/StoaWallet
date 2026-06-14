// Buffer polyfill MUST be the first import so it runs before any @stoachain
// crypto module touches the `Buffer` global. See packages/core/src/build/polyfills.ts.
import '@stoawallet/core/build/polyfills';

import { deriveAccount, signTx } from '@stoawallet/core';
import { Pact } from '@stoachain/kadena-stoic-legacy/client';
import { binToHex } from '@stoachain/kadena-stoic-legacy/cryptography-utils';
import { kadenaDecrypt } from '@stoachain/kadena-stoic-legacy/hd-wallet';

/**
 * Real production-path derive->sign execution probe.
 *
 * This exists to prove the PRODUCTION bundle EXECUTES a genuine
 * `deriveAccount` -> `signTx` chain with no "Buffer is not defined" and no
 * `@noble/curves` duplicate-instance failure — both of which are dev-tolerant
 * and only surface when the built bundle actually runs.
 *
 * The fixed mnemonic/password/index are NON-SECRET test vectors and are never
 * logged; only the resulting public signature is surfaced.
 */
const TEST_MNEMONIC =
  'flat portion other shield engine fly original desert network riot shop own evidence august belt steel into embody bounce parrot naive cruel word gown';
const TEST_PASSWORD = 'correct horse battery staple';
const TEST_INDEX = 0;

export interface DeriveSignHarnessResult {
  readonly signature: string | null;
  readonly error: string | null;
}

export async function runDeriveSignHarness(): Promise<DeriveSignHarnessResult> {
  try {
    // 1. Derive a koala account: the at-rest secret is a password-bound
    //    encrypted blob, exactly as it is persisted by the real wallet.
    const account = await deriveAccount(TEST_MNEMONIC, TEST_PASSWORD, TEST_INDEX);

    // 2. "Unlock" — decrypt the at-rest secret back to its raw 32-byte Ed25519
    //    key. This is the same SDK AES-GCM path the wallet runs on unlock; it
    //    pulls in the @stoachain crypto modules that reference the `Buffer`
    //    global, so it exercises the polyfill end to end.
    const rawSecret = await kadenaDecrypt(
      TEST_PASSWORD,
      account.encryptedSecretKey,
    );
    const secretBytes =
      rawSecret instanceof Uint8Array
        ? rawSecret
        : new Uint8Array(rawSecret as ArrayLike<number>);
    const privateKey = binToHex(secretBytes);

    // 3. Build a trivial unsigned transaction and sign it through the koala
    //    (nacl Ed25519) path. Signing routes through @noble/curves; a duplicate
    //    curve instance would throw here at sign time.
    const unsigned = Pact.builder
      .execution('(coin.details "k:abc")')
      .addSigner(account.publicKey)
      .setMeta({ chainId: '0', senderAccount: account.account })
      .setNetworkId('testnet04')
      .createTransaction();

    const signed = await signTx(unsigned, {
      publicKey: account.publicKey,
      privateKey,
      seedType: 'koala',
    });

    const signature = signed.sigs[0]?.sig ?? null;
    return { signature, error: null };
  } catch (err) {
    return {
      signature: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
