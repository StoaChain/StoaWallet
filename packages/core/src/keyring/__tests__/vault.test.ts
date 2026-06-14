import { describe, expect, it } from 'vitest';

import {
  CorruptVaultError,
  deserializeVault,
  serializeVault,
} from '../vault';
import type { EncryptedBlob, StoredWallet, Vault } from '../vault';

/**
 * `vault.ts` is PURE: types + (de)serialization only, no crypto and no storage
 * I/O. These tests pin the three load-bearing guarantees: a multi-account
 * wallet round-trips losslessly, malformed input is rejected with a DISTINCT
 * typed error (so the manager can tell "corrupt vault" apart from "wrong
 * password"), and a plaintext string cannot be assigned to `encryptedPhrase`
 * (compile-time proof no plaintext seed is ever persisted).
 */

/** A blob is opaque to this layer; tests fabricate one via the brand cast. */
function blob(s: string): EncryptedBlob {
  return s as unknown as EncryptedBlob;
}

function twoAccountWallet(): StoredWallet {
  return {
    id: 'wallet-1',
    name: 'Prime',
    encryptedPhrase: blob('ENC::seed-phrase-envelope'),
    accounts: [
      {
        index: 0,
        publicKey: 'a'.repeat(64),
        account: `k:${'a'.repeat(64)}`,
        derivationPath: "m'/44'/626'/0'",
      },
      {
        index: 1,
        publicKey: 'b'.repeat(64),
        account: `k:${'b'.repeat(64)}`,
        derivationPath: "m'/44'/626'/1'",
      },
    ],
    activeAccountIndex: 1,
    seedType: 'koala',
    createdAt: '2026-06-14T00:00:00.000Z',
  };
}

describe('serializeVault / deserializeVault', () => {
  it('round-trips a two-account wallet losslessly so no derived account is dropped on reload', () => {
    const vault: Vault = {
      wallets: [twoAccountWallet()],
      activeWalletId: 'wallet-1',
    };

    const restored = deserializeVault(serializeVault(vault));

    // Deep equality proves every account (index, publicKey, k: address,
    // derivation path) and the active pointers survive the round-trip.
    expect(restored).toEqual(vault);
    expect(restored.wallets[0].accounts).toHaveLength(2);
    expect(restored.wallets[0].accounts[1].account).toBe(`k:${'b'.repeat(64)}`);
  });

  it('preserves wallet ORDER and the active-wallet pointer across a multi-wallet round-trip (append-by-default is non-destructive)', () => {
    const second: StoredWallet = { ...twoAccountWallet(), id: 'wallet-2', name: 'Second' };
    const vault: Vault = {
      wallets: [twoAccountWallet(), second],
      activeWalletId: 'wallet-2',
    };

    const restored = deserializeVault(serializeVault(vault));

    expect(restored.wallets.map((w) => w.id)).toEqual(['wallet-1', 'wallet-2']);
    expect(restored.activeWalletId).toBe('wallet-2');
  });

  it('rejects malformed JSON with CorruptVaultError, NOT a raw SyntaxError, so the manager surfaces "corrupt vault" distinctly from "wrong password"', () => {
    expect(() => deserializeVault('{ not json')).toThrow(CorruptVaultError);
    // A bare JSON.parse would throw SyntaxError here; the distinct type is the contract.
    expect(() => deserializeVault('{ not json')).not.toThrow(SyntaxError);
  });

  it('rejects structurally-valid JSON that is not a vault shape (e.g. missing wallets array) with CorruptVaultError', () => {
    // Parses fine as JSON but is not a Vault — must still be the distinct error,
    // never an undefined-deref later when the manager reads `.wallets`.
    expect(() => deserializeVault('{"activeWalletId":"x"}')).toThrow(
      CorruptVaultError,
    );
    expect(() => deserializeVault('[]')).toThrow(CorruptVaultError);
  });

  it('type-asserts that a plaintext string is NOT assignable to encryptedPhrase (compile-time guarantee no plaintext seed persists)', () => {
    const wallet = twoAccountWallet();
    // @ts-expect-error plaintext is not an EncryptedBlob — the brand blocks it.
    wallet.encryptedPhrase = 'raw-seed-phrase';
    // Runtime touch keeps the assignment from being tree-shaken away.
    expect(typeof wallet.encryptedPhrase).toBe('string');
  });

  it('type-asserts that StoredWallet has NO secretKey/privateKey field (structurally absent — no plaintext key path exists)', () => {
    const wallet = twoAccountWallet();
    // @ts-expect-error secretKey is structurally absent from StoredWallet.
    wallet.secretKey = 'x';
    // @ts-expect-error privateKey is structurally absent from StoredWallet's accounts.
    wallet.accounts[0].privateKey = 'x';
    expect(wallet.accounts[0].publicKey).toBe('a'.repeat(64));
  });
});
