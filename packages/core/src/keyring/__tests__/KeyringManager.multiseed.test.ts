import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { KeyringManager } from '../KeyringManager';

// Real koala derivation (BIP39 + SLIP-10) is heavy, and these tests onboard
// multiple seeds + re-derive on every switch/sign — well past the 5s default
// under full-suite load. Give the file a generous budget.
vi.setConfig({ testTimeout: 30_000 });

/**
 * Multi-seed behavior added for the Codex/Advanced tab: switching the active
 * SEED (`setActiveWallet`) re-points the in-memory mnemonic so signing + add-
 * account use the right seed without a re-prompt, and `addAccountAtIndex` derives
 * a specific (non-consecutive) index. Two onboarded koala seeds (same password)
 * stand in for a post-import multi-seed vault — every seed is sealed at the SAME
 * vault password, which is exactly what lets a non-unlocked seed's phrase open.
 *
 * The chainweaver/eckowallet SIGNING form (encryptedSecretKey + password, no raw
 * key) can't be exercised offline (no WASM seed in unit tests); it is verified
 * live via a real Codex import. These tests pin the multi-seed + index machinery
 * on the koala path that IS testable.
 */
const PASSWORD = 'correct horse battery staple';
const HEX64 = /^[0-9a-f]{64}$/;

function makeManager() {
  const storage = new InMemoryStorageAdapter();
  const keyVault = new InMemoryKeyVault();
  return new KeyringManager({ storage, keyVault });
}

describe('KeyringManager — multi-seed (Codex/Advanced)', () => {
  it('setActiveWallet switches the active seed and resolves THAT seed for signing', async () => {
    const manager = makeManager();
    const a = await manager.createWallet(PASSWORD, { name: 'Seed A' });
    const b = await manager.createWallet(PASSWORD, { name: 'Seed B' });

    // B is active right after onboarding (createWallet appends + activates).
    expect(manager.getActiveAccount()?.account).toBe(b.account.account);

    await manager.setActiveWallet(a.walletId);
    expect(manager.getActiveAccount()?.account).toBe(a.account.account);

    // Signing now resolves Seed A's keypair (its phrase decrypted at the shared
    // password), not B's — even though B was the last unlocked at onboarding.
    const [kp] = await manager.resolveActiveSigningKeypairs();
    expect(kp.publicKey).toBe(a.account.publicKey);
    expect(kp.seedType).toBe('koala');
    expect(kp.privateKey).toMatch(HEX64);

    // Switch back to B and confirm it resolves B.
    await manager.setActiveWallet(b.walletId);
    const [kpB] = await manager.resolveActiveSigningKeypairs();
    expect(kpB.publicKey).toBe(b.account.publicKey);
  });

  it('addAccountAtIndex derives a specific non-consecutive index on the active seed', async () => {
    const manager = makeManager();
    const a = await manager.createWallet(PASSWORD);

    const acct = await manager.addAccountAtIndex(a.walletId, 7);
    expect(acct.index).toBe(7);
    expect(acct.account).toMatch(/^k:[0-9a-f]{64}$/);

    // The active account is now index 7, and it signs.
    expect(manager.getActiveAccount()?.index).toBe(7);
    const [kp] = await manager.resolveActiveSigningKeypairs();
    expect(kp.publicKey).toBe(acct.publicKey);
  });

  it('addAccountAtIndex rejects an index that already exists', async () => {
    const manager = makeManager();
    const a = await manager.createWallet(PASSWORD);
    // Index 0 was created at onboarding.
    await expect(manager.addAccountAtIndex(a.walletId, 0)).rejects.toThrow(
      /already exists/i,
    );
  });

  it('addAccount on a non-active seed requires switching to it first (setActiveWallet)', async () => {
    const manager = makeManager();
    const a = await manager.createWallet(PASSWORD);
    await manager.createWallet(PASSWORD); // B becomes active + unlocked

    // Switch to A, then add — derives on A's seed.
    await manager.setActiveWallet(a.walletId);
    const next = await manager.addAccount(a.walletId);
    expect(next.index).toBe(1);
    expect(next.publicKey).toMatch(HEX64);
    // It belongs to A (a different pubkey than A's index 0).
    expect(next.publicKey).not.toBe(a.account.publicKey);
  });

  it('rejects setActiveWallet / signing when locked', async () => {
    const manager = makeManager();
    const a = await manager.createWallet(PASSWORD);
    await manager.lock();
    await expect(manager.setActiveWallet(a.walletId)).rejects.toThrow();
    await expect(manager.resolveActiveSigningKeypairs()).rejects.toThrow();
  });

  it('renameWallet relabels a seed and surfaces the new name in listWallets', async () => {
    const manager = makeManager();
    const a = await manager.createWallet(PASSWORD, { name: 'Wallet 1' });

    await manager.renameWallet(a.walletId, '  My Main Seed  ');
    const summary = manager.listWallets().find((w) => w.id === a.walletId);
    expect(summary?.name).toBe('My Main Seed'); // trimmed
  });

  it('renameWallet rejects an empty/whitespace name', async () => {
    const manager = makeManager();
    const a = await manager.createWallet(PASSWORD);
    await expect(manager.renameWallet(a.walletId, '   ')).rejects.toThrow(/empty/i);
  });

  it('renameWallet works while LOCKED (non-secret metadata)', async () => {
    const manager = makeManager();
    const a = await manager.createWallet(PASSWORD, { name: 'Before' });
    await manager.lock();
    await manager.renameWallet(a.walletId, 'After');
    expect(manager.listWallets().find((w) => w.id === a.walletId)?.name).toBe('After');
  });

  it('removeAccount drops a derived account but never index #0', async () => {
    const manager = makeManager();
    const a = await manager.createWallet(PASSWORD);
    await manager.addAccountAtIndex(a.walletId, 3); // now {0, 3}, active = 3

    await manager.removeAccount(a.walletId, 3);
    const summary = manager.listWallets().find((w) => w.id === a.walletId);
    expect(summary?.accounts.map((x) => x.index)).toEqual([0]);
    // Removing the ACTIVE account falls the selection back to #0.
    expect(summary?.activeAccountIndex).toBe(0);

    // #0 is the anchor — it cannot be removed.
    await expect(manager.removeAccount(a.walletId, 0)).rejects.toThrow(/#0/);
  });

  it('removeAccount rejects an index that does not exist', async () => {
    const manager = makeManager();
    const a = await manager.createWallet(PASSWORD);
    await expect(manager.removeAccount(a.walletId, 9)).rejects.toThrow(/does not exist/i);
  });
});
