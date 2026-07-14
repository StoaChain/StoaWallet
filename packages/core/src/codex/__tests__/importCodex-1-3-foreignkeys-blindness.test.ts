import { describe, expect, it, vi } from 'vitest';

import { importCodex, type ImportCodexDeps } from '../importCodex';
import type { EncryptedBlob } from '../../keyring';

const PUB_A = 'a'.repeat(64);
const PUB_B = 'b'.repeat(64);
const PUB_C = 'c'.repeat(64);

/**
 * StoaWallet's minimal-slice reader is TOTALLY BLIND to the 1.3 `foreignKeys`
 * keyring block. importCodex consumes ONLY `kadenaWallets` + `pureKeypairs`; it
 * never reads, imports, or leaks `foreignKeys`.
 *
 * D1's T5.3 asserted this against a PLACEHOLDER foreignKeys shape. This upgrades
 * the assertion to the REAL T6.3 wire shape — the canonical
 * `{ schemaVersion, keys: [{ id, label, chainId, encryptedKeyfile }] }` block that
 * codex-core now emits. A POPULATED real block carrying an encrypted keyfile must
 * change NOTHING about the import: the result is byte-identical to the same export
 * WITHOUT the block, and no keyfile ciphertext leaks into the outcome.
 *
 * Mirrors importCodex.test.ts's makeDeps()/exportJson() pattern so an imported
 * seed/key is byte-for-byte reproducible for deep-equal.
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

/** A 1.3 export with the minimal importable slice; `over` injects extra fields. */
function exportJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: '1.3',
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

// The REAL T6.3 foreignKeys wire shape: a canonical ForeignKeysBlock carrying a
// populated ForeignKeyEntry. The `encryptedKeyfile` is a distinctive ciphertext
// marker — the blindness proof asserts it NEVER surfaces in the import outcome.
const FOREIGN_KEYFILE_CIPHERTEXT = 'enc:AR-keyfile-MUST-NOT-LEAK-7c1e';
const REAL_FOREIGN_KEYS_BLOCK = {
  schemaVersion: 1,
  keys: [
    {
      id: 'fk-ar-1',
      label: 'Arweave main',
      chainId: 'arweave:mainnet',
      encryptedKeyfile: FOREIGN_KEYFILE_CIPHERTEXT,
    },
  ],
};

describe('importCodex — 1.3 foreignKeys blindness (real T6.3 shape)', () => {
  it('imports a 1.3 export carrying a POPULATED real foreignKeys block BYTE-IDENTICAL to one without it', async () => {
    // The minimal-slice reader reads only kadenaWallets + pureKeypairs, TOTALLY
    // blind to foreignKeys. A populated real keyring block must change NOTHING —
    // same wallets, same pure keypairs, same summary.
    const withoutForeign = await importCodex(exportJson(), makeDeps());
    const withForeign = await importCodex(
      exportJson({ foreignKeys: REAL_FOREIGN_KEYS_BLOCK }),
      makeDeps(),
    );

    expect(withoutForeign.ok).toBe(true);
    expect(withForeign.ok).toBe(true);
    if (!withoutForeign.ok || !withForeign.ok) return;
    expect(withForeign.wallets).toEqual(withoutForeign.wallets);
    expect(withForeign.pureKeypairs).toEqual(withoutForeign.pureKeypairs);
    expect(withForeign.merges).toEqual(withoutForeign.merges);
    expect(withForeign.summary).toEqual(withoutForeign.summary);
  });

  it('returns ok:true and never leaks the encryptedKeyfile ciphertext into the outcome', async () => {
    // No throw, no read, no leak: the funds-critical keyfile ciphertext present in
    // the export must NOT appear anywhere in the serialized import result.
    const res = await importCodex(
      exportJson({ foreignKeys: REAL_FOREIGN_KEYS_BLOCK }),
      makeDeps(),
    );
    expect(res.ok).toBe(true);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(FOREIGN_KEYFILE_CIPHERTEXT);
    expect(serialized).not.toContain('AR-keyfile');
    expect(serialized).not.toContain('arweave:mainnet');
    expect(serialized).not.toContain('fk-ar-1');
  });

  it('never runs the decrypt seam over the foreignKeys keyfile ciphertext', async () => {
    // Blindness at the crypto boundary: the reader must never even hand the
    // foreign keyfile to decrypt — it consumes only kadenaWallets + pureKeypairs.
    const deps = makeDeps();
    await importCodex(exportJson({ foreignKeys: REAL_FOREIGN_KEYS_BLOCK }), deps);
    expect(deps.decrypt).not.toHaveBeenCalledWith(FOREIGN_KEYFILE_CIPHERTEXT);
    // The two real importable secrets ARE still decrypted — blindness is scoped to
    // foreignKeys, not a blanket skip.
    expect(deps.decrypt).toHaveBeenCalledWith('enc:word word word');
    expect(deps.decrypt).toHaveBeenCalledWith('enc:priv-c');
  });

  it('tolerates an EMPTY real foreignKeys block identically to omission (empty distinct from populated)', async () => {
    const withEmpty = await importCodex(
      exportJson({ foreignKeys: { schemaVersion: 1, keys: [] } }),
      makeDeps(),
    );
    const without = await importCodex(exportJson(), makeDeps());
    expect(withEmpty.ok).toBe(true);
    expect(without.ok).toBe(true);
    if (!withEmpty.ok || !without.ok) return;
    expect(withEmpty.wallets).toEqual(without.wallets);
    expect(withEmpty.pureKeypairs).toEqual(without.pureKeypairs);
    expect(withEmpty.summary).toEqual(without.summary);
  });
});
