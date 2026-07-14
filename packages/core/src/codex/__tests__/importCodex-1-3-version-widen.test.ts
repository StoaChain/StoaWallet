import { describe, expect, it, vi } from 'vitest';

import { importCodex, type ImportCodexDeps } from '../importCodex';
import type { EncryptedBlob } from '../../keyring';

const PUB_A = 'a'.repeat(64);
const PUB_B = 'b'.repeat(64);
const PUB_C = 'c'.repeat(64);

/**
 * A deterministic deps double (mirrors importCodex.test.ts): `decrypt` peels an
 * `enc:` prefix, the re-encrypt seams wrap with `wpw:`, ids are a counter, time
 * fixed — so an imported seed/key is byte-for-byte reproducible for deep-equal.
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

/**
 * The shared export fixture. Same shape as importCodex.test.ts's `exportJson`, but
 * `version` defaults to '1.3' so the widened gate can be exercised; override
 * `version` (or any field) via `over`. Reused by T5.4 (GREEN) — do not rename.
 */
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

/** The exact seed + pure-key shape both a 1.2 and a 1.3 export must import to. */
const EXPECTED_WALLET = {
  id: 'wallet-0',
  name: 'My Koala',
  encryptedPhrase: 'wpw:word word word',
  accounts: [
    { index: 0, publicKey: PUB_A, account: `k:${PUB_A}`, derivationPath: "m'/44'/626'/0'" },
    { index: 1, publicKey: PUB_B, account: `k:${PUB_B}`, derivationPath: "m'/44'/626'/1'" },
  ],
  activeAccountIndex: 0,
  seedType: 'koala',
  createdAt: '2026-06-15T00:00:00.000Z',
};

const EXPECTED_PURE_KEY = {
  id: 'key-1',
  label: 'Cold key',
  publicKey: PUB_C,
  encryptedPrivateKey: 'wpw:priv-c',
  createdAt: '2026-06-15T00:00:00.000Z',
};

describe('importCodex — 1.3 version widen', () => {
  it('ACCEPTS a version:1.3 export and imports the seed + keys exactly as it does for 1.2', async () => {
    // A 1.3 export with a valid kadenaWallets/pureKeypairs slice must be accepted
    // and mapped to the same StoredWallet/IPureKeypair a 1.2 export would produce —
    // widening the gate must not alter WHAT gets imported, only WHICH versions pass.
    const res = await importCodex(exportJson({ version: '1.3' }), makeDeps());

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.wallets).toEqual([EXPECTED_WALLET]);
    expect(res.pureKeypairs).toEqual([EXPECTED_PURE_KEY]);
    expect(res.summary).toEqual({
      seedsImported: 1,
      accountsImported: 2,
      keysImported: 1,
      skipped: 0,
    });
  });

  it('FORWARD-COMPAT: a version:1.2 export STILL imports identically (no 1.2-path regression)', async () => {
    // The widen must not change the 1.2 path. Deep-equal the imported seed/key so a
    // silent drift on the still-supported legacy version is caught, not just ok:true.
    const res = await importCodex(exportJson({ version: '1.2' }), makeDeps());

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.wallets).toEqual([EXPECTED_WALLET]);
    expect(res.pureKeypairs).toEqual([EXPECTED_PURE_KEY]);
  });

  it('is BLIND to a top-level foreignKeys field — imports identically with or without it', async () => {
    // A 1.3 export may carry a `foreignKeys` top-level field this reader does not
    // consume. It must be ignored entirely: same import result as an export without
    // it — proving the reader neither reads, imports, nor leaks foreignKeys.
    const withoutForeign = await importCodex(exportJson({ version: '1.3' }), makeDeps());
    const withForeign = await importCodex(
      exportJson({
        version: '1.3',
        foreignKeys: [
          { id: 'fk-1', publicKey: 'd'.repeat(64), encryptedPrivateKey: 'enc:should-be-ignored' },
        ],
      }),
      makeDeps(),
    );

    expect(withoutForeign.ok).toBe(true);
    expect(withForeign.ok).toBe(true);
    if (!withoutForeign.ok || !withForeign.ok) return;
    // Identical vault additions → the foreignKeys field changed nothing.
    expect(withForeign.wallets).toEqual(withoutForeign.wallets);
    expect(withForeign.pureKeypairs).toEqual(withoutForeign.pureKeypairs);
    expect(withForeign.summary).toEqual(withoutForeign.summary);
    // And nothing from foreignKeys leaked into the import.
    expect(JSON.stringify(withForeign)).not.toContain('should-be-ignored');
  });

  it('FAIL-CLOSED: out-of-set STRING versions each reject with unsupported-version + that version', async () => {
    // Only the supported set widens; every other string version — including
    // whitespace/near-miss look-alikes of "1.3" — must still reject loudly, echoing
    // the offending version (and nothing else) for a precise user-facing error.
    const outOfSet = ['1.1', '1.4', '2.0', ' 1.3 ', '1.3.0', '1.30'];
    for (const version of outOfSet) {
      const res = await importCodex(exportJson({ version }), makeDeps());
      expect(res).toEqual({ ok: false, reason: 'unsupported-version', version });
    }
  });

  it('REASON ASYMMETRY: null/missing/non-string version is caught upstream as invalid-json, NOT unsupported-version', async () => {
    // `asExport` requires `typeof version === 'string'`; a null/absent/numeric
    // version fails that guard BEFORE the version gate, so the reason is the distinct
    // `invalid-json`. Asserting `unsupported-version` here would pass for the wrong
    // layer — this pins the DISTINCT reason each malformed-version shape returns.
    const missing = await importCodex(
      JSON.stringify({ kadenaWallets: [] }),
      makeDeps(),
    );
    expect(missing).toEqual({ ok: false, reason: 'invalid-json' });

    const nullVersion = await importCodex(exportJson({ version: null }), makeDeps());
    expect(nullVersion).toEqual({ ok: false, reason: 'invalid-json' });

    const numericVersion = await importCodex(exportJson({ version: 1.3 }), makeDeps());
    expect(numericVersion).toEqual({ ok: false, reason: 'invalid-json' });
  });

  it('SECRET-FREE: an unsupported-version failure carries ONLY the version string, no decrypted secret/blob', async () => {
    // The failure union promises secret-freedom. Even though the rejected export
    // carries an `enc:` secret and encrypted private key, the outcome must expose
    // only the version — no plaintext, no blob, no extra key.
    const deps = makeDeps();
    const res = await importCodex(exportJson({ version: '9.9' }), deps);

    expect(res).toEqual({ ok: false, reason: 'unsupported-version', version: '9.9' });
    // A rejected version short-circuits before any decrypt seam runs.
    expect(deps.decrypt).not.toHaveBeenCalled();
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('word word word');
    expect(serialized).not.toContain('enc:');
    expect(serialized).not.toContain('priv-c');
  });
});
