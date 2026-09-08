import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import { smartEncrypt } from '@stoachain/stoa-core/crypto';
import { describe, expect, it, vi } from 'vitest';

import { KeyringManager, WalletLockedError } from '../KeyringManager';
import { decryptPhrase } from '../encryptAtRest';
import { deserializeVault, type Vault } from '../vault';
import { VAULT_KEY } from '../../storage/storageKeys';

// Real PBKDF2/AES round-trips per seed — give the file headroom.
vi.setConfig({ testTimeout: 60_000 });

const WALLET_PW = 'correct horse battery staple';
const EXPORT_PW = 'a different password for the file';
const CODEX_PW = 'codex-master-password';
const PUB_A = 'd'.repeat(64);
const PUB_B = 'f'.repeat(64);
const PUB_PURE = 'e'.repeat(64);
const MNEMONIC_A = 'first imported seed words one two three four';
const MNEMONIC_B = 'second imported seed words five six seven eight';
const PURE_PRIVATE = 'ab'.repeat(32);

function makeManager() {
  const storage = new InMemoryStorageAdapter();
  const keyVault = new InMemoryKeyVault();
  return { storage, keyVault, manager: new KeyringManager({ storage, keyVault }) };
}

/** A codex with two seeds and one pure key, sealed at the CODEX password. */
async function seedCodexJson(): Promise<string> {
  return JSON.stringify({
    version: '1.2',
    kadenaWallets: [
      {
        id: 'codex-seed-1',
        name: 'Codex Koala A',
        seedType: 'koala',
        secret: await smartEncrypt(MNEMONIC_A, CODEX_PW, '2'),
        accounts: [{ index: 0, publicKey: PUB_A, derivationPath: "m'/44'/626'/0'" }],
      },
      {
        id: 'codex-seed-2',
        name: 'Codex Koala B',
        seedType: 'koala',
        secret: await smartEncrypt(MNEMONIC_B, CODEX_PW, '2'),
        accounts: [{ index: 0, publicKey: PUB_B, derivationPath: "m'/44'/626'/0'" }],
      },
    ],
    pureKeypairs: [
      {
        id: 'codex-pk-1',
        label: 'Cold key',
        publicKey: PUB_PURE,
        encryptedPrivateKey: await smartEncrypt(PURE_PRIVATE, CODEX_PW, '2'),
      },
    ],
  });
}

async function readVault(storage: InMemoryStorageAdapter): Promise<Vault> {
  return deserializeVault(String(await storage.get(VAULT_KEY)));
}

describe('KeyringManager.exportCodex', () => {
  it('REFUSES to export while locked — exporting decrypts every seed', async () => {
    const { manager } = makeManager();
    await manager.onboardFromCodex(await seedCodexJson(), CODEX_PW, WALLET_PW);
    await manager.lock();

    await expect(manager.exportCodex(EXPORT_PW)).rejects.toBeInstanceOf(
      WalletLockedError,
    );
  });

  it('ROUND-TRIPS: the export re-imports into a fresh wallet with the same secrets', async () => {
    const source = makeManager();
    await source.manager.onboardFromCodex(await seedCodexJson(), CODEX_PW, WALLET_PW);

    const json = await source.manager.exportCodex(EXPORT_PW);

    // This is the whole feature: a user whose browser data was wiped must be
    // able to get their seeds back from the file, on a clean install.
    const restored = makeManager();
    const res = await restored.manager.onboardFromCodex(json, EXPORT_PW, 'brand new wallet pw');
    expect(res.ok).toBe(true);

    const vault = await readVault(restored.storage);
    expect(vault.wallets).toHaveLength(2);
    await expect(
      decryptPhrase(vault.wallets[0].encryptedPhrase, 'brand new wallet pw'),
    ).resolves.toBe(MNEMONIC_A);
    await expect(
      decryptPhrase(vault.wallets[1].encryptedPhrase, 'brand new wallet pw'),
    ).resolves.toBe(MNEMONIC_B);
    expect(vault.pureKeypairs).toHaveLength(1);
    expect(vault.pureKeypairs?.[0].publicKey).toBe(PUB_PURE);
  });

  it('seals the file at the EXPORT password — the wallet password alone will not open it', async () => {
    const { manager } = makeManager();
    await manager.onboardFromCodex(await seedCodexJson(), CODEX_PW, WALLET_PW);

    const json = await manager.exportCodex(EXPORT_PW);

    // The file leaves the device, so it must not be readable with the password
    // the user types to unlock the extension every day.
    const fresh = makeManager();
    const wrong = await fresh.manager.onboardFromCodex(json, WALLET_PW, 'pw');
    expect(wrong).toEqual({ ok: false, reason: 'wrong-codex-password' });
  });

  it('never writes a plaintext mnemonic or private key into the file', async () => {
    const { manager } = makeManager();
    await manager.onboardFromCodex(await seedCodexJson(), CODEX_PW, WALLET_PW);

    const json = await manager.exportCodex(EXPORT_PW);

    expect(json).not.toContain(MNEMONIC_A);
    expect(json).not.toContain(MNEMONIC_B);
    expect(json).not.toContain(PURE_PRIVATE);
    // Nor either password.
    expect(json).not.toContain(WALLET_PW);
    expect(json).not.toContain(EXPORT_PW);
  });

  it('reports progress once per seed and key, ending at the total', async () => {
    const { manager } = makeManager();
    await manager.onboardFromCodex(await seedCodexJson(), CODEX_PW, WALLET_PW);

    const ticks: Array<[number, number]> = [];
    await manager.exportCodex(EXPORT_PW, (done, total) => ticks.push([done, total]));

    // 2 seeds + 1 pure key.
    expect(ticks).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });
});
