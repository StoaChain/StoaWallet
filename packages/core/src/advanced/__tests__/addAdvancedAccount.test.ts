import { describe, expect, it, vi } from 'vitest';

import { addAdvancedAccount } from '../addAdvancedAccount';
import type { FetchGuardFn } from '../addAdvancedAccount';
import type { AccountGuardResult } from '../fetchAccountGuard';
import { InMemoryStorageAdapter } from '@stoawallet/core/testing';
import {
  deserializeVault,
  serializeVault,
} from '../../keyring/vault';
import type { EncryptedBlob, StoredWallet, Vault } from '../../keyring/vault';
import { VAULT_KEY } from '../../storage/storageKeys';

/**
 * `addAdvancedAccount` is the orchestrator that composes the Wave-1 blocks
 * (classify -> fetch guard -> analyze) and persists ATOMICALLY through the
 * injected `StorageAdapter` (a single serializeVault + storage.set). These
 * tests pin the binding decisions: distinct not-found vs not-key-guarded
 * reasons (RR#11), the predicateRecognized===false -> watch-only override
 * (RR#10), already-derived no-op, and that watch-only/send-capable records
 * land in the vault under VAULT_KEY with the right mode + neededMore.
 */

const KEY_A = 'aaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff';
const KEY_B = '1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777888899990000';
const KEY_C = '2222bbbb3333cccc4444dddd5555eeee6666ffff7777888899990000aaaa1111';

const CUSTOM_ADDRESS = 'w:multisig-address-xyz:keys-2';

function blob(s: string): EncryptedBlob {
  return s as unknown as EncryptedBlob;
}

function wallet(): StoredWallet {
  return {
    id: 'wallet-1',
    name: 'Prime',
    encryptedPhrase: blob('ENC::seed-phrase-envelope'),
    accounts: [
      {
        index: 0,
        publicKey: KEY_A,
        account: `k:${KEY_A}`,
        derivationPath: "m'/44'/626'/0'",
      },
    ],
    activeAccountIndex: 0,
    seedType: 'koala',
    createdAt: '2026-06-14T00:00:00.000Z',
  };
}

function baseVault(): Vault {
  return { wallets: [wallet()], activeWalletId: 'wallet-1' };
}

/** Seed the in-memory adapter with a vault and return a primed adapter. */
async function seedStorage(): Promise<InMemoryStorageAdapter> {
  const storage = new InMemoryStorageAdapter();
  await storage.set(VAULT_KEY, serializeVault(baseVault()));
  return storage;
}

/** A fetchGuard stub returning a fixed AccountGuardResult. */
function stubGuard(result: AccountGuardResult): FetchGuardFn {
  return vi.fn(async () => result);
}

/** A fetchGuard stub that must NEVER be called (asserts the no-op paths). */
function neverCalledGuard(): FetchGuardFn {
  return vi.fn(async () => {
    throw new Error('fetchGuard must not be called');
  });
}

const keysetGuard = (
  keys: string[],
  pred: string,
): AccountGuardResult => ({
  exists: true,
  isKeyset: true,
  keys,
  pred,
  balance: 0,
});

describe('addAdvancedAccount', () => {
  it('persists a satisfied keyset as a send-capable advanced account', async () => {
    const storage = await seedStorage();
    // Wallet holds KEY_A; a keys-all keyset over [KEY_A] is satisfiable.
    const fetchGuard = stubGuard(keysetGuard([KEY_A], 'keys-all'));

    const result = await addAdvancedAccount(
      {
        address: CUSTOM_ADDRESS,
        chainId: '0',
        walletPubSet: new Set([KEY_A]),
      },
      { fetchGuard, storage },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe('send-capable');
    expect(result.account.address).toBe(CUSTOM_ADDRESS);
    expect(result.account.mode).toBe('send-capable');

    const persisted = deserializeVault(
      (await storage.get(VAULT_KEY)) as string,
    );
    expect(persisted.advancedAccounts).toHaveLength(1);
    expect(persisted.advancedAccounts?.[0].mode).toBe('send-capable');
    expect(persisted.advancedAccounts?.[0].address).toBe(CUSTOM_ADDRESS);
  });

  it('persists an unsatisfiable 2-of-3 keyset as watch-only with the right neededMore', async () => {
    const storage = await seedStorage();
    // keys-2 over [A,B,C]; wallet only holds KEY_A -> 1 signable, needs 1 more.
    const fetchGuard = stubGuard(keysetGuard([KEY_A, KEY_B, KEY_C], 'keys-2'));

    const result = await addAdvancedAccount(
      {
        address: CUSTOM_ADDRESS,
        chainId: '0',
        walletPubSet: new Set([KEY_A]),
      },
      { fetchGuard, storage },
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.mode !== 'watch-only') {
      throw new Error('expected a watch-only result');
    }
    expect(result.neededMore).toBe(1);
    expect(result.account.mode).toBe('watch-only');
    expect(result.account.guardSummary?.neededMore).toBe(1);

    const persisted = deserializeVault(
      (await storage.get(VAULT_KEY)) as string,
    );
    expect(persisted.advancedAccounts?.[0].mode).toBe('watch-only');
  });

  it('rejects a non-keyset guard as not-key-guarded and persists nothing', async () => {
    const storage = await seedStorage();
    const fetchGuard = stubGuard({
      exists: true,
      isKeyset: false,
      keys: [],
      pred: '',
      balance: 0,
    });

    const result = await addAdvancedAccount(
      {
        address: CUSTOM_ADDRESS,
        chainId: '0',
        walletPubSet: new Set([KEY_A]),
      },
      { fetchGuard, storage },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not-key-guarded');

    const persisted = deserializeVault(
      (await storage.get(VAULT_KEY)) as string,
    );
    expect(persisted.advancedAccounts ?? []).toHaveLength(0);
  });

  it('rejects an absent account as account-not-found, DISTINCT from not-key-guarded', async () => {
    const storage = await seedStorage();
    const fetchGuard = stubGuard({
      exists: false,
      isKeyset: false,
      keys: [],
      pred: '',
      balance: 0,
    });

    const result = await addAdvancedAccount(
      {
        address: CUSTOM_ADDRESS,
        chainId: '0',
        walletPubSet: new Set([KEY_A]),
      },
      { fetchGuard, storage },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('account-not-found');
    expect(result.reason).not.toBe('not-key-guarded');

    const persisted = deserializeVault(
      (await storage.get(VAULT_KEY)) as string,
    );
    expect(persisted.advancedAccounts ?? []).toHaveLength(0);
  });

  it('treats a k: account already derived in the wallet as a no-op already-derived rejection', async () => {
    const storage = await seedStorage();
    const fetchGuard: FetchGuardFn = neverCalledGuard();

    const result = await addAdvancedAccount(
      {
        // k: address whose pubkey is the wallet's own derived KEY_A.
        address: `k:${KEY_A}`,
        chainId: '0',
        walletPubSet: new Set([KEY_A]),
      },
      { fetchGuard, storage },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('already-derived');
    // No guard fetch and nothing persisted for an account the wallet already has.
    expect(fetchGuard).not.toHaveBeenCalled();
    const persisted = deserializeVault(
      (await storage.get(VAULT_KEY)) as string,
    );
    expect(persisted.advancedAccounts ?? []).toHaveLength(0);
  });

  it('forces watch-only when the predicate is unrecognized, surfacing predicateRecognized:false even if keys-all fallback would satisfy', async () => {
    const storage = await seedStorage();
    // Unknown predicate over a single wallet-held key: the SDK keys-all
    // fallback makes `satisfied` true, but predicateRecognized===false must
    // override to watch-only so the UI warns.
    const fetchGuard = stubGuard(keysetGuard([KEY_A], 'totally-made-up-pred'));

    const result = await addAdvancedAccount(
      {
        address: CUSTOM_ADDRESS,
        chainId: '0',
        walletPubSet: new Set([KEY_A]),
      },
      { fetchGuard, storage },
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.mode !== 'watch-only') {
      throw new Error('expected a watch-only result');
    }
    expect(result.predicateRecognized).toBe(false);
    expect(result.account.mode).toBe('watch-only');
    expect(result.account.guardSummary?.predicateRecognized).toBe(false);
  });

  it('propagates an invalid address as invalid-address with nothing persisted', async () => {
    const storage = await seedStorage();
    const fetchGuard: FetchGuardFn = neverCalledGuard();

    const result = await addAdvancedAccount(
      { address: '', chainId: '0', walletPubSet: new Set([KEY_A]) },
      { fetchGuard, storage },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-address');
    expect(fetchGuard).not.toHaveBeenCalled();
  });
});
