import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import { smartEncrypt } from '@stoachain/stoa-core/crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  KeyringManager,
  LastWalletError,
  WalletLockedError,
} from '../KeyringManager';
import { deserializeVault, type Vault } from '../vault';
import { VAULT_KEY } from '../../storage/storageKeys';

// Real PBKDF2/AES round-trips per seed — give the file headroom.
vi.setConfig({ testTimeout: 60_000 });

const WALLET_PW = 'correct horse battery staple';
const CODEX_PW = 'codex-master-password';
const PUB_A = 'd'.repeat(64);
const PUB_B = 'f'.repeat(64);
const PUB_PURE_1 = 'e'.repeat(64);
const PUB_PURE_2 = '9'.repeat(64);
const PURE_PRIVATE = 'ab'.repeat(32);

function makeManager() {
  const storage = new InMemoryStorageAdapter();
  const keyVault = new InMemoryKeyVault();
  return { storage, keyVault, manager: new KeyringManager({ storage, keyVault }) };
}

/** Two seeds (wallet-1 active after onboarding) and two pure keys. */
async function twoSeedTwoKeyCodex(): Promise<string> {
  return JSON.stringify({
    version: '1.2',
    kadenaWallets: [
      {
        id: 'codex-seed-1',
        name: 'Seed A',
        seedType: 'koala',
        secret: await smartEncrypt('seed a words one two three four', CODEX_PW, '2'),
        accounts: [{ index: 0, publicKey: PUB_A, derivationPath: "m'/44'/626'/0'" }],
      },
      {
        id: 'codex-seed-2',
        name: 'Seed B',
        seedType: 'koala',
        secret: await smartEncrypt('seed b words five six seven eight', CODEX_PW, '2'),
        accounts: [{ index: 0, publicKey: PUB_B, derivationPath: "m'/44'/626'/0'" }],
      },
    ],
    pureKeypairs: [
      {
        id: 'codex-pk-1',
        label: 'Key one',
        publicKey: PUB_PURE_1,
        encryptedPrivateKey: await smartEncrypt(PURE_PRIVATE, CODEX_PW, '2'),
      },
      {
        id: 'codex-pk-2',
        label: 'Key two',
        publicKey: PUB_PURE_2,
        encryptedPrivateKey: await smartEncrypt(PURE_PRIVATE, CODEX_PW, '2'),
      },
    ],
  });
}

async function readVault(storage: InMemoryStorageAdapter): Promise<Vault> {
  return deserializeVault(String(await storage.get(VAULT_KEY)));
}

async function onboarded() {
  const m = makeManager();
  const res = await m.manager.onboardFromCodex(
    await twoSeedTwoKeyCodex(),
    CODEX_PW,
    WALLET_PW,
  );
  expect(res.ok).toBe(true);
  return m;
}

describe('KeyringManager.removeWallet', () => {
  it('removes a non-active seed and leaves every other seed and key intact', async () => {
    const { storage, manager } = await onboarded();

    await manager.removeWallet('wallet-2');

    const vault = await readVault(storage);
    expect(vault.wallets.map((w) => w.id)).toEqual(['wallet-1']);
    expect(vault.activeWalletId).toBe('wallet-1');
    // Removing a seed must not quietly take the pure keys with it.
    expect(vault.pureKeypairs).toHaveLength(2);
  });

  it('removing the ACTIVE seed re-points the wallet at a remaining seed', async () => {
    const { storage, manager } = await onboarded();

    await manager.removeWallet('wallet-1');

    const vault = await readVault(storage);
    expect(vault.wallets.map((w) => w.id)).toEqual(['wallet-2']);
    // A dangling activeWalletId would point every screen at a seed that no
    // longer exists.
    expect(vault.activeWalletId).toBe('wallet-2');
    expect(manager.getActiveAccount()?.publicKey).toBe(PUB_B);
  });

  it('stays UNLOCKED after removing the active seed, so the session keeps working', async () => {
    const { manager } = await onboarded();

    await manager.removeWallet('wallet-1');

    // exportCodex decrypts every remaining seed and refuses while locked — it
    // resolving proves the session survived the removal rather than being
    // silently dropped, which would bounce the user to the lock screen.
    await expect(manager.exportCodex('some export pw')).resolves.toContain('Seed B');
  });

  it('REFUSES to remove the last remaining seed and leaves the vault untouched', async () => {
    const { storage, manager } = makeManager();
    const { walletId } = await manager.createWallet(WALLET_PW);

    // A vault with zero seeds has no active wallet to point at and nothing to
    // sign with — the wallet would be unusable yet still "exist".
    await expect(manager.removeWallet(walletId)).rejects.toBeInstanceOf(
      LastWalletError,
    );
    expect((await readVault(storage)).wallets).toHaveLength(1);
  });

  it('REFUSES while locked — removal destroys an encrypted seed', async () => {
    const { storage, manager } = await onboarded();
    await manager.lock();

    await expect(manager.removeWallet('wallet-2')).rejects.toBeInstanceOf(
      WalletLockedError,
    );
    expect((await readVault(storage)).wallets).toHaveLength(2);
  });

  it('rejects an unknown seed id without changing the vault', async () => {
    const { storage, manager } = await onboarded();

    await expect(manager.removeWallet('no-such-wallet')).rejects.toThrow();
    expect((await readVault(storage)).wallets).toHaveLength(2);
  });
});

describe('KeyringManager.removePureKeypair', () => {
  it('removes one pure key and keeps the other, and every seed', async () => {
    const { storage, manager } = await onboarded();
    const before = await readVault(storage);
    const target = before.pureKeypairs?.find((k) => k.publicKey === PUB_PURE_1);
    expect(target).toBeDefined();

    await manager.removePureKeypair(target!.id);

    const after = await readVault(storage);
    expect(after.pureKeypairs?.map((k) => k.publicKey)).toEqual([PUB_PURE_2]);
    expect(after.wallets).toHaveLength(2);
    // The summary the UI lists must drop it too, not just the stored blob.
    expect(manager.listPureKeypairs().map((k) => k.publicKey)).toEqual([PUB_PURE_2]);
  });

  it('can remove EVERY pure key — unlike seeds, having none is a valid wallet', async () => {
    const { storage, manager } = await onboarded();
    const ids = ((await readVault(storage)).pureKeypairs ?? []).map((k) => k.id);

    for (const id of ids) await manager.removePureKeypair(id);

    expect((await readVault(storage)).pureKeypairs ?? []).toHaveLength(0);
  });

  it('REFUSES while locked — removal destroys an encrypted private key', async () => {
    const { storage, manager } = await onboarded();
    const id = (await readVault(storage)).pureKeypairs![0].id;
    await manager.lock();

    await expect(manager.removePureKeypair(id)).rejects.toBeInstanceOf(
      WalletLockedError,
    );
    expect((await readVault(storage)).pureKeypairs).toHaveLength(2);
  });

  it('rejects an unknown key id without changing the vault', async () => {
    const { storage, manager } = await onboarded();

    await expect(manager.removePureKeypair('no-such-key')).rejects.toThrow();
    expect((await readVault(storage)).pureKeypairs).toHaveLength(2);
  });
});
