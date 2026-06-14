import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StorageAdapter, StoredBlob } from '@stoawallet/core';

import { ChromeStorageAdapter } from '../storage/ChromeStorageAdapter';

/**
 * Unit tests for the `chrome.storage.local`-backed StorageAdapter.
 *
 * `chrome.storage.local` is the external-platform boundary, so it is replaced
 * by a minimal in-memory `chrome` global double that mirrors the modern MV3
 * promise-returning surface (`get`/`set`/`remove`). The double records the
 * raw values it was handed so the tests can assert on both the public
 * round-trip behavior AND the on-the-wire serialization the adapter chose.
 */

interface StorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

function installChromeDouble(): { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();

  const local: StorageArea = {
    async get(keys) {
      const out: Record<string, unknown> = {};
      const list = keys == null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
      for (const k of list) {
        if (store.has(k)) out[k] = store.get(k);
      }
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) store.delete(k);
    },
  };

  (globalThis as unknown as { chrome: { storage: { local: StorageArea } } }).chrome = {
    storage: { local },
  };

  return { store };
}

describe('ChromeStorageAdapter', () => {
  let store: Map<string, unknown>;

  beforeEach(() => {
    ({ store } = installChromeDouble());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it('is assignable to the core StorageAdapter contract so callers can depend on the interface', () => {
    // Compile-time conformance: if the class drifts from the interface this
    // assignment fails `tsc -b`, which is the real gate. The runtime check just
    // pins the three required methods exist.
    const adapter: StorageAdapter = new ChromeStorageAdapter();
    expect(typeof adapter.get).toBe('function');
    expect(typeof adapter.set).toBe('function');
    expect(typeof adapter.remove).toBe('function');
  });

  it('round-trips a string blob byte-identically so an encrypted text envelope decrypts', async () => {
    const adapter = new ChromeStorageAdapter();
    await adapter.set('codex.envelope', 'cipher-text-blob-ÿ');
    await expect(adapter.get('codex.envelope')).resolves.toBe('cipher-text-blob-ÿ');
  });

  it('round-trips a Uint8Array blob as the SAME bytes, not coerced to a string', async () => {
    const adapter = new ChromeStorageAdapter();
    // Includes 0 and a high byte to catch truncation / sign / off-by-one bugs.
    const blob = new Uint8Array([0, 1, 2, 250, 255]);
    await adapter.set('codex.binary', blob);

    const out = await adapter.get('codex.binary');
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out as Uint8Array)).toEqual([0, 1, 2, 250, 255]);
  });

  it('keeps the string and Uint8Array shapes distinct across a round-trip so a binary blob never reads back as text', async () => {
    const adapter = new ChromeStorageAdapter();
    await adapter.set('s', 'hello');
    await adapter.set('b', new Uint8Array([104, 101, 108, 108, 111]));

    expect(typeof (await adapter.get('s'))).toBe('string');
    expect(await adapter.get('b')).toBeInstanceOf(Uint8Array);
  });

  it('resolves to null for an absent key rather than throwing, so callers branch on "no wallet yet"', async () => {
    const adapter = new ChromeStorageAdapter();
    await expect(adapter.get('never.written')).resolves.toBeNull();
  });

  it('makes a removed key read back as absent so a wallet reset wipes the at-rest envelope', async () => {
    const adapter = new ChromeStorageAdapter();
    await adapter.set('codex.envelope', 'cipher-text-blob');
    await adapter.remove('codex.envelope');
    await expect(adapter.get('codex.envelope')).resolves.toBeNull();
  });

  it('removing an absent key is a no-op, not an error, so reset is idempotent', async () => {
    const adapter = new ChromeStorageAdapter();
    await expect(adapter.remove('never.written')).resolves.toBeUndefined();
  });

  it('never console-logs the stored value across set then get, so secrets stay out of logs', async () => {
    const secret = 'TOP-SECRET-ENVELOPE-BYTES';
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );

    const adapter = new ChromeStorageAdapter();
    await adapter.set('codex.envelope', secret);
    await adapter.get('codex.envelope');

    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        const joined = call.map((a) => String(a)).join(' ');
        expect(joined).not.toContain(secret);
      }
    }
  });

  it('persists through the chrome.storage.local surface (not some private field), proving the SW backing', async () => {
    // The adapter must write to chrome.storage.local so the value survives a
    // service-worker restart. Asserting the double's backing store saw the key
    // pins that the adapter actually went through chrome.* and did not keep an
    // in-process map.
    const adapter = new ChromeStorageAdapter();
    const blob: StoredBlob = new Uint8Array([9, 8, 7]);
    await adapter.set('codex.binary', blob);
    expect(store.has('codex.binary')).toBe(true);
  });
});
