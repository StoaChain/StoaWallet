import { describe, expect, it } from 'vitest';

import { importCodex, type ImportCodexDeps } from '../importCodex';

const CODEX_PW_PLAINTEXT = 'decrypted-mnemonic';

function deps(
  onProgress?: (done: number, total: number) => void,
): ImportCodexDeps {
  let n = 0;
  return {
    decrypt: async () => CODEX_PW_PLAINTEXT,
    encryptPhrase: async (m) => `ENC::${m}` as never,
    encryptPrivateKey: async (k) => `ENC::${k}`,
    existingPubKeys: new Set<string>(),
    existingWallets: [],
    genId: (kind) => `${kind}-${(n += 1)}`,
    now: () => '2026-09-07T00:00:00.000Z',
    ...(onProgress ? { onProgress } : {}),
  };
}

function exportJson(seeds: number, keys: number): string {
  return JSON.stringify({
    version: '1.2',
    kadenaWallets: Array.from({ length: seeds }, (_, i) => ({
      id: `seed-${i}`,
      name: `Seed ${i}`,
      seedType: 'koala',
      secret: 'sealed',
      accounts: [
        {
          index: 0,
          publicKey: String(i).padStart(64, 'a'),
          derivationPath: "m'/44'/626'/0'",
        },
      ],
    })),
    pureKeypairs: Array.from({ length: keys }, (_, i) => ({
      id: `key-${i}`,
      label: `Key ${i}`,
      publicKey: String(i).padStart(64, 'b'),
      encryptedPrivateKey: 'sealed',
    })),
  });
}

describe('importCodex progress reporting', () => {
  it('reports one tick per seed AND per pure key, against a total covering both', async () => {
    const ticks: Array<[number, number]> = [];
    const res = await importCodex(
      exportJson(3, 2),
      deps((done, total) => ticks.push([done, total])),
    );

    expect(res.ok).toBe(true);
    // The KDF cost is per item and the two loops run back to back, so a bar
    // driven by seeds alone would stall at 100% while the keys still decrypt.
    expect(ticks).toEqual([
      [1, 5],
      [2, 5],
      [3, 5],
      [4, 5],
      [5, 5],
    ]);
  });

  it('advances monotonically and finishes exactly at the total', async () => {
    const ticks: Array<[number, number]> = [];
    await importCodex(exportJson(4, 0), deps((d, t) => ticks.push([d, t])));

    const dones = ticks.map(([d]) => d);
    expect(dones).toEqual([...dones].sort((a, b) => a - b));
    // A bar that never reaches 100% reads as a hang to the user.
    expect(ticks.at(-1)).toEqual([4, 4]);
  });

  it('reports a total of 0 work as no ticks rather than a divide-by-zero bar', async () => {
    const ticks: Array<[number, number]> = [];
    await importCodex(exportJson(0, 0), deps((d, t) => ticks.push([d, t])));

    expect(ticks).toEqual([]);
  });

  it('imports identically when no onProgress is supplied', async () => {
    const withCb = await importCodex(exportJson(2, 1), deps(() => undefined));
    const without = await importCodex(exportJson(2, 1), deps());

    expect(without.ok).toBe(true);
    expect(withCb.ok).toBe(true);
    if (!withCb.ok || !without.ok) return;
    // Progress is observation only — it must never change what gets imported.
    expect(without.summary).toEqual(withCb.summary);
    expect(without.wallets.length).toBe(withCb.wallets.length);
  });
});
