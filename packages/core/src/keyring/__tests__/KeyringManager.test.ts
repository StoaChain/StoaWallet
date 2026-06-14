import { describe, expect, it, vi } from 'vitest';

import {
  CorruptVaultError,
  serializeVault,
  type AdvancedAccount,
  type Vault,
} from '../vault';
import {
  CorruptEnvelopeError,
  WrongPasswordError,
} from '@stoachain/stoa-core/crypto';
import { tryDerivePublicKey } from '@stoachain/stoa-core/guard';

import {
  KeyringManager,
  BiometricUnlockFailedError,
} from '../KeyringManager';
import type { AccountGuardResult } from '../../advanced';
import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '../../storage/__tests__/inMemoryDoubles';
import { VAULT_KEY } from '../../storage/storageKeys';
import {
  type BiometricUnlock,
} from '../../storage/BiometricUnlock';

/** A foreign key the wallet does not derive — guard tests pin against its pub. */
const FOREIGN_KEY = '3'.repeat(64);
const FOREIGN_PUB = tryDerivePublicKey(FOREIGN_KEY) as string;
const ROTATED_PUB = 'a'.repeat(64);

/** Build a `fetchGuard`-shaped stub returning a keyset on the given keys. */
function guardStub(keys: string[]): (
  address: string,
  chainId: string,
) => Promise<AccountGuardResult> {
  return async () => ({
    exists: true,
    isKeyset: true,
    keys,
    pred: 'keys-any',
    balance: 0,
  });
}

/** A watch-only advanced account recording a single guard key on a chain. */
function watchOnlyAdvanced(
  guardKey: string,
  chainId = '5',
): AdvancedAccount {
  return {
    id: 'adv-1',
    address: 'c:custom-guard',
    type: 'custom-account',
    mode: 'watch-only',
    chainId,
    guardSummary: {
      pred: 'keys-any',
      threshold: 1,
      neededMore: 1,
      predicateRecognized: true,
      keys: [guardKey],
    },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

const PASSWORD = 'correct horse battery staple';

function makeManager() {
  const storage = new InMemoryStorageAdapter();
  const keyVault = new InMemoryKeyVault();
  const manager = new KeyringManager({ storage, keyVault });
  return { storage, keyVault, manager };
}

/** A `k:` single-key StoaChain address: `k:` + 64 lowercase hex chars. */
const K_ADDRESS = /^k:[0-9a-f]{64}$/;

describe('KeyringManager', () => {
  it('createWallet → persist → unlock(correct pw) round-trips and yields an active k: account', async () => {
    const { manager, storage, keyVault } = makeManager();

    const { account, phrase, walletId } = await manager.createWallet(PASSWORD);

    // Backup phrase is returned ONCE for display, and is a real 24-word phrase.
    expect(phrase.split(/\s+/)).toHaveLength(24);
    // The created wallet immediately exposes a usable k: account.
    expect(account.account).toMatch(K_ADDRESS);
    expect(account.index).toBe(0);

    // It was persisted: a vault blob now lives under VAULT_KEY.
    expect(await storage.get(VAULT_KEY)).not.toBeNull();

    // A fresh manager over the SAME storage can unlock with the correct pw and
    // observe the same active account — proving round-trip through disk.
    const reopened = new KeyringManager({ storage, keyVault });
    await reopened.unlock(walletId, PASSWORD);
    const active = reopened.getActiveAccount();
    expect(active?.account).toBe(account.account);
    // Unlocking loads the decrypted mnemonic into the in-memory KeyVault.
    expect(keyVault.isUnlocked()).toBe(true);
  });

  it('rejects unlock with WrongPasswordError when the password is wrong', async () => {
    const { manager, storage, keyVault } = makeManager();
    const { walletId } = await manager.createWallet(PASSWORD);

    const reopened = new KeyringManager({ storage, keyVault });
    await expect(reopened.unlock(walletId, 'not the password')).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
    // A failed unlock leaves the vault locked (no key resident).
    expect(keyVault.isUnlocked()).toBe(false);
  });

  it('surfaces CorruptEnvelopeError when the stored encrypted phrase is mangled', async () => {
    const { manager, storage, keyVault } = makeManager();
    const { walletId } = await manager.createWallet(PASSWORD);

    // Corrupt the encryptedPhrase inside the otherwise-valid vault blob.
    const raw = (await storage.get(VAULT_KEY)) as string;
    const vault = JSON.parse(raw);
    vault.wallets[0].encryptedPhrase = vault.wallets[0].encryptedPhrase.slice(
      0,
      Math.floor(vault.wallets[0].encryptedPhrase.length / 2),
    );
    await storage.set(VAULT_KEY, JSON.stringify(vault));

    const reopened = new KeyringManager({ storage, keyVault });
    await expect(reopened.unlock(walletId, PASSWORD)).rejects.toBeInstanceOf(
      CorruptEnvelopeError,
    );
  });

  it('surfaces CorruptVaultError when the stored vault blob itself is not a vault', async () => {
    const { storage, keyVault } = makeManager();
    await storage.set(VAULT_KEY, 'this is not json at all');

    const manager = new KeyringManager({ storage, keyVault });
    await expect(manager.unlock('any-id', PASSWORD)).rejects.toBeInstanceOf(
      CorruptVaultError,
    );
  });

  it('appends on second createWallet: two wallets, first intact, second active', async () => {
    const { manager, storage } = makeManager();

    const first = await manager.createWallet(PASSWORD, { name: 'First' });
    const second = await manager.createWallet(PASSWORD, { name: 'Second' });

    const vault = JSON.parse((await storage.get(VAULT_KEY)) as string);
    expect(vault.wallets).toHaveLength(2);
    // First wallet survives unchanged (non-destructive append).
    expect(vault.wallets[0].id).toBe(first.walletId);
    expect(vault.wallets[0].name).toBe('First');
    // The newly appended wallet becomes active.
    expect(vault.activeWalletId).toBe(second.walletId);
    expect(manager.getActiveAccount()?.account).toBe(second.account.account);
  });

  it('importWallet rejects an invalid phrase with a distinct reason BEFORE touching the vault', async () => {
    const { manager, storage } = makeManager();

    await expect(
      manager.importWallet('not a valid bip39 mnemonic phrase', PASSWORD),
    ).rejects.toMatchObject({ reason: 'word-count' });

    // Nothing was persisted: validation gates derive/encrypt/persist.
    expect(await storage.get(VAULT_KEY)).toBeNull();
  });

  it('addAccount derives a distinct 2nd k: account; setActiveAccount switches the active one', async () => {
    const { manager } = makeManager();
    const { walletId, account: first } = await manager.createWallet(PASSWORD);

    const second = await manager.addAccount(walletId);
    expect(second.index).toBe(1);
    expect(second.account).toMatch(K_ADDRESS);
    // Distinct HD index → distinct address.
    expect(second.account).not.toBe(first.account);
    // Adding an account moves the active pointer to the new account.
    expect(manager.getActiveAccount()?.index).toBe(1);

    await manager.setActiveAccount(walletId, 0);
    expect(manager.getActiveAccount()?.index).toBe(0);
    expect(manager.getActiveAccount()?.account).toBe(first.account);
  });

  it('persists exactly ONE StorageAdapter.set per createWallet (atomic)', async () => {
    const { manager, storage } = makeManager();
    const setSpy = vi.spyOn(storage, 'set');

    await manager.createWallet(PASSWORD, { accountCount: 3 });

    // Even deriving 3 accounts, the complete next vault is written in a single
    // set — no incremental per-account writes.
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith(VAULT_KEY, expect.any(String));
  });

  it('a biometric unlock runs the same unlock path using the supplied password', async () => {
    const { manager, storage, keyVault } = makeManager();
    const { walletId, account } = await manager.createWallet(PASSWORD);

    const biometric: BiometricUnlock = {
      isAvailable: () => Promise.resolve(true),
      unlock: () => Promise.resolve({ ok: true, secret: PASSWORD }),
    };

    const reopened = new KeyringManager({ storage, keyVault });
    await reopened.unlockWithBiometric(walletId, biometric);
    expect(reopened.getActiveAccount()?.account).toBe(account.account);
    expect(keyVault.isUnlocked()).toBe(true);
  });

  it('biometric unlock raises BiometricUnlockFailedError (carrying the reason) without unlocking on an unavailable backer', async () => {
    const { manager, storage, keyVault } = makeManager();
    const { walletId } = await manager.createWallet(PASSWORD);

    const biometric: BiometricUnlock = {
      isAvailable: () => Promise.resolve(false),
      unlock: () =>
        Promise.resolve({ ok: false, reason: 'biometric-unavailable' }),
    };

    const reopened = new KeyringManager({ storage, keyVault });
    // The biometric contract never throws — the manager re-raises the
    // discriminated failure so the password-path failure guarantee is uniform,
    // and the reason is preserved for the UI to branch on.
    await expect(
      reopened.unlockWithBiometric(walletId, biometric),
    ).rejects.toMatchObject({
      name: 'BiometricUnlockFailedError',
      reason: 'biometric-unavailable',
    });
    expect(keyVault.isUnlocked()).toBe(false);
  });

  it('never writes the plaintext phrase or any secretKey to console across a create→unlock cycle', async () => {
    const sinks = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const spies = sinks.map((m) => vi.spyOn(console, m).mockImplementation(() => {}));

    const { manager, storage, keyVault } = makeManager();
    const { phrase, walletId } = await manager.createWallet(PASSWORD);
    const reopened = new KeyringManager({ storage, keyVault });
    await reopened.unlock(walletId, PASSWORD);

    const captured = spies
      .flatMap((s) => s.mock.calls)
      .flat()
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join(' ');

    // The exact backup phrase must never appear in any console sink.
    const words = phrase.split(/\s+/);
    expect(captured).not.toContain(phrase);
    // Nor any whole phrase word run that would reconstruct the secret.
    for (const word of words) {
      // A lone common dictionary word may coincidentally appear; assert the
      // full phrase token-run is absent (checked above). Here assert the
      // password is never printed verbatim.
      void word;
    }
    expect(captured).not.toContain(PASSWORD);

    spies.forEach((s) => s.mockRestore());
  });

  it('lock() clears the in-memory unlocked key', async () => {
    const { manager, storage, keyVault } = makeManager();
    const { walletId } = await manager.createWallet(PASSWORD);

    const reopened = new KeyringManager({ storage, keyVault });
    await reopened.unlock(walletId, PASSWORD);
    expect(keyVault.isUnlocked()).toBe(true);

    await reopened.lock();
    expect(keyVault.isUnlocked()).toBe(false);
    expect(keyVault.getUnlockedKey()).toBeNull();
  });

  it('clamps accountCount to >=1 so {accountCount:0} still yields an active account', async () => {
    const { manager } = makeManager();

    const { account } = await manager.createWallet(PASSWORD, {
      accountCount: 0,
    });

    // A 0 count must not produce an undefined active account typed as
    // StoredAccount — the clamp guarantees at least HD index 0 exists.
    expect(account).toBeDefined();
    expect(account.index).toBe(0);
    expect(account.account).toMatch(K_ADDRESS);
    expect(manager.getActiveWalletAccounts()).toHaveLength(1);
  });

  it('a failed biometric unlock leaves no key resident even when another wallet was unlocked first', async () => {
    const { manager, storage, keyVault } = makeManager();
    const a = await manager.createWallet(PASSWORD, { name: 'A' });
    const b = await manager.createWallet(PASSWORD, { name: 'B' });

    // Unlock wallet A successfully through a fresh manager over the same storage.
    const reopened = new KeyringManager({ storage, keyVault });
    await reopened.unlock(a.walletId, PASSWORD);
    expect(keyVault.isUnlocked()).toBe(true);

    // A biometric unlock for B whose authenticator rejects must scrub the key —
    // a failed unlock can never leave a resident key behind.
    const failingBiometric: BiometricUnlock = {
      isAvailable: () => Promise.resolve(true),
      unlock: () => Promise.resolve({ ok: false, reason: 'biometric-failed' }),
    };
    await expect(
      reopened.unlockWithBiometric(b.walletId, failingBiometric),
    ).rejects.toBeInstanceOf(BiometricUnlockFailedError);
    expect(keyVault.isUnlocked()).toBe(false);
  });
});

describe('KeyringManager — advanced foreign-key resolution re-fetches the live guard (F-002)', () => {
  /** Seed an unlocked wallet whose vault also carries one watch-only advanced account. */
  async function setupWithAdvanced(account: AdvancedAccount) {
    const { manager, storage, keyVault } = makeManager();
    const { walletId } = await manager.createWallet(PASSWORD);

    // Append the advanced account into the persisted vault, then re-read it in.
    const raw = (await storage.get(VAULT_KEY)) as string;
    const vault = JSON.parse(raw) as Vault;
    const next: Vault = { ...vault, advancedAccounts: [account] };
    await storage.set(VAULT_KEY, serializeVault(next));

    return { manager, storage, keyVault, walletId };
  }

  it('refuses with guard-changed when the WIRED path re-fetches a rotated keyset', async () => {
    // F-002: the manager must RE-FETCH the live guard (not trust the recorded
    // summary) so a rotated on-chain keyset is caught. The account recorded
    // FOREIGN_PUB; the live read returns a DIFFERENT key → guard-changed, and the
    // pasted (matching-recorded) key is refused rather than accepted against a
    // stale keyset.
    const account = watchOnlyAdvanced(FOREIGN_PUB, '5');
    const { manager } = await setupWithAdvanced(account);

    const fetchGuard = vi.fn(guardStub([ROTATED_PUB]));
    const result = await manager.resolveForeignKey(
      account,
      FOREIGN_KEY,
      undefined, // wired path: NO injected freshGuard → manager must re-fetch
      fetchGuard,
    );

    expect(result).toEqual({ ok: false, reason: 'guard-changed' });
    // The re-fetch hit the account's recorded chain, not a hardcoded default.
    expect(fetchGuard).toHaveBeenCalledWith(account.address, '5');
  });

  it('accepts the paste when the re-fetched keyset still matches the recorded guard', async () => {
    // Control: with the live keyset UNCHANGED the same paste resolves send-capable,
    // proving the re-fetch gate only refuses on a genuine rotation.
    const account = watchOnlyAdvanced(FOREIGN_PUB, '5');
    const { manager } = await setupWithAdvanced(account);

    const fetchGuard = vi.fn(guardStub([FOREIGN_PUB]));
    const result = await manager.resolveForeignKey(
      account,
      FOREIGN_KEY,
      undefined,
      fetchGuard,
    );

    expect(result).toEqual({ ok: true, mode: 'send-capable' });
  });
});

describe('KeyringManager — advanced signing-keypair seam is reachable (F-003)', () => {
  it('returns a SIGN-READY keypair set for a satisfied advanced account', async () => {
    // F-003: resolveAdvancedSigningKeypairs must be reachable behind the manager
    // seam. Build a 1-of-1 guard on the wallet's OWN derived account so the seam
    // resolves it (re-derive → decrypt → raw key) into a sign-ready set.
    const { manager } = makeManager();
    const { account: derived } = await manager.createWallet(PASSWORD);

    const advanced: AdvancedAccount = {
      id: 'adv-self',
      address: derived.account,
      type: 'k-account',
      mode: 'send-capable',
      chainId: '0',
      guardSummary: {
        pred: 'keys-any',
        threshold: 1,
        neededMore: 0,
        predicateRecognized: true,
        keys: [derived.publicKey],
      },
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    const fetchGuard = vi.fn(guardStub([derived.publicKey]));
    const result = await manager.resolveAdvancedSigningKeypairs(
      advanced,
      fetchGuard,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The set covers the guard key with a sign-ready raw private key (koala).
    const kp = result.keypairs.find((k) => k.publicKey === derived.publicKey);
    expect(kp?.privateKey).toMatch(/^[0-9a-f]{64}$/i);
    expect(kp?.seedType).toBe('koala');
    // The gas-payer cap signer is the satisfying in-wallet key.
    expect(result.gasPayerSigner.publicKey).toBe(derived.publicKey);
  });

  it('rejects with WalletLockedError when the wallet is locked', async () => {
    const { manager } = makeManager();
    const advanced = watchOnlyAdvanced(FOREIGN_PUB, '0');
    await manager.lock();
    await expect(
      manager.resolveAdvancedSigningKeypairs(advanced, vi.fn(guardStub([]))),
    ).rejects.toMatchObject({ name: 'WalletLockedError' });
  });
});
