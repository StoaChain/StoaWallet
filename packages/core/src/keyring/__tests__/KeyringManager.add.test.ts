import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import { smartDecrypt } from '@stoachain/stoa-core/crypto';
import { KadenaWalletBuilder } from '@stoachain/stoa-core/wallet';
import { describe, expect, it, vi } from 'vitest';

import { generatePureKeypair } from '../../advanced';
import { VAULT_KEY } from '../../storage/storageKeys';
import { KeyringManager, WalletLockedError } from '../KeyringManager';
import { decryptPhrase } from '../encryptAtRest';
import { generateMnemonicFor } from '../mnemonic';
import { deserializeVault, serializeVault, type Vault } from '../vault';

// Real PBKDF2/AES rounds plus WASM derivation for 12-word seeds.
vi.setConfig({ testTimeout: 120_000 });

const WALLET_PW = 'correct horse battery staple';

function makeManager() {
  const storage = new InMemoryStorageAdapter();
  const keyVault = new InMemoryKeyVault();
  return { storage, manager: new KeyringManager({ storage, keyVault }) };
}

async function readVault(storage: InMemoryStorageAdapter): Promise<Vault> {
  return deserializeVault(String(await storage.get(VAULT_KEY)));
}

describe('KeyringManager.addSeed', () => {
  it('APPENDS a koala seed with Key #0 and Key #1, leaving the active seed alone', async () => {
    const { storage, manager } = makeManager();
    const first = await manager.createWallet(WALLET_PW);
    const phrase = await generateMnemonicFor('koala');

    const res = await manager.addSeed({ phrase, seedType: 'koala', name: 'Savings' });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const vault = await readVault(storage);
    expect(vault.wallets).toHaveLength(2);
    // Adding a seed is not switching to it: the seed the user is working in
    // stays active, exactly as in Codex.
    expect(vault.activeWalletId).toBe(first.walletId);
    const added = vault.wallets.find((w) => w.id === res.walletId);
    expect(added?.name).toBe('Savings');
    expect(added?.seedType).toBe('koala');
    expect(added?.origin).toBe('seed');
    expect(added?.accounts.map((a) => a.index)).toEqual([0, 1]);
  });

  it('seals the new phrase at the WALLET password', async () => {
    const { storage, manager } = makeManager();
    await manager.createWallet(WALLET_PW);
    const phrase = await generateMnemonicFor('koala');

    const res = await manager.addSeed({ phrase, seedType: 'koala', name: 'Savings' });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const added = (await readVault(storage)).wallets.find((w) => w.id === res.walletId);
    await expect(decryptPhrase(added!.encryptedPhrase, WALLET_PW)).resolves.toBe(phrase);
  });

  it.each(['chainweaver', 'eckowallet'] as const)(
    'adds a 12-word %s seed whose accounts match that type’s real derivation',
    async (seedType) => {
      const { storage, manager } = makeManager();
      await manager.createWallet(WALLET_PW);
      const phrase = await generateMnemonicFor(seedType);

      const res = await manager.addSeed({ phrase, seedType, name: 'Legacy' });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const added = (await readVault(storage)).wallets.find((w) => w.id === res.walletId);
      expect(added?.seedType).toBe(seedType);
      const key0 = await KadenaWalletBuilder.createWalletPairFromMnemonic(
        WALLET_PW,
        phrase,
        0,
        seedType,
      );
      expect(added?.accounts[0].publicKey).toBe(key0.publicKey);
    },
  );

  it('REFUSES a 24-word phrase added as chainweaver — it would derive the wrong keys', async () => {
    const { storage, manager } = makeManager();
    await manager.createWallet(WALLET_PW);
    const koala = await generateMnemonicFor('koala');

    expect(
      await manager.addSeed({ phrase: koala, seedType: 'chainweaver', name: 'Wrong type' }),
    ).toEqual({ ok: false, reason: 'word-count' });
    expect((await readVault(storage)).wallets).toHaveLength(1);
  });

  it('rejects an invalid phrase, then a missing name, without touching the vault', async () => {
    const { storage, manager } = makeManager();
    await manager.createWallet(WALLET_PW);
    const garbage = Array.from({ length: 24 }, () => 'notaword').join(' ');
    const good = await generateMnemonicFor('koala');

    expect(await manager.addSeed({ phrase: garbage, seedType: 'koala', name: 'x' })).toEqual({
      ok: false,
      reason: 'invalid-words',
    });
    expect(await manager.addSeed({ phrase: good, seedType: 'koala', name: '   ' })).toEqual({
      ok: false,
      reason: 'missing-name',
    });
    expect((await readVault(storage)).wallets).toHaveLength(1);
  });

  it('joins a codex-rooted wallet as codex-origin, so advanced mode stays forced on', async () => {
    const { storage, manager } = makeManager();
    await manager.createWallet(WALLET_PW);
    // Onboarding from a codex marks every seed codex-origin; mimic that.
    const vault = await readVault(storage);
    await storage.set(
      VAULT_KEY,
      serializeVault({
        ...vault,
        wallets: vault.wallets.map((w) => ({ ...w, origin: 'codex' as const })),
      }),
    );
    const phrase = await generateMnemonicFor('koala');

    const res = await manager.addSeed({ phrase, seedType: 'koala', name: 'Added' });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const added = (await readVault(storage)).wallets.find((w) => w.id === res.walletId);
    // Advanced mode is forced for a codex-origin active seed; a seed added from
    // inside that wallet must keep it forced once the user switches to it.
    expect(added?.origin).toBe('codex');
  });

  it('REFUSES a seed the vault already holds instead of duplicating it', async () => {
    const { storage, manager } = makeManager();
    const { phrase } = await manager.createWallet(WALLET_PW);

    expect(await manager.addSeed({ phrase, seedType: 'koala', name: 'Again' })).toEqual({
      ok: false,
      reason: 'duplicate-seed',
    });
    expect((await readVault(storage)).wallets).toHaveLength(1);
  });

  it('REFUSES while locked', async () => {
    const { manager } = makeManager();
    await manager.createWallet(WALLET_PW);
    await manager.lock();
    const phrase = await generateMnemonicFor('koala');

    await expect(
      manager.addSeed({ phrase, seedType: 'koala', name: 'Locked' }),
    ).rejects.toBeInstanceOf(WalletLockedError);
  });
});

describe('KeyringManager.addPureKeypair', () => {
  it('stores a generated keypair sealed at the wallet password, with its label', async () => {
    const { storage, manager } = makeManager();
    await manager.createWallet(WALLET_PW);
    const kp = generatePureKeypair();

    const res = await manager.addPureKeypair({
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      label: 'Hot key',
    });

    expect(res).toMatchObject({ ok: true, publicKey: kp.publicKey });
    const stored = (await readVault(storage)).pureKeypairs ?? [];
    expect(stored).toHaveLength(1);
    expect(stored[0].label).toBe('Hot key');
    await expect(smartDecrypt(stored[0].encryptedPrivateKey, WALLET_PW)).resolves.toBe(
      kp.privateKey,
    );
    // The list the UI renders must include it too, not just the stored blob.
    expect(manager.listPureKeypairs().map((k) => k.publicKey)).toEqual([kp.publicKey]);
  });

  it('REFUSES a private key that does not derive the public key given with it', async () => {
    const { storage, manager } = makeManager();
    await manager.createWallet(WALLET_PW);
    const a = generatePureKeypair();
    const b = generatePureKeypair();

    expect(
      await manager.addPureKeypair({ privateKey: a.privateKey, publicKey: b.publicKey }),
    ).toEqual({ ok: false, reason: 'key-mismatch' });
    expect((await readVault(storage)).pureKeypairs ?? []).toHaveLength(0);
  });

  it('rejects a malformed private key as bad-format', async () => {
    const { manager } = makeManager();
    await manager.createWallet(WALLET_PW);

    expect(
      await manager.addPureKeypair({ privateKey: 'not a key', publicKey: 'a'.repeat(64) }),
    ).toEqual({ ok: false, reason: 'bad-format' });
  });

  it('REFUSES the same key twice', async () => {
    const { storage, manager } = makeManager();
    await manager.createWallet(WALLET_PW);
    const kp = generatePureKeypair();
    await manager.addPureKeypair({ privateKey: kp.privateKey, publicKey: kp.publicKey });

    expect(
      await manager.addPureKeypair({ privateKey: kp.privateKey, publicKey: kp.publicKey }),
    ).toEqual({ ok: false, reason: 'duplicate-key' });
    expect((await readVault(storage)).pureKeypairs ?? []).toHaveLength(1);
  });

  it('REFUSES while locked', async () => {
    const { manager } = makeManager();
    await manager.createWallet(WALLET_PW);
    await manager.lock();
    const kp = generatePureKeypair();

    await expect(
      manager.addPureKeypair({ privateKey: kp.privateKey, publicKey: kp.publicKey }),
    ).rejects.toBeInstanceOf(WalletLockedError);
  });
});
