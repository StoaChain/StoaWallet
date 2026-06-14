import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';

import type { StorageAdapter, StoredBlob } from '@stoawallet/core';

/**
 * `capacitor-secure-storage-plugin`-backed implementation of core's
 * `StorageAdapter` — the mobile (iOS Keychain / Android Keystore) backing for
 * the at-rest encrypted envelope.
 *
 * The stored value is the OPAQUE `smartEncrypt` output. Routing it through the
 * SECURE plugin (NOT `@capacitor/preferences`) is defense-in-depth: the
 * Keychain/Keystore layer is ADDITIVE on top of the Phase-2 envelope, which
 * stays the load-bearing secret protection. The adapter never encrypts,
 * decrypts, inspects, or logs a value.
 *
 * Serialization: a `StoredBlob` is `string | Uint8Array`, but the native plugin
 * stores STRINGS only. To guarantee a BYTE-IDENTICAL round-trip for both shapes
 * the adapter encodes every value as a JSON tagged envelope before handing it
 * to the plugin:
 *   - string → `{"t":"s","v":<the string>}`
 *   - binary → `{"t":"b","v":[<each byte 0-255>]}`
 * `get` parses the tag and reconstructs the original `string` or a fresh
 * `Uint8Array`, so the bytes handed to `set` are exactly what a later `get`
 * returns.
 */

type StringRecord = { readonly t: 's'; readonly v: string };
type BinaryRecord = { readonly t: 'b'; readonly v: number[] };
type StoredRecord = StringRecord | BinaryRecord;

function encode(value: StoredBlob): string {
  const record: StoredRecord =
    typeof value === 'string' ? { t: 's', v: value } : { t: 'b', v: Array.from(value) };
  return JSON.stringify(record);
}

function decode(serialized: string): StoredBlob {
  const record = JSON.parse(serialized) as StoredRecord;
  return record.t === 's' ? record.v : Uint8Array.from(record.v);
}

export class CapacitorStorageAdapter implements StorageAdapter {
  async get(key: string): Promise<StoredBlob | null> {
    let value: string;
    try {
      ({ value } = await SecureStoragePlugin.get({ key }));
    } catch {
      // ONLY the plugin's missing-key REJECTION lands here. A key the plugin has
      // never stored is "no wallet yet", which the contract models as `null`.
      return null;
    }
    // The plugin DID return a value — so the key is present. A decode/JSON
    // failure now means a PRESENT-but-CORRUPT envelope, NOT an absent key. It
    // must surface as an error (corrupt-vault taxonomy upstream), never collapse
    // to `null`, or the KeyringManager would route a corrupt vault to onboarding.
    return decode(value);
  }

  async set(key: string, value: StoredBlob): Promise<void> {
    await SecureStoragePlugin.set({ key, value: encode(value) });
  }

  async remove(key: string): Promise<void> {
    try {
      await SecureStoragePlugin.remove({ key });
    } catch {
      // The native plugin REJECTS when removing a key it never stored. The
      // contract requires `remove` to be idempotent, so an absent key is a
      // no-op rather than an error.
    }
  }
}
