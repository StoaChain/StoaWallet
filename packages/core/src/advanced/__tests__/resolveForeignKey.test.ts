import { afterEach, describe, expect, it, vi } from 'vitest';

import { smartDecrypt } from '@stoachain/stoa-core/crypto';
import { tryDerivePublicKey } from '@stoachain/stoa-core/guard';

import { deriveAccount } from '../../api/derive';
import { encryptPureKeypair } from '../pastedKey';
import { InMemoryStorageAdapter } from '../../testing';
import { VAULT_KEY } from '../../storage/storageKeys';
import {
  serializeVault,
  deserializeVault,
  type AdvancedAccount,
  type StoredAccount,
  type Vault,
} from '../../keyring/vault';
import {
  resolveAdvancedSigningKeypairs,
  resolveForeignKey,
} from '../resolveForeignKey';

/**
 * Fixed 24-word koala mnemonic + password (same fixture style as derive.test).
 * NEVER logged — determinism is what lets us re-derive in-wallet signing keys.
 */
const TEST_MNEMONIC =
  'flat portion other shield engine fly original desert network riot shop own evidence august belt steel into embody bounce parrot naive cruel word gown';
const TEST_PASSWORD = 'correct horse battery staple';

// Two raw foreign Ed25519 seeds. Their public keys are derived with the REAL SDK
// so the tests pin derivation behavior, not guessed constants.
const FOREIGN_KEY_A = '1'.repeat(64);
const FOREIGN_PUB_A = tryDerivePublicKey(FOREIGN_KEY_A) as string;
const FOREIGN_KEY_B = '2'.repeat(64);
const FOREIGN_PUB_B = tryDerivePublicKey(FOREIGN_KEY_B) as string;

// A pubkey nobody in this suite holds the private key for — used to make guards
// unsatisfiable or to force key-mismatch.
const STRANGER_PUB = 'f'.repeat(64);

/** Build a minimal StoredAccount for an in-wallet derived key. */
function storedAccountFor(index: number, publicKey: string): StoredAccount {
  return {
    index,
    publicKey,
    account: `k:${publicKey}`,
    derivationPath: `m'/44'/626'/${index}'`,
  };
}

/** Persist a vault blob (plain JSON — these tests do not encrypt the vault). */
async function writeVault(storage: InMemoryStorageAdapter, vault: Vault) {
  await storage.set(VAULT_KEY, serializeVault(vault));
}

async function readVault(storage: InMemoryStorageAdapter): Promise<Vault> {
  const raw = (await storage.get(VAULT_KEY)) as string;
  return deserializeVault(raw);
}

function watchOnlyAccount(
  guardKeys: string[],
  threshold: number,
  pred = 'keys-all',
): AdvancedAccount {
  return {
    id: 'acc-1',
    address: 'c:custom-guard-account',
    type: 'custom-account',
    mode: 'watch-only',
    guardSummary: {
      pred,
      threshold,
      neededMore: threshold,
      predicateRecognized: true,
      keys: guardKeys,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveForeignKey — paste completes a 1-of-1-missing guard', () => {
  it('persists the encrypted key and transitions the account to send-capable', async () => {
    const storage = new InMemoryStorageAdapter();
    // 1-of-1 guard whose single key is the foreign key (not in the wallet pub set).
    const guard = { keys: [FOREIGN_PUB_A], pred: 'keys-any' };
    const account = watchOnlyAccount([FOREIGN_PUB_A], 1, 'keys-any');
    await writeVault(storage, {
      wallets: [],
      activeWalletId: '',
      pureKeypairs: [],
      advancedAccounts: [account],
    });

    const result = await resolveForeignKey(
      {
        account,
        privateKey: FOREIGN_KEY_A,
        walletPubSet: new Set<string>(), // wallet itself holds none of the guard keys
        walletPassword: TEST_PASSWORD,
        freshGuard: guard,
      },
      { storage },
    );

    expect(result).toEqual({ ok: true, mode: 'send-capable' });

    const vault = await readVault(storage);
    // The pasted key was encrypted and persisted exactly once.
    expect(vault.pureKeypairs).toHaveLength(1);
    expect(vault.pureKeypairs?.[0].publicKey).toBe(FOREIGN_PUB_A);
    // Decryptable back to the original key under the wallet password.
    await expect(
      smartDecrypt(vault.pureKeypairs![0].encryptedPrivateKey, TEST_PASSWORD),
    ).resolves.toBe(FOREIGN_KEY_A);
    // The account flipped to send-capable in the persisted vault.
    expect(vault.advancedAccounts?.[0].mode).toBe('send-capable');
  });
});

describe('resolveForeignKey — paste on a 2-of-3 guard still one short', () => {
  it('persists the key, stays watch-only, and decrements neededMore by exactly one', async () => {
    const storage = new InMemoryStorageAdapter();
    // 2-of-3: wallet holds none yet; one foreign paste leaves it still 1 short.
    const guard = {
      keys: [FOREIGN_PUB_A, FOREIGN_PUB_B, STRANGER_PUB],
      pred: 'keys-2',
    };
    const account = watchOnlyAccount(guard.keys, 2, 'keys-2');
    await writeVault(storage, {
      wallets: [],
      activeWalletId: '',
      pureKeypairs: [],
      advancedAccounts: [account],
    });

    const result = await resolveForeignKey(
      {
        account,
        privateKey: FOREIGN_KEY_A,
        walletPubSet: new Set<string>(),
        walletPassword: TEST_PASSWORD,
        freshGuard: guard,
      },
      { storage },
    );

    // One key resolved against a threshold of 2 → still needs one more.
    expect(result).toEqual({ ok: true, mode: 'watch-only', neededMore: 1 });

    const vault = await readVault(storage);
    expect(vault.pureKeypairs).toHaveLength(1);
    // Account must NOT be promoted while the guard is unsatisfied.
    expect(vault.advancedAccounts?.[0].mode).toBe('watch-only');
  });

  it('counts the newly pasted key EXACTLY ONCE (single re-analysis channel)', async () => {
    // Regression guard for RR#4: the key must be counted once via the rebuilt
    // pub set, NOT a second time via a transient resolvedManualKeys preview. A
    // double count would (wrongly) satisfy a 2-of-3 from a single paste.
    const storage = new InMemoryStorageAdapter();
    const guard = {
      keys: [FOREIGN_PUB_A, FOREIGN_PUB_B, STRANGER_PUB],
      pred: 'keys-2',
    };
    const account = watchOnlyAccount(guard.keys, 2, 'keys-2');
    await writeVault(storage, {
      wallets: [],
      activeWalletId: '',
      pureKeypairs: [],
      advancedAccounts: [account],
    });

    const result = await resolveForeignKey(
      {
        account,
        privateKey: FOREIGN_KEY_A,
        walletPubSet: new Set<string>(),
        walletPassword: TEST_PASSWORD,
        freshGuard: guard,
      },
      { storage },
    );

    // If the key were double counted, signable would be 2 and mode send-capable.
    expect(result).toEqual({ ok: true, mode: 'watch-only', neededMore: 1 });
  });
});

describe('resolveForeignKey — validation failures persist nothing', () => {
  it('returns key-mismatch and writes no key when the paste derives outside the guard', async () => {
    const storage = new InMemoryStorageAdapter();
    const guard = { keys: [STRANGER_PUB], pred: 'keys-any' };
    const account = watchOnlyAccount([STRANGER_PUB], 1, 'keys-any');
    await writeVault(storage, {
      wallets: [],
      activeWalletId: '',
      pureKeypairs: [],
      advancedAccounts: [account],
    });

    const result = await resolveForeignKey(
      {
        account,
        privateKey: FOREIGN_KEY_A, // derives to FOREIGN_PUB_A, not in the guard
        walletPubSet: new Set<string>(),
        walletPassword: TEST_PASSWORD,
        freshGuard: guard,
      },
      { storage },
    );

    expect(result).toEqual({ ok: false, reason: 'key-mismatch' });

    const vault = await readVault(storage);
    // Nothing persisted, no transition on a rejected paste.
    expect(vault.pureKeypairs ?? []).toHaveLength(0);
    expect(vault.advancedAccounts?.[0].mode).toBe('watch-only');
  });

  it('returns bad-format and persists nothing for a malformed paste', async () => {
    const storage = new InMemoryStorageAdapter();
    const guard = { keys: [FOREIGN_PUB_A], pred: 'keys-any' };
    const account = watchOnlyAccount([FOREIGN_PUB_A], 1, 'keys-any');
    await writeVault(storage, {
      wallets: [],
      activeWalletId: '',
      pureKeypairs: [],
      advancedAccounts: [account],
    });

    const result = await resolveForeignKey(
      {
        account,
        privateKey: 'not-a-hex-key',
        walletPubSet: new Set<string>(),
        walletPassword: TEST_PASSWORD,
        freshGuard: guard,
      },
      { storage },
    );

    expect(result).toEqual({ ok: false, reason: 'bad-format' });
    const vault = await readVault(storage);
    expect(vault.pureKeypairs ?? []).toHaveLength(0);
  });

  it('refuses with guard-changed when the fresh keyset no longer contains the stored guard keys', async () => {
    // RR#5: re-fetch before validation. If the on-chain keyset rotated away from
    // what the account recorded, the resolution must refuse rather than persist
    // a key against a stale guard.
    const storage = new InMemoryStorageAdapter();
    const account = watchOnlyAccount([FOREIGN_PUB_A], 1, 'keys-any');
    await writeVault(storage, {
      wallets: [],
      activeWalletId: '',
      pureKeypairs: [],
      advancedAccounts: [account],
    });

    const result = await resolveForeignKey(
      {
        account,
        privateKey: FOREIGN_KEY_A,
        walletPubSet: new Set<string>(),
        walletPassword: TEST_PASSWORD,
        // Fresh guard rotated to an entirely different keyset.
        freshGuard: { keys: [STRANGER_PUB], pred: 'keys-any' },
      },
      { storage },
    );

    expect(result).toEqual({ ok: false, reason: 'guard-changed' });
    const vault = await readVault(storage);
    expect(vault.pureKeypairs ?? []).toHaveLength(0);
    expect(vault.advancedAccounts?.[0].mode).toBe('watch-only');
  });
});

describe('resolveAdvancedSigningKeypairs — assemble the signing set', () => {
  it('resolves BOTH a derived in-wallet key and a decrypted pure key for a satisfied 2-of-2 guard', async () => {
    // Derive a real in-wallet account; its pubkey is one guard key, a foreign
    // pure key is the other. A 2-of-2 needs both → both must be assembled.
    const derived = await deriveAccount(TEST_MNEMONIC, TEST_PASSWORD, 0);
    const pureRecord = await encryptPureKeypair(
      FOREIGN_KEY_A,
      FOREIGN_PUB_A,
      TEST_PASSWORD,
    );

    const guard = { keys: [derived.publicKey, FOREIGN_PUB_A], pred: 'keys-all' };
    const account = watchOnlyAccount(guard.keys, 2);
    const vault: Vault = {
      wallets: [
        {
          id: 'w-1',
          name: 'Main',
          encryptedPhrase: 'enc' as never,
          accounts: [storedAccountFor(0, derived.publicKey)],
          activeAccountIndex: 0,
          seedType: 'koala',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      activeWalletId: 'w-1',
      pureKeypairs: [pureRecord],
      advancedAccounts: [account],
    };

    const result = await resolveAdvancedSigningKeypairs(
      account,
      guard,
      vault,
      TEST_MNEMONIC,
      TEST_PASSWORD,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The keypair SET covers both guard keys.
    const pubs = new Set(result.keypairs.map((k) => k.publicKey));
    expect(pubs.has(derived.publicKey)).toBe(true);
    expect(pubs.has(FOREIGN_PUB_A)).toBe(true);

    // The decrypted pure key is the real private key, carried transiently.
    const pureKp = result.keypairs.find((k) => k.publicKey === FOREIGN_PUB_A);
    expect(pureKp?.privateKey).toBe(FOREIGN_KEY_A);

    // Deterministic gas-payer cap-signer: the in-wallet derived key (the only one
    // NOT in the pure-signing set) is the eligible cap signer.
    expect(result.gasPayerSigner.publicKey).toBe(derived.publicKey);
  });

  it('decrypts the derived in-wallet key to a SIGN-READY raw private key + seedType:koala (F-001)', async () => {
    // F-001: a derived guard key must be handed to the signer as a decrypted raw
    // privateKey + seedType:'koala' (the nacl route), NOT as an undecrypted
    // encryptedSecretKey envelope (which would sign with an empty secret).
    const derived = await deriveAccount(TEST_MNEMONIC, TEST_PASSWORD, 0);
    const guard = { keys: [derived.publicKey], pred: 'keys-any' };
    const account = watchOnlyAccount([derived.publicKey], 1, 'keys-any');
    const vault: Vault = {
      wallets: [
        {
          id: 'w-1',
          name: 'Main',
          encryptedPhrase: 'enc' as never,
          accounts: [storedAccountFor(0, derived.publicKey)],
          activeAccountIndex: 0,
          seedType: 'koala',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      activeWalletId: 'w-1',
      pureKeypairs: [],
      advancedAccounts: [account],
    };

    const result = await resolveAdvancedSigningKeypairs(
      account,
      guard,
      vault,
      TEST_MNEMONIC,
      TEST_PASSWORD,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const derivedKp = result.keypairs.find(
      (k) => k.publicKey === derived.publicKey,
    );
    // Sign-ready shape: a 64-char hex raw private key tagged koala — NOT an
    // encrypted envelope, NOT an empty/undefined secret.
    expect(derivedKp?.seedType).toBe('koala');
    expect(derivedKp?.privateKey).toMatch(/^[0-9a-f]{64}$/i);
    expect(derivedKp?.encryptedSecretKey).toBeUndefined();
  });

  it('the resolved derived keypair signs a real tx with a non-empty signature (F-001)', async () => {
    // End-to-end: the assembled keypair must actually SIGN via the same signer the
    // send path uses. An undecrypted/empty secret (the F-001 bug) produces no
    // signature; a real 128-char Ed25519 sig proves the secret was decrypted.
    const { signTx } = await import('../../api/sign');
    const { Pact } = await import('@stoachain/kadena-stoic-legacy/client');
    const derived = await deriveAccount(TEST_MNEMONIC, TEST_PASSWORD, 0);
    const guard = { keys: [derived.publicKey], pred: 'keys-any' };
    const account = watchOnlyAccount([derived.publicKey], 1, 'keys-any');
    const vault: Vault = {
      wallets: [
        {
          id: 'w-1',
          name: 'Main',
          encryptedPhrase: 'enc' as never,
          accounts: [storedAccountFor(0, derived.publicKey)],
          activeAccountIndex: 0,
          seedType: 'koala',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      activeWalletId: 'w-1',
      pureKeypairs: [],
      advancedAccounts: [account],
    };

    const result = await resolveAdvancedSigningKeypairs(
      account,
      guard,
      vault,
      TEST_MNEMONIC,
      TEST_PASSWORD,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // A real unsigned command whose single signer is the derived pubkey, so the
    // SDK signer attaches a signature for the assembled keypair.
    const unsigned = Pact.builder
      .execution('(coin.details "k:abc")')
      .addSigner(derived.publicKey)
      .setMeta({ chainId: '0', senderAccount: derived.account })
      .setNetworkId('testnet04')
      .createTransaction();

    const signed = await signTx(unsigned, result.gasPayerSigner);

    // A populated 128-char hex Ed25519 signature — proves a non-empty secret.
    expect(signed.sigs).toHaveLength(1);
    expect(signed.sigs[0]?.sig).toMatch(/^[0-9a-f]{128}$/);
  });

  it('refuses with impossible-overlap when the only eligible cap-signer is a pure-signing key', async () => {
    // RR#1: a 1-of-1 guard whose single key is the foreign pure key. The payment
    // key pub IS in the pure-signing set and no Codex key is free → selectCaps
    // returns impossible. We must NOT hand a null cap-signer to a send path.
    const pureRecord = await encryptPureKeypair(
      FOREIGN_KEY_A,
      FOREIGN_PUB_A,
      TEST_PASSWORD,
    );
    const guard = { keys: [FOREIGN_PUB_A], pred: 'keys-any' };
    const account: AdvancedAccount = {
      ...watchOnlyAccount([FOREIGN_PUB_A], 1, 'keys-any'),
      // k-account whose payment pubkey equals the pure-signing key.
      type: 'k-account',
      address: `k:${FOREIGN_PUB_A}`,
    };
    const vault: Vault = {
      wallets: [],
      activeWalletId: '',
      pureKeypairs: [pureRecord],
      advancedAccounts: [account],
    };

    const result = await resolveAdvancedSigningKeypairs(
      account,
      guard,
      vault,
      TEST_MNEMONIC,
      TEST_PASSWORD,
    );

    expect(result).toEqual({ ok: false, reason: 'impossible-overlap' });
  });

  it('refuses with insufficient-keys (never throws) when the account has no recorded guard threshold', async () => {
    // Defensive: a malformed advanced account with no guardSummary must produce a
    // discriminated refusal, not a thrown error in a key-material-bearing path.
    const derived = await deriveAccount(TEST_MNEMONIC, TEST_PASSWORD, 0);
    const guard = { keys: [derived.publicKey], pred: 'keys-any' };
    const account: AdvancedAccount = {
      id: 'acc-x',
      address: `k:${derived.publicKey}`,
      type: 'k-account',
      mode: 'watch-only',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const vault: Vault = {
      wallets: [
        {
          id: 'w-1',
          name: 'Main',
          encryptedPhrase: 'enc' as never,
          accounts: [storedAccountFor(0, derived.publicKey)],
          activeAccountIndex: 0,
          seedType: 'koala',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      activeWalletId: 'w-1',
      pureKeypairs: [],
      advancedAccounts: [account],
    };

    const result = await resolveAdvancedSigningKeypairs(
      account,
      guard,
      vault,
      TEST_MNEMONIC,
      TEST_PASSWORD,
    );

    expect(result).toEqual({ ok: false, reason: 'insufficient-keys' });
  });

  it('refuses with insufficient-keys when the guard cannot be assembled from available keypairs', async () => {
    // A 2-of-2 guard where one key (STRANGER_PUB) has no derivable/decryptable
    // private key anywhere → unsatisfiable → never an unsignable tx.
    const derived = await deriveAccount(TEST_MNEMONIC, TEST_PASSWORD, 0);
    const guard = { keys: [derived.publicKey, STRANGER_PUB], pred: 'keys-all' };
    const account = watchOnlyAccount(guard.keys, 2);
    const vault: Vault = {
      wallets: [
        {
          id: 'w-1',
          name: 'Main',
          encryptedPhrase: 'enc' as never,
          accounts: [storedAccountFor(0, derived.publicKey)],
          activeAccountIndex: 0,
          seedType: 'koala',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      activeWalletId: 'w-1',
      pureKeypairs: [],
      advancedAccounts: [account],
    };

    const result = await resolveAdvancedSigningKeypairs(
      account,
      guard,
      vault,
      TEST_MNEMONIC,
      TEST_PASSWORD,
    );

    expect(result).toEqual({ ok: false, reason: 'insufficient-keys' });
  });
});

describe('never-log-secrets — full resolve→encrypt→persist→sign-key cycle', () => {
  it('emits no console output containing the pasted key, decrypted key, mnemonic, or password', async () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'debug').mockImplementation(() => {}),
    ];

    const storage = new InMemoryStorageAdapter();
    const derived = await deriveAccount(TEST_MNEMONIC, TEST_PASSWORD, 0);
    const guard = { keys: [derived.publicKey, FOREIGN_PUB_A], pred: 'keys-all' };
    const account = watchOnlyAccount(guard.keys, 2);
    const vault: Vault = {
      wallets: [
        {
          id: 'w-1',
          name: 'Main',
          encryptedPhrase: 'enc' as never,
          accounts: [storedAccountFor(0, derived.publicKey)],
          activeAccountIndex: 0,
          seedType: 'koala',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      activeWalletId: 'w-1',
      pureKeypairs: [],
      advancedAccounts: [account],
    };
    await writeVault(storage, vault);

    await resolveForeignKey(
      {
        account,
        privateKey: FOREIGN_KEY_A,
        walletPubSet: new Set<string>([derived.publicKey]),
        walletPassword: TEST_PASSWORD,
        freshGuard: guard,
      },
      { storage },
    );

    const persisted = await readVault(storage);
    await resolveAdvancedSigningKeypairs(
      account,
      guard,
      persisted,
      TEST_MNEMONIC,
      TEST_PASSWORD,
    );

    const allOutput = spies
      .flatMap((s) => s.mock.calls)
      .flat()
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join('\n');

    expect(allOutput).not.toContain(FOREIGN_KEY_A);
    expect(allOutput).not.toContain(TEST_MNEMONIC);
    expect(allOutput).not.toContain(TEST_PASSWORD);
  });
});
