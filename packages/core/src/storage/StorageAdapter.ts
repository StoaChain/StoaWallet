/**
 * Persistent, at-rest blob storage for the wallet.
 *
 * This is the abstraction over WHERE the encrypted envelope lives, decoupled
 * from any concrete backend. The two planned backers are:
 *   - extension: `chrome.storage.local` (MV3 service workers have NO
 *     `localStorage`, so a synchronous `localStorage`-shaped API is off the
 *     table — every method here is async).
 *   - mobile: Capacitor Preferences / Secure Storage.
 *
 * Values are OPAQUE encrypted blobs as produced by `smartEncrypt` /
 * consumed by `smartDecrypt` — never a typed secret. The adapter neither
 * encrypts nor inspects them; it only persists and returns the exact bytes
 * it was handed. Keeping the value type `string | Uint8Array` lets a backend
 * choose its natural representation (text store vs. binary store) without the
 * envelope shape leaking into this contract.
 *
 * Deliberately NOT a reuse of OuronetUI's `LocalStorageCodexAdapter`: that
 * class is hard-wired to the browser `localStorage` global and models codex
 * domain shapes (seeds, OURO accounts, pure keypairs) directly. This contract
 * is backend-agnostic and blob-agnostic on purpose.
 */
export type StoredBlob = string | Uint8Array;

export interface StorageAdapter {
  /**
   * Read the blob stored under `key`.
   *
   * Resolves to `null` when nothing has been written under `key` (or it was
   * removed). Callers rely on `null` to distinguish "no envelope yet"
   * (onboard) from "envelope present" (unlock) — an empty string/array is a
   * legitimate stored value and is NOT treated as absent.
   */
  get(key: string): Promise<StoredBlob | null>;

  /**
   * Persist `value` under `key`, replacing any existing blob. The bytes must
   * be returned verbatim by a subsequent `get` so the encrypted envelope can
   * be decrypted.
   */
  set(key: string, value: StoredBlob): Promise<void>;

  /**
   * Delete the blob under `key`. After this, `get(key)` resolves to `null`.
   * Idempotent: removing an absent key is a no-op, not an error.
   */
  remove(key: string): Promise<void>;
}
