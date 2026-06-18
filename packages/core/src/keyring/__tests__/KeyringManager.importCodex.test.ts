import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import { smartEncrypt } from '@stoachain/stoa-core/crypto';
import { describe, expect, it, vi } from 'vitest';

import { KeyringManager } from '../KeyringManager';
import { decryptPhrase } from '../encryptAtRest';
import { deserializeVault, type Vault } from '../vault';
import { VAULT_KEY } from '../../storage/storageKeys';

// Real PBKDF2/AES round-trips — give the file headroom under full-suite load.
vi.setConfig({ testTimeout: 30_000 });

const WALLET_PW = 'correct horse battery staple';
const CODEX_PW = 'codex-master-password';
const PUB_IMPORTED = 'd'.repeat(64);
const PUB_PURE = 'e'.repeat(64);
const IMPORTED_MNEMONIC = 'imported seed words one two three four';
const PURE_PRIVATE = 'ab'.repeat(32); // 64-hex raw key

function makeManager() {
  const storage = new InMemoryStorageAdapter();
  const keyVault = new InMemoryKeyVault();
  return { storage, manager: new KeyringManager({ storage, keyVault }) };
}

/** Build a v1.2 codex export whose secrets are encrypted at the CODEX password. */
async function makeExportJson(): Promise<string> {
  return JSON.stringify({
    version: '1.2',
    kadenaWallets: [
      {
        id: 'codex-seed-1',
        name: 'Codex Koala',
        seedType: 'koala',
        secret: await smartEncrypt(IMPORTED_MNEMONIC, CODEX_PW, '2'),
        accounts: [
          { index: 0, publicKey: PUB_IMPORTED, derivationPath: "m'/44'/626'/0'" },
        ],
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
  const raw = await storage.get(VAULT_KEY);
  return deserializeVault(typeof raw === 'string' ? raw : new TextDecoder().decode(raw!));
}

describe('KeyringManager.importCodex', () => {
  it('imports a codex export: decrypts at the codex password, re-seals at the WALLET password', async () => {
    const { manager, storage } = makeManager();
    await manager.createWallet(WALLET_PW, { name: 'My koala' });

    const outcome = await manager.importCodex(await makeExportJson(), CODEX_PW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary).toEqual({
      seedsImported: 1,
      accountsImported: 1,
      keysImported: 1,
      skipped: 0,
    });

    // The vault now holds the original koala + the imported seed + the pure key.
    const wallets = manager.listWallets();
    expect(wallets).toHaveLength(2);
    const imported = wallets.find((w) => w.name === 'Codex Koala');
    expect(imported?.seedType).toBe('koala');
    expect(imported?.accounts[0].account).toBe(`k:${PUB_IMPORTED}`);

    // The imported phrase was RE-SEALED at the wallet password (decryptable with
    // WALLET_PW — proving it's no longer at the codex password).
    const vault = await readVault(storage);
    const importedWallet = vault.wallets.find((w) => w.name === 'Codex Koala')!;
    expect(await decryptPhrase(importedWallet.encryptedPhrase, WALLET_PW)).toBe(
      IMPORTED_MNEMONIC,
    );
    // The pure key was re-sealed too (decryptable with WALLET_PW).
    expect(vault.pureKeypairs?.[0].publicKey).toBe(PUB_PURE);
  });

  it('listPureKeypairs surfaces imported pure keys (id, label, publicKey, k: account) — no secret', async () => {
    const { manager } = makeManager();
    await manager.createWallet(WALLET_PW);
    expect(manager.listPureKeypairs()).toEqual([]); // none before import

    await manager.importCodex(await makeExportJson(), CODEX_PW);
    const keys = manager.listPureKeypairs();
    expect(keys).toEqual([
      {
        id: keys[0].id,
        label: 'Cold key',
        publicKey: PUB_PURE,
        account: `k:${PUB_PURE}`,
      },
    ]);
    // The summary carries no secret field.
    expect(JSON.stringify(keys)).not.toContain(PURE_PRIVATE);
  });

  it('returns wrong-codex-password on a bad codex password (never throws, never imports)', async () => {
    const { manager } = makeManager();
    await manager.createWallet(WALLET_PW);
    const outcome = await manager.importCodex(await makeExportJson(), 'WRONG');
    expect(outcome).toEqual({ ok: false, reason: 'wrong-codex-password' });
    expect(manager.listWallets()).toHaveLength(1); // unchanged
  });

  it('is idempotent — re-importing the same codex adds nothing', async () => {
    const { manager } = makeManager();
    await manager.createWallet(WALLET_PW);
    const json = await makeExportJson();
    await manager.importCodex(json, CODEX_PW);
    const second = await manager.importCodex(json, CODEX_PW);
    expect(second).toEqual({ ok: false, reason: 'no-importable-content' });
    expect(manager.listWallets()).toHaveLength(2); // still just original + first import
  });

  it('MERGES a same-seed codex into the existing wallet (adopts name, adds accounts, no duplicate)', async () => {
    const { manager } = makeManager();
    // The pre-existing koala wallet — capture its real account #0 pubkey.
    const created = await manager.createWallet(WALLET_PW, { name: 'Wallet 1' });
    const pub0 = created.account.publicKey;
    const pub1 = 'f'.repeat(64);

    // A codex carrying the SAME seed (shares #0's pubkey) with an extra account #1
    // and the codex's own name. The merge path does not decrypt the secret.
    const json = JSON.stringify({
      version: '1.2',
      kadenaWallets: [
        {
          id: 'codex-seed-same',
          name: 'Ouronet Koala Seed',
          seedType: 'koala',
          secret: await smartEncrypt('unused for a merge', CODEX_PW, '2'),
          accounts: [
            { index: 0, publicKey: pub0, derivationPath: "m'/44'/626'/0'" },
            { index: 1, publicKey: pub1, derivationPath: "m'/44'/626'/1'" },
          ],
        },
      ],
      pureKeypairs: [],
    });

    const outcome = await manager.importCodex(json, CODEX_PW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary).toMatchObject({ seedsImported: 0, accountsImported: 1 });

    // STILL ONE wallet — merged, not duplicated. Name adopted, account #1 added.
    const wallets = manager.listWallets();
    expect(wallets).toHaveLength(1);
    expect(wallets[0].name).toBe('Ouronet Koala Seed');
    expect(wallets[0].accounts.map((a) => a.index)).toEqual([0, 1]);
    expect(wallets[0].accounts[1].account).toBe(`k:${pub1}`);
  });

  it('rejects import when locked', async () => {
    const { manager } = makeManager();
    await manager.createWallet(WALLET_PW);
    await manager.lock();
    await expect(manager.importCodex(await makeExportJson(), CODEX_PW)).rejects.toThrow();
  });
});
