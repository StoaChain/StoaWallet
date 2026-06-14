import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StorageAdapter, StoredBlob } from '@stoawallet/core';

/**
 * Unit tests for the `capacitor-secure-storage-plugin`-backed StorageAdapter.
 *
 * The Keychain/Keystore-backed `SecureStoragePlugin` is the external-platform
 * boundary, so it is replaced by a minimal in-memory double that mirrors the
 * real native contract: a string-only store whose `get` REJECTS for a key that
 * was never written (the iOS/Android impls throw on a missing item rather than
 * returning a sentinel). The double records every call so the tests can assert
 * the public round-trip behavior, the on-the-wire serialization the adapter
 * chose, AND that the vault blob is routed to the SECURE plugin (not the
 * non-secure `@capacitor/preferences`).
 */

interface SecureDoubleHandle {
  store: Map<string, string>;
  setCalls: { key: string; value: string }[];
}

const secureDouble: SecureDoubleHandle = {
  store: new Map<string, string>(),
  setCalls: [],
};

vi.mock('capacitor-secure-storage-plugin', () => ({
  SecureStoragePlugin: {
    async get({ key }: { key: string }): Promise<{ value: string }> {
      if (!secureDouble.store.has(key)) {
        // Mirror the native plugin: a missing item REJECTS, it is not `null`.
        throw new Error(`Item with given key does not exist: ${key}`);
      }
      return { value: secureDouble.store.get(key)! };
    },
    async set({ key, value }: { key: string; value: string }): Promise<{ value: boolean }> {
      secureDouble.setCalls.push({ key, value });
      secureDouble.store.set(key, value);
      return { value: true };
    },
    async remove({ key }: { key: string }): Promise<{ value: boolean }> {
      if (!secureDouble.store.has(key)) {
        // Mirror the native plugin: removing a missing item REJECTS. The
        // adapter must absorb this so a reset stays idempotent.
        throw new Error(`Item with given key does not exist: ${key}`);
      }
      secureDouble.store.delete(key);
      return { value: true };
    },
  },
}));

import { CapacitorStorageAdapter } from '../storage/CapacitorStorageAdapter';

describe('CapacitorStorageAdapter', () => {
  beforeEach(() => {
    secureDouble.store.clear();
    secureDouble.setCalls.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is assignable to the core StorageAdapter contract so callers can depend on the interface', () => {
    // Compile-time conformance: if the class drifts from the interface this
    // assignment fails `tsc -b`, which is the real gate. The runtime check pins
    // that the three required methods exist.
    const adapter: StorageAdapter = new CapacitorStorageAdapter();
    expect(typeof adapter.get).toBe('function');
    expect(typeof adapter.set).toBe('function');
    expect(typeof adapter.remove).toBe('function');
  });

  it('round-trips a string blob byte-identically so an encrypted text envelope decrypts', async () => {
    const adapter = new CapacitorStorageAdapter();
    await adapter.set('vault.envelope', 'cipher-text-blob-ÿ');
    await expect(adapter.get('vault.envelope')).resolves.toBe('cipher-text-blob-ÿ');
  });

  it('round-trips a Uint8Array blob as the SAME bytes, not coerced to a string', async () => {
    const adapter = new CapacitorStorageAdapter();
    // Includes 0 and a high byte to catch truncation / sign / off-by-one bugs.
    const blob = new Uint8Array([0, 1, 2, 250, 255]);
    await adapter.set('vault.binary', blob);

    const out = await adapter.get('vault.binary');
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out as Uint8Array)).toEqual([0, 1, 2, 250, 255]);
  });

  it('keeps the string and Uint8Array shapes distinct across a round-trip so a binary blob never reads back as text', async () => {
    const adapter = new CapacitorStorageAdapter();
    await adapter.set('s', 'hello');
    await adapter.set('b', new Uint8Array([104, 101, 108, 108, 111]));

    expect(typeof (await adapter.get('s'))).toBe('string');
    expect(await adapter.get('b')).toBeInstanceOf(Uint8Array);
  });

  it('resolves to null for an absent key rather than letting the plugin rejection escape, so callers branch on "no wallet yet"', async () => {
    const adapter = new CapacitorStorageAdapter();
    // The native plugin REJECTS on a missing key; the adapter must absorb that
    // into a `null` resolution, not a throw.
    await expect(adapter.get('never.written')).resolves.toBeNull();
  });

  it('does NOT resolve a present-but-corrupt value to null — a decode failure surfaces as an error, not "no wallet" (M-2)', async () => {
    // The plugin RETURNED a value for this key (so the key is present), but the
    // value is not a decodable tagged envelope. That is a PRESENT-but-CORRUPT
    // vault, NOT an absent key — it must surface as an error so the corrupt-vault
    // taxonomy reaches the UI, never collapse to `null` (which the KeyringManager
    // would treat as "no vault" → onboarding, silently masking a corrupt vault).
    secureDouble.store.set('vault.envelope', 'not-a-json-tagged-envelope{');

    const adapter = new CapacitorStorageAdapter();
    await expect(adapter.get('vault.envelope')).rejects.toThrow();
  });

  it('still resolves null for a truly absent key even after the corrupt-value path was added, so onboarding is not broken (M-2)', async () => {
    // Guard the other side of the M-2 fix: distinguishing corrupt from absent
    // must NOT regress the legitimate "no wallet yet" → null path.
    const adapter = new CapacitorStorageAdapter();
    await expect(adapter.get('genuinely.absent')).resolves.toBeNull();
  });

  it('makes a removed key read back as absent so a wallet reset wipes the at-rest envelope', async () => {
    const adapter = new CapacitorStorageAdapter();
    await adapter.set('vault.envelope', 'cipher-text-blob');
    await adapter.remove('vault.envelope');
    await expect(adapter.get('vault.envelope')).resolves.toBeNull();
  });

  it('removing an absent key is a no-op, not an error, so reset is idempotent', async () => {
    const adapter = new CapacitorStorageAdapter();
    await expect(adapter.remove('never.written')).resolves.toBeUndefined();
  });

  it('never console-logs the stored value across set then get, so secrets stay out of logs', async () => {
    const secret = 'TOP-SECRET-ENVELOPE-BYTES';
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );

    const adapter = new CapacitorStorageAdapter();
    await adapter.set('vault.envelope', secret);
    await adapter.get('vault.envelope');

    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        const joined = call.map((a) => String(a)).join(' ');
        expect(joined).not.toContain(secret);
      }
    }
  });

  it('routes the vault blob through the SECURE plugin (Keychain/Keystore), not @capacitor/preferences', async () => {
    // RR#6: the at-rest vault envelope must land in the secure store. The
    // mocked secure plugin recorded the write, which proves the adapter went
    // through `capacitor-secure-storage-plugin` and not the non-secure
    // Preferences API.
    const adapter = new CapacitorStorageAdapter();
    const vaultKey = 'vault.envelope';
    const blob: StoredBlob = new Uint8Array([9, 8, 7]);
    await adapter.set(vaultKey, blob);

    expect(secureDouble.setCalls.map((c) => c.key)).toContain(vaultKey);
    expect(secureDouble.store.has(vaultKey)).toBe(true);
  });

  it('persists only a string to the native store (the plugin holds strings) while preserving bytes', async () => {
    // The native plugin stores strings only; a Uint8Array must be encoded to a
    // string envelope on the wire yet still read back as the exact bytes.
    const adapter = new CapacitorStorageAdapter();
    await adapter.set('vault.binary', new Uint8Array([0, 255, 128]));

    const onWire = secureDouble.store.get('vault.binary');
    expect(typeof onWire).toBe('string');

    const out = await adapter.get('vault.binary');
    expect(Array.from(out as Uint8Array)).toEqual([0, 255, 128]);
  });
});
