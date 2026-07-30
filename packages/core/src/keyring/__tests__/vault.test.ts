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
    origin: 'seed',
    createdAt: '2026-06-14T00:00:00.000Z',
  };
}

/**
 * A vault blob EXACTLY as the build BEFORE `origin` existed wrote it: no wallet
 * carries the key at all. Spelled out literally (not derived from the fixture)
 * so it stays a faithful record of what is already on disk in installed wallets
 * even as the model grows.
 */
const PRE_ORIGIN_VAULT = {
  wallets: [
    {
      id: 'wallet-1',
      name: 'Prime',
      encryptedPhrase: 'ENC::seed-phrase-envelope',
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
    },
  ],
  activeWalletId: 'wallet-1',
};

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

/**
 * `origin` records HOW a wallet entered the vault, and advanced mode branches on
 * it (forced on for codex, merely auto-on for seed). Two failure modes matter:
 * a vault already on disk — written before the field existed — must keep opening
 * and must present as a seed wallet, and an origin the wallet does not
 * understand must never be silently taken for one it does.
 */
describe('StoredWallet.origin', () => {
  it('defaults a wallet with no origin key to "seed" so a vault written before the field existed still opens', () => {
    const restored = deserializeVault(JSON.stringify(PRE_ORIGIN_VAULT));

    expect(restored.wallets[0].origin).toBe('seed');
    // Everything else the legacy blob carried survives untouched — the default
    // is the ONLY difference, so an installed wallet loses no account.
    expect(restored).toEqual({
      ...PRE_ORIGIN_VAULT,
      wallets: [{ ...PRE_ORIGIN_VAULT.wallets[0], origin: 'seed' }],
    });
    // The upgraded shape must survive being written back and re-read: the first
    // save after the upgrade would otherwise persist a blob that no longer parses.
    expect(deserializeVault(serializeVault(restored))).toEqual(restored);
  });

  it('round-trips origin "codex" unchanged so a codex-imported wallet is never downgraded to a seed wallet on reload', () => {
    const vault: Vault = {
      wallets: [{ ...twoAccountWallet(), origin: 'codex' }],
      activeWalletId: 'wallet-1',
    };

    const restored = deserializeVault(serializeVault(vault));

    // The `'seed'` default fills an ABSENT key only. Overwriting a stored
    // `'codex'` would hand that wallet the seed capability set — advanced mode
    // togglable off — on the next popup open.
    expect(restored.wallets[0].origin).toBe('codex');
    expect(restored).toEqual(vault);
  });

  it('rejects an origin that is neither "seed" nor "codex" with CorruptVaultError rather than defaulting it', () => {
    const bogus = JSON.stringify({
      ...PRE_ORIGIN_VAULT,
      wallets: [{ ...PRE_ORIGIN_VAULT.wallets[0], origin: 'bogus' }],
    });

    // An unrecognized origin must NOT be waved through: the default applies to
    // an ABSENT key only. Accepting it would leave a value that matches neither
    // advanced-mode branch, so the corrupt-vault path (which offers recovery) is
    // the honest answer.
    expect(() => deserializeVault(bogus)).toThrow(CorruptVaultError);
  });
});
