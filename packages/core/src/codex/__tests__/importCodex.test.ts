import { describe, expect, it, vi } from 'vitest';

import { importCodex, type ImportCodexDeps } from '../importCodex';
import type { EncryptedBlob } from '../../keyring';

const PUB_A = 'a'.repeat(64);
const PUB_B = 'b'.repeat(64);
const PUB_C = 'c'.repeat(64);

/**
 * A deterministic deps double: `decrypt` peels a `enc:` prefix (so the test asserts
 * the codex blob was decrypted), the re-encrypt seams wrap with `wpw:` (so the
 * test asserts re-sealing at the wallet password), ids are a counter, time fixed.
 */
function makeDeps(over: Partial<ImportCodexDeps> = {}): ImportCodexDeps {
  let n = 0;
  return {
    decrypt: vi.fn(async (blob: string) => blob.replace(/^enc:/, '')),
    encryptPhrase: vi.fn(async (m: string) => `wpw:${m}` as EncryptedBlob),
    encryptPrivateKey: vi.fn(async (k: string) => `wpw:${k}`),
    existingPubKeys: new Set<string>(),
    existingWallets: [],
    genId: (kind) => `${kind}-${n++}`,
    now: () => '2026-06-15T00:00:00.000Z',
    ...over,
  };
}

function exportJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: '1.2',
    kadenaWallets: [
      {
        id: 'seed-1',
        name: 'My Koala',
        seedType: 'koala',
        secret: 'enc:word word word',
        accounts: [
          { index: 0, publicKey: PUB_A, derivationPath: "m'/44'/626'/0'" },
          { index: 1, publicKey: PUB_B, derivationPath: "m'/44'/626'/1'" },
        ],
      },
    ],
    pureKeypairs: [
      { id: 'pk-1', label: 'Cold key', publicKey: PUB_C, encryptedPrivateKey: 'enc:priv-c' },
    ],
    ...over,
  });
}

describe('importCodex', () => {
  it('decrypts each seed mnemonic at the codex password and re-seals it at the wallet password', async () => {
    const deps = makeDeps();
    const res = await importCodex(exportJson(), deps);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(deps.decrypt).toHaveBeenCalledWith('enc:word word word');
    const wallet = res.wallets[0];
    expect(wallet.seedType).toBe('koala');
    expect(wallet.name).toBe('My Koala');
    // The mnemonic was decrypted (peeled) then re-sealed at the wallet password.
    expect(wallet.encryptedPhrase).toBe('wpw:word word word');
    // Accounts map to k: addresses derived from the codex public keys.
    expect(wallet.accounts).toEqual([
      { index: 0, publicKey: PUB_A, account: `k:${PUB_A}`, derivationPath: "m'/44'/626'/0'" },
      { index: 1, publicKey: PUB_B, account: `k:${PUB_B}`, derivationPath: "m'/44'/626'/1'" },
    ]);
  });

  it('re-seals each pure keypair private key at the wallet password', async () => {
    const deps = makeDeps();
    const res = await importCodex(exportJson(), deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pureKeypairs).toEqual([
      {
        id: 'key-1',
        label: 'Cold key',
        publicKey: PUB_C,
        encryptedPrivateKey: 'wpw:priv-c',
        createdAt: '2026-06-15T00:00:00.000Z',
      },
    ]);
    expect(res.summary).toEqual({
      seedsImported: 1,
      accountsImported: 2,
      keysImported: 1,
      skipped: 0,
    });
  });

  it('preserves the EXACT codex seed name, and only falls back when the codex stored none', async () => {
    // Named seed → imported under that exact name.
    const named = await importCodex(
      exportJson({
        kadenaWallets: [
          {
            id: 's',
            name: 'Treasury (cold)',
            seedType: 'koala',
            secret: 'enc:m',
            accounts: [{ index: 0, publicKey: PUB_A, derivationPath: 'p' }],
          },
        ],
        pureKeypairs: [],
      }),
      makeDeps(),
    );
    expect(named.ok).toBe(true);
    if (named.ok) expect(named.wallets[0].name).toBe('Treasury (cold)');

    // No name in the codex → a descriptive fallback (only then).
    const unnamed = await importCodex(
      exportJson({
        kadenaWallets: [
          {
            id: 's',
            seedType: 'chainweaver',
            secret: 'enc:m',
            accounts: [{ index: 0, publicKey: PUB_B, derivationPath: 'p' }],
          },
        ],
        pureKeypairs: [],
      }),
      makeDeps(),
    );
    expect(unnamed.ok).toBe(true);
    if (unnamed.ok) expect(unnamed.wallets[0].name).toBe('Imported chainweaver seed');
  });

  it('imports chainweaver / eckowallet seeds (not just koala)', async () => {
    const deps = makeDeps();
    const res = await importCodex(
      exportJson({
        kadenaWallets: [
          {
            id: 's',
            seedType: 'chainweaver',
            secret: 'enc:cw',
            accounts: [{ index: 0, publicKey: PUB_A, derivationPath: 'p' }],
          },
        ],
        pureKeypairs: [],
      }),
      deps,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.wallets[0].seedType).toBe('chainweaver');
  });

  it('is IDEMPOTENT — re-importing the SAME seed (same name, same accounts) adds nothing', async () => {
    const deps = makeDeps({
      existingWallets: [
        { id: 'w', name: 'My Koala', accountPubKeys: [PUB_A, PUB_B] },
      ],
    });
    const res = await importCodex(exportJson({ pureKeypairs: [] }), deps);
    // Same seed, same name, all accounts present → nothing to add.
    expect(res).toEqual({ ok: false, reason: 'no-importable-content' });
  });

  it('MERGES a same-seed codex (shared pubkey) into the existing wallet instead of duplicating', async () => {
    // The vault already has this seed but only account #0 (PUB_A). The codex has
    // #0 + #1 (PUB_A, PUB_B) AND a different name → merge #1 in + adopt the name.
    const deps = makeDeps({
      existingWallets: [{ id: 'wallet-1', name: 'Wallet 1', accountPubKeys: [PUB_A] }],
    });
    const res = await importCodex(exportJson({ pureKeypairs: [] }), deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // No NEW seed — it folded into the existing wallet.
    expect(res.wallets).toHaveLength(0);
    expect(res.merges).toHaveLength(1);
    expect(res.merges[0].walletId).toBe('wallet-1');
    expect(res.merges[0].name).toBe('My Koala'); // adopts the codex name
    expect(res.merges[0].accounts.map((a) => a.index)).toEqual([1]); // only the new one
    expect(res.summary).toMatchObject({ seedsImported: 0, accountsImported: 1 });
    // The mnemonic is NOT re-decrypted for a merge — the existing wallet has it.
    expect(deps.decrypt).not.toHaveBeenCalledWith('enc:word word word');
  });

  it('normalizes the legacy prime name "Initial Seed" → "Prime Codex Seed"', async () => {
    const byName = await importCodex(
      exportJson({
        kadenaWallets: [
          {
            id: 's',
            name: 'Initial Seed',
            seedType: 'koala',
            secret: 'enc:m',
            accounts: [{ index: 0, publicKey: PUB_A, derivationPath: 'p' }],
          },
        ],
        pureKeypairs: [],
      }),
      makeDeps(),
    );
    expect(byName.ok).toBe(true);
    if (byName.ok) expect(byName.wallets[0].name).toBe('Prime Codex Seed');

    // Also via the isPrime flag (codices that already carry it).
    const byFlag = await importCodex(
      exportJson({
        kadenaWallets: [
          {
            id: 's',
            name: 'Whatever',
            isPrime: true,
            seedType: 'koala',
            secret: 'enc:m',
            accounts: [{ index: 0, publicKey: PUB_B, derivationPath: 'p' }],
          },
        ],
        pureKeypairs: [],
      }),
      makeDeps(),
    );
    expect(byFlag.ok).toBe(true);
    if (byFlag.ok) expect(byFlag.wallets[0].name).toBe('Prime Codex Seed');
  });

  it('skips a pure key already present but still imports new seeds', async () => {
    const deps = makeDeps({ existingPubKeys: new Set([PUB_C]) });
    const res = await importCodex(exportJson(), deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pureKeypairs).toHaveLength(0);
    expect(res.wallets).toHaveLength(1);
    expect(res.summary.skipped).toBe(1);
  });

  it('maps a decrypt rejection (wrong codex password / tampered blob) to wrong-codex-password — never throws', async () => {
    const deps = makeDeps({
      decrypt: vi.fn(async () => {
        throw new Error('AES-GCM auth tag mismatch');
      }),
    });
    await expect(importCodex(exportJson(), deps)).resolves.toEqual({
      ok: false,
      reason: 'wrong-codex-password',
    });
  });

  it('rejects a non-1.2 version loudly', async () => {
    const res = await importCodex(exportJson({ version: '2.0' }), makeDeps());
    expect(res).toEqual({ ok: false, reason: 'unsupported-version', version: '2.0' });
  });

  it('rejects malformed JSON', async () => {
    expect(await importCodex('{ not json', makeDeps())).toEqual({
      ok: false,
      reason: 'invalid-json',
    });
  });

  it('drops seeds with an unknown seedType or no valid accounts (never imports garbage)', async () => {
    const deps = makeDeps();
    const res = await importCodex(
      exportJson({
        kadenaWallets: [
          { id: 'bad', seedType: 'nonsense', secret: 'enc:x', accounts: [] },
          {
            id: 'ok',
            seedType: 'koala',
            secret: 'enc:good',
            accounts: [{ index: 0, publicKey: PUB_A, derivationPath: 'p' }],
          },
        ],
        pureKeypairs: [],
      }),
      deps,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.wallets).toHaveLength(1);
    expect(res.wallets[0].id).toBe('wallet-0');
    expect(res.summary.skipped).toBe(1);
  });
});
