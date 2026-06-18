/**
 * The recipient ADDRESS BOOK — named `k:` addresses the user has saved, so a
 * known recipient can be picked by name instead of re-pasting a 66-char key.
 *
 * This is plain, NON-SECRET config (a public `k:` address + a user label), so it
 * is stored as an opaque JSON string via `StorageAdapter.set` — NEVER through the
 * vault's `smartEncrypt`. Reads are degrade-safe: an absent OR malformed blob
 * resolves to an empty book rather than throwing, so a fresh install or a
 * tampered/legacy value can never wedge the picker.
 *
 * The address is the IDENTITY: saving an address that already exists updates its
 * name (an upsert), never a duplicate row. Entries are returned newest-first so
 * the picker surfaces the most recently saved names at the top.
 */

import type { StorageAdapter } from '../storage';
import { ADDRESS_BOOK_KEY } from '../storage/storageKeys';

/** A `k:` account: the literal `k:` prefix + a 64-char hex ED25519 public key. */
const K_ACCOUNT_RE = /^k:[0-9a-fA-F]{64}$/;

/** A saved recipient: a public `k:` address and the user's label for it. */
export interface AddressBookEntry {
  /** The user's display name for the address (trimmed, non-empty). */
  readonly name: string;
  /** The `k:` recipient address (validated `k:`+64-hex). */
  readonly address: string;
}

/** Decode a stored blob to a UTF-8 string regardless of the backend's representation. */
function blobToString(raw: string | Uint8Array): string {
  return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
}

/**
 * Coerce an unknown parsed value into a clean `AddressBookEntry[]`: keep only
 * rows with a valid `k:` address and a non-empty trimmed name, de-duplicated by
 * address (first occurrence wins, preserving order). Anything malformed is
 * dropped, never thrown — a corrupt blob degrades to whatever rows survive.
 */
function sanitize(value: unknown): AddressBookEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: AddressBookEntry[] = [];
  for (const row of value) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const address = typeof r.address === 'string' ? r.address : '';
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!K_ACCOUNT_RE.test(address) || name === '' || seen.has(address)) continue;
    seen.add(address);
    out.push({ name, address });
  }
  return out;
}

/**
 * Read the saved address book, newest-first. An ABSENT key resolves to `[]`
 * (fresh install); a MALFORMED blob degrades to the rows that survive
 * sanitization rather than throwing.
 */
export async function listAddressBook(
  adapter: StorageAdapter,
): Promise<AddressBookEntry[]> {
  const raw = await adapter.get(ADDRESS_BOOK_KEY);
  if (raw === null) return [];
  try {
    return sanitize(JSON.parse(blobToString(raw)));
  } catch {
    return [];
  }
}

/** Whether `address` is already saved in the book. */
export async function isInAddressBook(
  adapter: StorageAdapter,
  address: string,
): Promise<boolean> {
  const book = await listAddressBook(adapter);
  return book.some((e) => e.address === address);
}

/**
 * Save (UPSERT) a named address. The address is the identity — saving an address
 * already present updates its name in place rather than duplicating it, and the
 * saved/updated row is moved to the FRONT (newest-first). Rejects an invalid
 * `k:` address or an empty name BEFORE writing. Returns the new book.
 *
 * @throws {Error} if `address` is not a valid `k:` account or `name` is blank.
 */
export async function saveAddressBookEntry(
  adapter: StorageAdapter,
  entry: AddressBookEntry,
): Promise<AddressBookEntry[]> {
  const name = entry.name.trim();
  if (!K_ACCOUNT_RE.test(entry.address)) {
    throw new Error('saveAddressBookEntry: address must be a valid k: account');
  }
  if (name === '') {
    throw new Error('saveAddressBookEntry: name must be a non-empty string');
  }

  const existing = await listAddressBook(adapter);
  const without = existing.filter((e) => e.address !== entry.address);
  const next: AddressBookEntry[] = [{ name, address: entry.address }, ...without];
  await adapter.set(ADDRESS_BOOK_KEY, JSON.stringify(next));
  return next;
}

/**
 * Remove the entry for `address` (idempotent — removing an absent address is a
 * no-op). Returns the new book.
 */
export async function removeAddressBookEntry(
  adapter: StorageAdapter,
  address: string,
): Promise<AddressBookEntry[]> {
  const existing = await listAddressBook(adapter);
  const next = existing.filter((e) => e.address !== address);
  if (next.length !== existing.length) {
    await adapter.set(ADDRESS_BOOK_KEY, JSON.stringify(next));
  }
  return next;
}
