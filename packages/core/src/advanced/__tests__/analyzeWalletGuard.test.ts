import { describe, expect, it } from 'vitest';

import { deriveAccount } from '../../api/derive';
import type { StoredAccount } from '../../keyring/vault';
import { analyzeWalletGuard, buildWalletPubSet } from '../analyzeWalletGuard';

/**
 * Fixed 24-word koala (BIP39) mnemonic + password. NEVER logged. Used to derive
 * a REAL StoaChain keypair so the buildWalletPubSet slot test proves the wallet's
 * derived-account public key actually lands in the Codex set.
 */
const TEST_MNEMONIC =
  'flat portion other shield engine fly original desert network riot shop own evidence august belt steel into embody bounce parrot naive cruel word gown';
const TEST_PASSWORD = 'correct horse battery staple';

/** Two arbitrary 64-char hex pubkeys for predicate-math tests (not in wallet). */
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

describe('buildWalletPubSet', () => {
  it('places a REAL derived-account public key into the set (proves slot mapping)', async () => {
    // Derive a real account, then shape it as the persisted StoredAccount record
    // the wallet stores. If buildWalletPubSet passed this in the WRONG arg slot
    // (kadenaSeeds, which expects nested `.accounts[]`), the set would be EMPTY
    // and every account would be wrongly treated as watch-only.
    const derived = await deriveAccount(TEST_MNEMONIC, TEST_PASSWORD, 0);
    const account: StoredAccount = {
      index: 0,
      publicKey: derived.publicKey,
      account: derived.account,
      derivationPath: "m'/44'/626'/0'",
    };

    const set = buildWalletPubSet([account]);

    expect(set.has(derived.publicKey)).toBe(true);
    expect(set.size).toBe(1);
  });

  it('includes pureKeypair public keys passed in the third slot', async () => {
    const derived = await deriveAccount(TEST_MNEMONIC, TEST_PASSWORD, 1);
    const account: StoredAccount = {
      index: 1,
      publicKey: derived.publicKey,
      account: derived.account,
      derivationPath: "m'/44'/626'/1'",
    };

    const set = buildWalletPubSet([account], [{ publicKey: KEY_A }]);

    expect(set.has(derived.publicKey)).toBe(true);
    expect(set.has(KEY_A)).toBe(true);
  });
});

describe('analyzeWalletGuard', () => {
  it('keys-all with both keys in wallet → satisfied, neededMore 0', () => {
    const walletPubs = new Set([KEY_A, KEY_B]);

    const result = analyzeWalletGuard(
      { keys: [KEY_A, KEY_B], pred: 'keys-all' },
      walletPubs,
    );

    expect(result.threshold).toBe(2);
    expect(result.satisfied).toBe(true);
    expect(result.neededMore).toBe(0);
    expect(result.predicateRecognized).toBe(true);
  });

  it('keys-all with only one key in wallet → not satisfied, neededMore 1', () => {
    const walletPubs = new Set([KEY_A]);

    const result = analyzeWalletGuard(
      { keys: [KEY_A, KEY_B], pred: 'keys-all' },
      walletPubs,
    );

    expect(result.threshold).toBe(2);
    expect(result.satisfied).toBe(false);
    expect(result.neededMore).toBe(1);
    expect(result.foreignKeys).toContain(KEY_B);
  });

  it('keys-any (threshold 1) with one key in wallet → satisfied', () => {
    const walletPubs = new Set([KEY_A]);

    const result = analyzeWalletGuard(
      { keys: [KEY_A, KEY_B], pred: 'keys-any' },
      walletPubs,
    );

    expect(result.threshold).toBe(1);
    expect(result.satisfied).toBe(true);
    expect(result.neededMore).toBe(0);
  });

  it('unknown predicate string → predicateRecognized false, does NOT throw', () => {
    const walletPubs = new Set([KEY_A, KEY_B]);

    const result = analyzeWalletGuard(
      { keys: [KEY_A, KEY_B], pred: 'definitely-not-a-real-predicate' },
      walletPubs,
    );

    // The SDK folds the unknown predicate into a conservative keys-all fallback
    // and exposes the bit rather than throwing; the caller must be able to warn.
    expect(result.predicateRecognized).toBe(false);
    expect(result.threshold).toBe(2);
  });

  it('a resolvedManualKeys entry completing a missing key → satisfied', () => {
    // Only KEY_A is in the wallet; KEY_B is foreign. Pasting KEY_B's private key
    // (transient, pre-persist) must let the keys-all guard become satisfiable.
    const walletPubs = new Set([KEY_A]);

    const before = analyzeWalletGuard(
      { keys: [KEY_A, KEY_B], pred: 'keys-all' },
      walletPubs,
    );
    expect(before.satisfied).toBe(false);

    const after = analyzeWalletGuard(
      { keys: [KEY_A, KEY_B], pred: 'keys-all' },
      walletPubs,
      { [KEY_B]: 'c'.repeat(64) },
    );

    expect(after.resolvedForeignKeys).toContain(KEY_B);
    expect(after.satisfied).toBe(true);
    expect(after.neededMore).toBe(0);
  });
});
