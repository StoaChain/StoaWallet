import { describe, expect, it } from 'vitest';

import {
  findPureKeypairByPubkey,
  transitionAdvancedAccount,
} from '../model';
import type { AdvancedAccount } from '../model';
import {
  advancedAccountsOf,
  deserializeVault,
  pureKeypairsOf,
  serializeVault,
} from '../../keyring/vault';
import type { EncryptedBlob, IPureKeypair, StoredWallet, Vault } from '../../keyring/vault';

/**
 * `advanced/model.ts` is PURE: domain types + (de)serialization-compatible
 * helpers, no crypto and no I/O. These tests pin the load-bearing guarantees:
 * advanced accounts (watch-only vs send-capable) and a pure keypair survive the
 * vault round-trip with their mode + guardSummary intact; a legacy Phase-2 blob
 * (no advanced fields) still deserializes with empty advanced collections; the
 * watch-only -> send-capable transition is immutable; and no plaintext private
 * key field is representable on an AdvancedAccount.
 */

function blob(s: string): EncryptedBlob {
  return s as unknown as EncryptedBlob;
}

function legacyWallet(): StoredWallet {
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
    ],
    activeAccountIndex: 0,
    seedType: 'koala',
    createdAt: '2026-06-14T00:00:00.000Z',
  };
}

function watchOnlyAccount(): AdvancedAccount {
  return {
    id: 'adv-watch',
    address: 'w:multisig-address',
    type: 'custom-account',
    mode: 'watch-only',
    guardSummary: {
      pred: 'keys-any',
      threshold: 2,
      neededMore: 2,
      predicateRecognized: true,
      keys: ['c'.repeat(64), 'd'.repeat(64)],
    },
    label: 'Cold multisig',
    createdAt: '2026-06-14T00:00:00.000Z',
  };
}

function sendCapableAccount(): AdvancedAccount {
  return {
    id: 'adv-send',
    address: `k:${'c'.repeat(64)}`,
    type: 'k-account',
    mode: 'send-capable',
    guardSummary: {
      pred: 'keys-all',
      threshold: 1,
      neededMore: 0,
      predicateRecognized: true,
      keys: ['c'.repeat(64)],
    },
    createdAt: '2026-06-14T00:00:00.000Z',
  };
}

function pureKeypair(): IPureKeypair {
  return {
    id: 'pure-1',
    label: 'Pasted key',
    publicKey: 'c'.repeat(64),
    encryptedPrivateKey: 'ENC::pure-secret-envelope',
    createdAt: '2026-06-14T00:00:00.000Z',
  };
}

describe('advanced vault serialization (backward-compatible extension)', () => {
  it('round-trips a vault carrying watch-only + send-capable advanced accounts and a pure keypair, preserving mode and guardSummary', () => {
    const vault: Vault = {
      wallets: [legacyWallet()],
      activeWalletId: 'wallet-1',
      pureKeypairs: [pureKeypair()],
      advancedAccounts: [watchOnlyAccount(), sendCapableAccount()],
    };

    const restored = deserializeVault(serializeVault(vault));

    // Deep equality proves the new collections survive the round-trip in full.
    expect(restored).toEqual(vault);
    // Mode is the load-bearing capability flag: it must not be lost or coerced.
    expect(restored.advancedAccounts?.[0].mode).toBe('watch-only');
    expect(restored.advancedAccounts?.[1].mode).toBe('send-capable');
    // guardSummary drives the "needs more keys" UI; its fields must survive.
    expect(restored.advancedAccounts?.[0].guardSummary?.neededMore).toBe(2);
    expect(restored.advancedAccounts?.[0].guardSummary?.predicateRecognized).toBe(true);
    // The pure keypair's secret is carried ONLY as the encrypted field.
    expect(restored.pureKeypairs?.[0].encryptedPrivateKey).toBe('ENC::pure-secret-envelope');
  });

  it('deserializes a LEGACY Phase-2 blob (no advanced fields) with no throw, and the accessors yield empty advanced collections', () => {
    // A blob serialized before the advanced fields existed — exactly the
    // Phase-2 shape. It must still parse (no throw). Round-trip stays LOSSLESS
    // (no injected keys), and the consumer-facing accessors default the absent
    // collections to empty arrays so downstream code iterates without null checks.
    const legacyBlob = JSON.stringify({
      wallets: [legacyWallet()],
      activeWalletId: 'wallet-1',
    });

    const restored = deserializeVault(legacyBlob);

    expect(restored.wallets).toHaveLength(1);
    expect(pureKeypairsOf(restored)).toEqual([]);
    expect(advancedAccountsOf(restored)).toEqual([]);
  });

  it('rejects an extended vault whose advancedAccounts entry is malformed (missing mode) with the same distinct CorruptVaultError', () => {
    // Backward-compat must NOT weaken validation: a vault claiming an advanced
    // account but omitting the load-bearing `mode` is corrupt, not silently
    // accepted.
    const bad = JSON.stringify({
      wallets: [legacyWallet()],
      activeWalletId: 'wallet-1',
      advancedAccounts: [{ id: 'x', address: 'a', type: 'k-account', createdAt: 'now' }],
    });

    expect(() => deserializeVault(bad)).toThrow(/corrupt|vault/i);
  });
});

describe('findPureKeypairByPubkey', () => {
  it('returns the stored pure keypair whose publicKey matches, so a guard can locate its signing key', () => {
    const vault: Vault = {
      wallets: [legacyWallet()],
      activeWalletId: 'wallet-1',
      pureKeypairs: [pureKeypair()],
    };

    const found = findPureKeypairByPubkey(vault, 'c'.repeat(64));

    expect(found?.id).toBe('pure-1');
    expect(found?.encryptedPrivateKey).toBe('ENC::pure-secret-envelope');
  });

  it('returns undefined when no stored pure keypair matches the pubkey (guard is not yet satisfiable)', () => {
    const vault: Vault = {
      wallets: [legacyWallet()],
      activeWalletId: 'wallet-1',
      pureKeypairs: [pureKeypair()],
    };

    expect(findPureKeypairByPubkey(vault, 'f'.repeat(64))).toBeUndefined();
  });

  it('returns undefined on a legacy vault with no pureKeypairs field (no throw)', () => {
    const vault = { wallets: [legacyWallet()], activeWalletId: 'wallet-1' } as Vault;

    expect(findPureKeypairByPubkey(vault, 'c'.repeat(64))).toBeUndefined();
  });
});

describe('transitionAdvancedAccount', () => {
  it('returns a NEW record with the flipped mode, leaving the input untouched (immutable flip watch-only -> send-capable)', () => {
    const before = watchOnlyAccount();

    const after = transitionAdvancedAccount(before, 'send-capable');

    // The capability flip is the whole point: the new record is send-capable.
    expect(after.mode).toBe('send-capable');
    // Immutability: the original is not mutated, and a fresh object is returned.
    expect(before.mode).toBe('watch-only');
    expect(after).not.toBe(before);
    // Everything else is carried verbatim so identity/guard context is preserved.
    expect(after.id).toBe(before.id);
    expect(after.guardSummary).toEqual(before.guardSummary);
  });

  it('flips send-capable -> watch-only as well (the transition is mode-directed, not one-way)', () => {
    const after = transitionAdvancedAccount(sendCapableAccount(), 'watch-only');

    expect(after.mode).toBe('watch-only');
  });

  it('type-asserts that AdvancedAccount has NO plaintext privateKey/secretKey field (keys live only in pureKeypairs)', () => {
    const acct = watchOnlyAccount();
    // @ts-expect-error privateKey is structurally absent from AdvancedAccount.
    acct.privateKey = 'raw-secret';
    // @ts-expect-error secretKey is structurally absent from AdvancedAccount.
    acct.secretKey = 'raw-secret';
    expect(acct.mode).toBe('watch-only');
  });
});
