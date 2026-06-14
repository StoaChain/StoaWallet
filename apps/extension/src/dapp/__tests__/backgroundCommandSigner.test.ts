import { describe, expect, it } from 'vitest';

import { KeyringManager } from '@stoawallet/core';
import { InMemoryKeyVault } from '@stoawallet/core/testing';

import { ChromeStorageAdapter } from '../../storage/ChromeStorageAdapter';
import { createApprovalTokenRegistry } from '../../background/approvalTokens';
import { createBackgroundCommandSigner } from '../backgroundCommandSigner';
import type { CommandSigData } from '../protocol';

/**
 * The XP-4 background command-signer adapter, exercised against the REAL
 * KeyringManager + crypto over a chrome-storage double. It bridges the router's
 * secret-free signer seam to the Phase-7 signing path: it consumes the approval
 * token (XP-3), resolves the requested pubkey to the active wallet key, and
 * returns ONLY the filled public command.
 */

const PASSWORD = 'correct horse battery staple';

function installChromeStore(): void {
  const store = new Map<string, unknown>();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { id: 'x' },
    storage: {
      local: {
        async get(keys: string | string[] | null) {
          const out: Record<string, unknown> = {};
          const list = keys == null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
          for (const k of list) if (store.has(k)) out[k] = store.get(k);
          return out;
        },
        async set(items: Record<string, unknown>) {
          for (const [k, v] of Object.entries(items)) store.set(k, v);
        },
        async remove(keys: string | string[]) {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) store.delete(k);
        },
      },
    },
  };
}

async function seedUnlockedWallet(): Promise<{
  manager: KeyringManager;
  keyVault: InMemoryKeyVault;
  publicKey: string;
  address: string;
}> {
  installChromeStore();
  const keyVault = new InMemoryKeyVault();
  const manager = new KeyringManager({ storage: new ChromeStorageAdapter(), keyVault });
  const onboard = await manager.createWallet(PASSWORD);
  return {
    manager,
    keyVault,
    publicKey: onboard.account.publicKey,
    address: onboard.account.account,
  };
}

describe('backgroundCommandSigner (XP-4 adapter)', () => {
  it('consumes the approval token and fills the requested pubkey sig for a real command', async () => {
    const { manager, keyVault, publicKey, address } = await seedUnlockedWallet();
    const approvalTokens = createApprovalTokenRegistry();
    const signer = createBackgroundCommandSigner({ manager, keyVault, approvalTokens });

    const cmd = JSON.stringify({
      payload: { exec: { code: '(+ 1 1)', data: {} } },
      signers: [{ pubKey: publicKey }],
      meta: { chainId: '0', sender: address, gasLimit: 1000, gasPrice: 1e-6, ttl: 600, creationTime: 0 },
      networkId: 'stoachain',
      nonce: 'sig-n',
    });
    const cmds: CommandSigData[] = [{ cmd, sigs: [{ pubKey: publicKey, sig: null }] }];

    const token = approvalTokens.mint();
    const result = await signer.sign(cmds, token);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.responses).toHaveLength(1);
      expect(result.responses[0].outcome.result).toBe('success');
      const filled = result.responses[0].commandSigData.sigs.find((s) => s.pubKey === publicKey);
      expect(filled?.sig).toBeTruthy();
    }
    // SECRET-FREE: nothing key-shaped crosses back.
    const flat = JSON.stringify(result);
    expect(flat).not.toContain('privateKey');
    expect(flat).not.toContain('secretKey');

    // The token was consumed: a replay of the same token signs nothing.
    const replay = await signer.sign(cmds, token);
    expect(replay.ok).toBe(false);
  });

  it('a locked vault collapses the batch to {ok:false, reason:"locked"} (no sign)', async () => {
    const { manager, keyVault, publicKey } = await seedUnlockedWallet();
    await manager.lock();
    const approvalTokens = createApprovalTokenRegistry();
    const signer = createBackgroundCommandSigner({ manager, keyVault, approvalTokens });

    const cmd = '{"payload":{"exec":{"code":"(+ 1 1)"}}}';
    const result = await signer.sign([{ cmd, sigs: [{ pubKey: publicKey, sig: null }] }], approvalTokens.mint());

    expect(result).toEqual({ ok: false, reason: 'locked' });
  });

  it('a never-minted token is rejected as invalid without signing', async () => {
    const { manager, keyVault, publicKey } = await seedUnlockedWallet();
    const approvalTokens = createApprovalTokenRegistry();
    const signer = createBackgroundCommandSigner({ manager, keyVault, approvalTokens });

    const cmd = '{"payload":{"exec":{"code":"(+ 1 1)"}}}';
    const result = await signer.sign([{ cmd, sigs: [{ pubKey: publicKey, sig: null }] }], 'never-minted');

    expect(result).toEqual({ ok: false, reason: 'invalid-request' });
  });
});
