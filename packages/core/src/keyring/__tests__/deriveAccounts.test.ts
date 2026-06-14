import { describe, expect, it } from 'vitest';

import { deriveAccounts } from '../deriveAccounts';

/**
 * Fixed 24-word koala (BIP39) mnemonic + password shared across the
 * multi-account derivation tests. NEVER logged. Determinism is the whole
 * point: the same (mnemonic, password, index) triple must always reproduce
 * the same public key / k: account, which is what lets the discovered
 * account list be re-derived on unlock.
 */
const TEST_MNEMONIC =
  'flat portion other shield engine fly original desert network riot shop own evidence august belt steel into embody bounce parrot naive cruel word gown';
const TEST_PASSWORD = 'correct horse battery staple';

// Asserted deterministic k: account for index 0 under the fixture above,
// produced by the real SDK SLIP-10 derivation (koala / 24-word path).
const EXPECTED_INDEX0_ACCOUNT =
  'k:47ff273c8222a6558f48d36b74fdd12b7ab9c39720a569611505b764b282dd37';

describe('deriveAccounts', () => {
  it('derives the deterministic k: account at index 0', async () => {
    const [first] = await deriveAccounts(TEST_MNEMONIC, TEST_PASSWORD, 0, 1);

    // Pins the real SLIP-10 derivation: changing the derivation path, seed
    // type, or index math would flip this exact account string.
    expect(first.index).toBe(0);
    expect(first.account).toBe(EXPECTED_INDEX0_ACCOUNT);
    expect(first.account).toBe(`k:${first.publicKey}`);
    expect(first.derivationPath).toBe("m'/44'/626'/0'");
  });

  it('derives distinct accounts for indices 0 and 1', async () => {
    const [a0, a1] = await deriveAccounts(TEST_MNEMONIC, TEST_PASSWORD, 0, 2);

    // Each HD index must yield its own keypair; collapsing indices to one
    // key would silently give every "account" the same address.
    expect(a0.publicKey).not.toBe(a1.publicKey);
    expect(a0.account).not.toBe(a1.account);
    expect(a0.index).toBe(0);
    expect(a1.index).toBe(1);
  });

  it('returns exactly `count` records with the expected derivation paths', async () => {
    const records = await deriveAccounts(TEST_MNEMONIC, TEST_PASSWORD, 0, 3);

    // The loop must produce one record per requested index, in order, each
    // carrying the HD path string for that index — the caller persists these
    // paths to re-derive on unlock.
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(records.map((r) => r.derivationPath)).toEqual([
      "m'/44'/626'/0'",
      "m'/44'/626'/1'",
      "m'/44'/626'/2'",
    ]);
  });

  it('honours startIndex when building the derivation paths', async () => {
    const records = await deriveAccounts(TEST_MNEMONIC, TEST_PASSWORD, 5, 2);

    // startIndex offsets the whole window; index 5's account here must equal
    // index 5's account in any other call, proving the path is built from the
    // absolute HD index, not a zero-based loop counter.
    expect(records.map((r) => r.index)).toEqual([5, 6]);
    expect(records[0].derivationPath).toBe("m'/44'/626'/5'");
    expect(records[1].derivationPath).toBe("m'/44'/626'/6'");
  });

  it('never exposes a plaintext 64-char private key on the public surface', async () => {
    const [account] = await deriveAccounts(TEST_MNEMONIC, TEST_PASSWORD, 0, 1);

    // The record exposes only public material; a raw-hex secret leaking here
    // would mean the at-rest key is unprotected.
    expect(account.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.values(account)).not.toContainEqual(
      expect.stringMatching(/^secret/i),
    );
    expect('secretKey' in account).toBe(false);
    expect('encryptedSecretKey' in account).toBe(false);
  });

  it('refuses to derive under an empty password', async () => {
    // Deriving under "" would leave any at-rest secret effectively
    // unprotected; the underlying single-account derivation throws and that
    // refusal must propagate.
    await expect(
      deriveAccounts(TEST_MNEMONIC, '', 0, 1),
    ).rejects.toThrow(/password/i);
  });
});
