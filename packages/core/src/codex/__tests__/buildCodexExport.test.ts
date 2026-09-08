import { describe, expect, it } from 'vitest';

import { buildCodexExport, type BuildCodexExportInput } from '../buildCodexExport';
import type { IPureKeypair, StoredWallet } from '../../keyring/vault';

const MNEMONIC_A = 'alpha seed words one two three four five';
const MNEMONIC_B = 'beta seed words six seven eight nine ten';
const PRIVATE_KEY = 'ab'.repeat(32);

function wallet(id: string, name: string, pub: string): StoredWallet {
  return {
    id,
    name,
    encryptedPhrase: `ENC::${id}` as never,
    accounts: [
      {
        index: 0,
        publicKey: pub,
        account: `k:${pub}`,
        derivationPath: "m'/44'/626'/0'",
      },
    ],
    activeAccountIndex: 0,
    seedType: 'koala',
    origin: 'seed',
    createdAt: '2026-09-07T00:00:00.000Z',
  };
}

function pureKey(id: string, pub: string): IPureKeypair {
  return {
    id,
    label: 'Cold key',
    publicKey: pub,
    encryptedPrivateKey: `ENC::${id}`,
    createdAt: '2026-09-07T00:00:00.000Z',
  };
}

/**
 * The seams the builder needs: open a stored envelope at the WALLET password,
 * and re-seal the plaintext at the EXPORT password. Both are faked here so the
 * test asserts the mapping, not the crypto.
 */
function deps(onProgress?: (done: number, total: number) => void) {
  const opened: string[] = [];
  const resealed: string[] = [];
  return {
    calls: { opened, resealed },
    open: async (blob: string): Promise<string> => {
      opened.push(blob);
      if (blob === 'ENC::w1') return MNEMONIC_A;
      if (blob === 'ENC::w2') return MNEMONIC_B;
      return PRIVATE_KEY;
    },
    reseal: async (plaintext: string): Promise<string> => {
      resealed.push(plaintext);
      return `SEALED(${plaintext.length})`;
    },
    now: () => '2026-09-08T00:00:00.000Z',
    ...(onProgress ? { onProgress } : {}),
  };
}

function input(): BuildCodexExportInput {
  return {
    wallets: [wallet('w1', 'Seed One', 'a'.repeat(64)), wallet('w2', 'Seed Two', 'b'.repeat(64))],
    pureKeypairs: [pureKey('k1', 'c'.repeat(64))],
  };
}

describe('buildCodexExport', () => {
  it('emits a Codex-shaped export carrying every seed and key', async () => {
    const d = deps();
    const res = await buildCodexExport(input(), d);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.export.version).toBe('1.2');
    expect(res.export.exportedAt).toBe('2026-09-08T00:00:00.000Z');
    expect(res.export.kadenaWallets).toHaveLength(2);
    expect(res.export.pureKeypairs).toHaveLength(1);
    // Names and seed types must survive, or a re-import renames the user's seeds.
    expect(res.export.kadenaWallets.map((w) => w.name)).toEqual([
      'Seed One',
      'Seed Two',
    ]);
    expect(res.export.kadenaWallets[0].seedType).toBe('koala');
    // Accounts carry the fields the importer reads back.
    expect(res.export.kadenaWallets[0].accounts).toEqual([
      { index: 0, publicKey: 'a'.repeat(64), derivationPath: "m'/44'/626'/0'" },
    ]);
  });

  it('NEVER puts a plaintext mnemonic or private key in the export', async () => {
    const d = deps();
    const res = await buildCodexExport(input(), d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // The whole point: this object gets written to a file on the user's disk.
    const serialized = JSON.stringify(res.export);
    expect(serialized).not.toContain(MNEMONIC_A);
    expect(serialized).not.toContain(MNEMONIC_B);
    expect(serialized).not.toContain(PRIVATE_KEY);
  });

  it('re-seals every secret exactly once, at the export password seam', async () => {
    const d = deps();
    await buildCodexExport(input(), d);

    // Two seeds + one pure key: a secret opened but not re-sealed would ship
    // still encrypted at the WALLET password, unopenable by the import side.
    expect(d.calls.opened).toHaveLength(3);
    expect(d.calls.resealed).toEqual([MNEMONIC_A, MNEMONIC_B, PRIVATE_KEY]);
  });

  it('reports one progress tick per seed AND per key, ending at the total', async () => {
    const ticks: Array<[number, number]> = [];
    await buildCodexExport(input(), deps((done, total) => ticks.push([done, total])));

    // Each item costs a KDF round on the way out, same as on the way in.
    expect(ticks).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('refuses to export a vault with no wallets rather than emitting an empty file', async () => {
    const res = await buildCodexExport({ wallets: [], pureKeypairs: [] }, deps());

    // An "empty backup" is worse than no backup — it looks like a safety net.
    expect(res).toEqual({ ok: false, reason: 'nothing-to-export' });
  });

  it('satisfies the OURONET Codex v1.2 shape contract, so the file imports there too', async () => {
    const res = await buildCodexExport(input(), deps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const doc = res.export as unknown as Record<string, unknown>;

    // Ouronet's parseBackupFile validates each of these up front and throws
    // CodexImportError("shape", ...) on a missing one — omitting them would get
    // the whole file rejected rather than importing the seeds it does carry.
    expect(doc.version).toBe('1.2');
    expect(Array.isArray(doc.kadenaWallets)).toBe(true);
    expect(Array.isArray(doc.ouronetWallets)).toBe(true);
    expect(Array.isArray(doc.addressBook)).toBe(true);
    expect(typeof doc.uiSettings).toBe('object');
    expect(doc.uiSettings).not.toBeNull();
    expect(Array.isArray(doc.uiSettings)).toBe(false);
    // pureKeypairs is optional there, but must be an array when present.
    expect(Array.isArray(doc.pureKeypairs)).toBe(true);

    // StoaWallet holds no Ouro identities, so that collection is empty — but
    // PRESENT, which is the whole point.
    expect(doc.ouronetWallets).toEqual([]);
  });
});