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

/** A codex carrying TWO seeds and one pure key, sealed at the CODEX password. */
async function makeExportJson(): Promise<string> {
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
  const raw = await storage.get(VAULT_KEY);
  return deserializeVault(String(raw));
}

describe('KeyringManager.onboardFromCodex — first-run codex onboarding', () => {
  it('creates a vault from an EMPTY store, with no phantom seed wallet', async () => {
    const { storage, manager } = makeManager();
    // The whole point of this path: importCodex requires an unlocked wallet, so
    // without it the only way to onboard from a codex would be to generate a
    // throwaway seed first — a seed the user never backed up but could receive
    // funds on.
    expect(await storage.get(VAULT_KEY)).toBeNull();

    const res = await manager.onboardFromCodex(
      await makeExportJson(),
      CODEX_PW,
      WALLET_PW,
    );

    expect(res.ok).toBe(true);
    const vault = await readVault(storage);
    expect(vault.wallets).toHaveLength(2);
    expect(vault.wallets.map((w) => w.name)).toEqual([
      'Codex Koala A',
      'Codex Koala B',
    ]);
  });

  it('stamps every imported wallet as codex-origin so advanced mode is forced on', async () => {
    const { storage, manager } = makeManager();
    await manager.onboardFromCodex(await makeExportJson(), CODEX_PW, WALLET_PW);

    const vault = await readVault(storage);
    expect(vault.wallets.every((w) => w.origin === 'codex')).toBe(true);
  });

  it('RE-SEALS the seeds at the WALLET password, not the codex password', async () => {
    const { storage, manager } = makeManager();
    await manager.onboardFromCodex(await makeExportJson(), CODEX_PW, WALLET_PW);

    const vault = await readVault(storage);
    // Readable with the wallet password the user just chose...
    await expect(
      decryptPhrase(vault.wallets[0].encryptedPhrase, WALLET_PW),
    ).resolves.toBe(MNEMONIC_A);
    // ...and NOT with the codex password, which the wallet never stores.
    await expect(
      decryptPhrase(vault.wallets[0].encryptedPhrase, CODEX_PW),
    ).rejects.toThrow();
  });

  it('carries the pure keypairs across and leaves the wallet UNLOCKED', async () => {
    const { storage, keyVault, manager } = makeManager();
    await manager.onboardFromCodex(await makeExportJson(), CODEX_PW, WALLET_PW);

    const vault = await readVault(storage);
    expect(vault.pureKeypairs).toHaveLength(1);
    // Onboarding ends unlocked for create/import, so codex must match — otherwise
    // the user lands on a lock screen right after setting their password.
    expect(keyVault.isUnlocked()).toBe(true);
  });

  it('rejects a wrong codex password WITHOUT writing a partial vault', async () => {
    const { storage, keyVault, manager } = makeManager();

    const res = await manager.onboardFromCodex(
      await makeExportJson(),
      'not-the-codex-password',
      WALLET_PW,
    );

    expect(res).toEqual({ ok: false, reason: 'wrong-codex-password' });
    // A half-written vault would strand the user: no seed they control, but
    // `hasExistingWallet` true, so onboarding would never be offered again.
    expect(await storage.get(VAULT_KEY)).toBeNull();
    expect(keyVault.isUnlocked()).toBe(false);
  });

  it('rejects malformed JSON and an unsupported version without writing a vault', async () => {
    const { storage, manager } = makeManager();

    expect(await manager.onboardFromCodex('not json', CODEX_PW, WALLET_PW)).toEqual({
      ok: false,
      reason: 'invalid-json',
    });
    const bad = JSON.stringify({ version: '0.9', kadenaWallets: [] });
    expect((await manager.onboardFromCodex(bad, CODEX_PW, WALLET_PW)).ok).toBe(false);
    expect(await storage.get(VAULT_KEY)).toBeNull();
  });

  it('rejects a codex with no importable seeds rather than creating an empty vault', async () => {
    const { storage, manager } = makeManager();
    const empty = JSON.stringify({ version: '1.2', kadenaWallets: [], pureKeypairs: [] });

    const res = await manager.onboardFromCodex(empty, CODEX_PW, WALLET_PW);

    expect(res).toEqual({ ok: false, reason: 'no-importable-content' });
    expect(await storage.get(VAULT_KEY)).toBeNull();
  });

  it('refuses to run when a vault ALREADY exists — that is importCodex territory', async () => {
    const { manager } = makeManager();
    await manager.createWallet(WALLET_PW);

    // Onboarding is first-run only; re-running it would clobber the existing
    // vault and destroy seeds the user may not have backed up.
    await expect(
      manager.onboardFromCodex(await makeExportJson(), CODEX_PW, WALLET_PW),
    ).rejects.toThrow();
  });
});

/**
 * The real-world sequence a codex holder hits: onboard from codex A, then later
 * import codex B from the Advanced tab. The second import must be ADDITIVE —
 * anything new is added, anything already held is skipped, and NOTHING already
 * in the vault is replaced or dropped.
 */
describe('a SECOND codex imported after codex onboarding', () => {
  const PUB_C = 'c'.repeat(64);
  const PUB_PURE_2 = '9'.repeat(64);
  const PUB_D = '7'.repeat(64);
  const MNEMONIC_C = 'third imported seed words nine ten eleven twelve';

  /**
   * Codex B overlaps codex A deliberately:
   *  - a seed sharing A's first account pubkey (the same seed, one MORE account)
   *  - a brand-new seed
   *  - the pure key A already carries, plus a new one
   */
  async function makeSecondCodexJson(): Promise<string> {
    return JSON.stringify({
      version: '1.2',
      kadenaWallets: [
        {
          id: 'codex-seed-1',
          name: 'Codex Koala A',
          seedType: 'koala',
          secret: await smartEncrypt(MNEMONIC_A, CODEX_PW, '2'),
          accounts: [
            { index: 0, publicKey: PUB_A, derivationPath: "m'/44'/626'/0'" },
            { index: 1, publicKey: PUB_C, derivationPath: "m'/44'/626'/1'" },
          ],
        },
        {
          id: 'codex-seed-3',
          name: 'Codex Koala C',
          seedType: 'koala',
          secret: await smartEncrypt(MNEMONIC_C, CODEX_PW, '2'),
          accounts: [
            { index: 0, publicKey: PUB_D, derivationPath: "m'/44'/626'/0'" },
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
        {
          id: 'codex-pk-2',
          label: 'Second cold key',
          publicKey: PUB_PURE_2,
          encryptedPrivateKey: await smartEncrypt(PURE_PRIVATE, CODEX_PW, '2'),
        },
      ],
    });
  }

  it('ADDS the new seed without dropping or replacing the onboarded ones', async () => {
    const { storage, manager } = makeManager();
    await manager.onboardFromCodex(await makeExportJson(), CODEX_PW, WALLET_PW);
    const before = await readVault(storage);
    expect(before.wallets).toHaveLength(2);

    const res = await manager.importCodex(await makeSecondCodexJson(), CODEX_PW);
    expect(res.ok).toBe(true);

    const after = await readVault(storage);
    // The two onboarded seeds SURVIVE, by id, and the new one is appended.
    expect(after.wallets.map((w) => w.id)).toEqual(
      expect.arrayContaining(before.wallets.map((w) => w.id)),
    );
    expect(after.wallets).toHaveLength(3);
  });

  it('does NOT duplicate a seed it already holds — it merges the extra account in', async () => {
    const { storage, manager } = makeManager();
    await manager.onboardFromCodex(await makeExportJson(), CODEX_PW, WALLET_PW);
    await manager.importCodex(await makeSecondCodexJson(), CODEX_PW);

    const after = await readVault(storage);
    // Seed A appears ONCE, now carrying both its accounts — not twice.
    const seedA = after.wallets.filter((w) =>
      w.accounts.some((a) => a.publicKey === PUB_A),
    );
    expect(seedA).toHaveLength(1);
    expect(seedA[0].accounts.map((a) => a.publicKey).sort()).toEqual(
      [PUB_A, PUB_C].sort(),
    );
  });

  it('keeps the ALREADY-HELD pure key once and adds only the new one', async () => {
    const { storage, manager } = makeManager();
    await manager.onboardFromCodex(await makeExportJson(), CODEX_PW, WALLET_PW);
    await manager.importCodex(await makeSecondCodexJson(), CODEX_PW);

    const after = await readVault(storage);
    const pubs = (after.pureKeypairs ?? []).map((k) => k.publicKey);
    expect(pubs).toHaveLength(2);
    expect(new Set(pubs)).toEqual(new Set([PUB_PURE, PUB_PURE_2]));
  });

  it('leaves every surviving seed still decryptable at the ORIGINAL wallet password', async () => {
    const { storage, manager } = makeManager();
    await manager.onboardFromCodex(await makeExportJson(), CODEX_PW, WALLET_PW);
    await manager.importCodex(await makeSecondCodexJson(), CODEX_PW);

    const after = await readVault(storage);
    // A "replace" bug would most likely surface as a seed re-sealed under some
    // other key, or a phrase swapped for the wrong one — check the actual secret.
    const seedA = after.wallets.find((w) =>
      w.accounts.some((a) => a.publicKey === PUB_A),
    );
    await expect(
      decryptPhrase(seedA!.encryptedPhrase, WALLET_PW),
    ).resolves.toBe(MNEMONIC_A);
  });

  it('re-importing the SAME codex a second time changes nothing at all', async () => {
    const { storage, manager } = makeManager();
    await manager.onboardFromCodex(await makeExportJson(), CODEX_PW, WALLET_PW);
    const before = JSON.stringify(await readVault(storage));

    const res = await manager.importCodex(await makeExportJson(), CODEX_PW);

    // Nothing new to take: the importer says so rather than silently no-op'ing.
    expect(res).toEqual({ ok: false, reason: 'no-importable-content' });
    // And crucially the stored vault is byte-identical — no replace, no reorder.
    expect(JSON.stringify(await readVault(storage))).toBe(before);
  });
});
