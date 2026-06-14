import type { StorageAdapter, StoredBlob } from '@stoawallet/core';

/**
 * `chrome.storage.local`-backed implementation of core's `StorageAdapter`.
 *
 * This is the Chrome MV3 backing for the at-rest encrypted envelope. It runs in
 * the popup AND the background service worker, where there is NO `localStorage`,
 * so it goes through `chrome.storage.local` exclusively. The adapter stores and
 * returns OPAQUE blobs verbatim — it never encrypts, decrypts, inspects, or
 * logs a value.
 *
 * Serialization: a `StoredBlob` is `string | Uint8Array`, but
 * `chrome.storage.local` structured-clones values and does not reliably
 * preserve a `Uint8Array`'s exact type across a service-worker
 * serialize/restart boundary in every engine. To guarantee a BYTE-IDENTICAL
 * round-trip for both shapes, the adapter wraps every value in a small tagged
 * envelope:
 *   - string  → `{ t: 's', v: <the string> }`
 *   - binary  → `{ t: 'b', v: number[] }` (each byte 0-255)
 * `get` reads the tag and reconstructs the original `string` or a fresh
 * `Uint8Array` from the byte array, so the bytes handed to `set` are exactly
 * what a later `get` returns.
 */

type StringRecord = { readonly t: 's'; readonly v: string };
type BinaryRecord = { readonly t: 'b'; readonly v: number[] };
type StoredRecord = StringRecord | BinaryRecord;

function encode(value: StoredBlob): StoredRecord {
  if (typeof value === 'string') {
    return { t: 's', v: value };
  }
  return { t: 'b', v: Array.from(value) };
}

function decode(record: StoredRecord): StoredBlob {
  return record.t === 's' ? record.v : Uint8Array.from(record.v);
}

export class ChromeStorageAdapter implements StorageAdapter {
  async get(key: string): Promise<StoredBlob | null> {
    const result = await chrome.storage.local.get(key);
    const record = result[key] as StoredRecord | undefined;
    if (record === undefined) {
      return null;
    }
    return decode(record);
  }

  async set(key: string, value: StoredBlob): Promise<void> {
    await chrome.storage.local.set({ [key]: encode(value) });
  }

  async remove(key: string): Promise<void> {
    await chrome.storage.local.remove(key);
  }
}
