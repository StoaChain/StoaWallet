import { describe, expect, it } from 'vitest';

import { deriveAccount } from '../derive';

/**
 * Fixed 24-word koala (BIP39) mnemonic + password used across the derivation
 * tests. NEVER logged. Determinism is the whole point: the same triple
 * (mnemonic, password, index) must always reproduce the same public key, which
 * is what makes the at-rest encrypted secret re-derivable on unlock.
 */
const TEST_MNEMONIC =
  'flat portion other shield engine fly original desert network riot shop own evidence august belt steel into embody bounce parrot naive cruel word gown';
const TEST_PASSWORD = 'correct horse battery staple';

describe('deriveAccount', () => {
  it('returns a k: account whose public key matches the derived keypair', async () => {
    const account = await deriveAccount(TEST_MNEMONIC, TEST_PASSWORD, 0);

    // The on-chain account for a single-key guard is `k:<publicKey>`.
    expect(account.account).toBe(`k:${account.publicKey}`);
    // StoaChain Ed25519 public keys are 64-char lowercase hex.
    expect(account.publicKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('binds the secret key to the wallet password (EncryptedString, not raw hex)', async () => {
    const account = await deriveAccount(TEST_MNEMONIC, TEST_PASSWORD, 0);

    // The secret is the password-bound EncryptedString from the SDK — it must
    // NOT be the plaintext 64-char Ed25519 private key. A raw-hex secret here
    // would mean the at-rest key is unencrypted.
    expect(account.encryptedSecretKey).toBeTypeOf('string');
    expect(account.encryptedSecretKey).not.toMatch(/^[0-9a-f]{64}$/);
    expect(account.encryptedSecretKey.length).toBeGreaterThan(0);
  });

  it('derives distinct accounts for distinct indices from the same mnemonic', async () => {
    const a0 = await deriveAccount(TEST_MNEMONIC, TEST_PASSWORD, 0);
    const a1 = await deriveAccount(TEST_MNEMONIC, TEST_PASSWORD, 1);

    expect(a1.publicKey).not.toBe(a0.publicKey);
  });

  it('throws on an empty password — never derives under a default password', async () => {
    await expect(deriveAccount(TEST_MNEMONIC, '', 0)).rejects.toThrow(/password/i);
  });

  it('round-trip: re-derive after a simulated persist reproduces the same public key', async () => {
    // Derive, then simulate writing the account to at-rest storage as JSON.
    const original = await deriveAccount(TEST_MNEMONIC, TEST_PASSWORD, 3);
    const persisted = JSON.parse(JSON.stringify(original)) as {
      account: string;
      publicKey: string;
    };

    // "Unlock" = re-derive with the SAME mnemonic + password + index. The
    // password-bound derivation is deterministic, so the re-derived public key
    // (and therefore the k: account) must equal what we persisted at rest.
    const reDerived = await deriveAccount(TEST_MNEMONIC, TEST_PASSWORD, 3);

    expect(reDerived.publicKey).toBe(persisted.publicKey);
    expect(reDerived.account).toBe(persisted.account);
  });
});
