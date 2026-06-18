import { InMemoryStorageAdapter } from '@stoawallet/core/testing';
import { describe, expect, it } from 'vitest';

import {
  isInAddressBook,
  listAddressBook,
  removeAddressBookEntry,
  saveAddressBookEntry,
} from '../addressBook';
import { ADDRESS_BOOK_KEY } from '../../storage/storageKeys';

const A = `k:${'a'.repeat(64)}`;
const B = `k:${'b'.repeat(64)}`;

describe('address book', () => {
  it('returns an empty book on a fresh install (absent key)', async () => {
    const storage = new InMemoryStorageAdapter();
    expect(await listAddressBook(storage)).toEqual([]);
    expect(await isInAddressBook(storage, A)).toBe(false);
  });

  it('saves a named address and reads it back', async () => {
    const storage = new InMemoryStorageAdapter();
    await saveAddressBookEntry(storage, { name: 'Alice', address: A });
    expect(await listAddressBook(storage)).toEqual([{ name: 'Alice', address: A }]);
    expect(await isInAddressBook(storage, A)).toBe(true);
  });

  it('trims the name and rejects an empty one', async () => {
    const storage = new InMemoryStorageAdapter();
    await saveAddressBookEntry(storage, { name: '  Bob  ', address: B });
    expect(await listAddressBook(storage)).toEqual([{ name: 'Bob', address: B }]);
    await expect(
      saveAddressBookEntry(storage, { name: '   ', address: A }),
    ).rejects.toThrow(/name/i);
  });

  it('rejects an invalid k: address', async () => {
    const storage = new InMemoryStorageAdapter();
    await expect(
      saveAddressBookEntry(storage, { name: 'X', address: 'not-a-k-account' }),
    ).rejects.toThrow(/k:/);
  });

  it('UPSERTS by address — re-saving updates the name and moves it to the front', async () => {
    const storage = new InMemoryStorageAdapter();
    await saveAddressBookEntry(storage, { name: 'Alice', address: A });
    await saveAddressBookEntry(storage, { name: 'Bob', address: B });
    // Re-save A with a new name → updated in place, hoisted to front, no dup.
    const book = await saveAddressBookEntry(storage, { name: 'Alice 2', address: A });
    expect(book).toEqual([
      { name: 'Alice 2', address: A },
      { name: 'Bob', address: B },
    ]);
  });

  it('returns entries newest-first', async () => {
    const storage = new InMemoryStorageAdapter();
    await saveAddressBookEntry(storage, { name: 'Alice', address: A });
    await saveAddressBookEntry(storage, { name: 'Bob', address: B });
    const book = await listAddressBook(storage);
    expect(book.map((e) => e.name)).toEqual(['Bob', 'Alice']);
  });

  it('removes an entry (idempotent for an absent address)', async () => {
    const storage = new InMemoryStorageAdapter();
    await saveAddressBookEntry(storage, { name: 'Alice', address: A });
    await saveAddressBookEntry(storage, { name: 'Bob', address: B });
    const afterRemove = await removeAddressBookEntry(storage, A);
    expect(afterRemove).toEqual([{ name: 'Bob', address: B }]);
    // Removing again is a no-op, not an error.
    expect(await removeAddressBookEntry(storage, A)).toEqual([
      { name: 'Bob', address: B },
    ]);
  });

  it('degrades a corrupt blob to an empty book instead of throwing', async () => {
    const storage = new InMemoryStorageAdapter();
    await storage.set(ADDRESS_BOOK_KEY, '{ this is not json');
    expect(await listAddressBook(storage)).toEqual([]);
  });

  it('drops malformed rows (bad address / blank name / duplicate) from a tampered blob', async () => {
    const storage = new InMemoryStorageAdapter();
    await storage.set(
      ADDRESS_BOOK_KEY,
      JSON.stringify([
        { name: 'Good', address: A },
        { name: '', address: B },
        { name: 'BadAddr', address: 'nope' },
        { name: 'Dup', address: A },
        'garbage',
      ]),
    );
    expect(await listAddressBook(storage)).toEqual([{ name: 'Good', address: A }]);
  });
});
