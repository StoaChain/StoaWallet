import {
  listAddressBook,
  removeAddressBookEntry,
  saveAddressBookEntry,
  type AddressBookEntry,
  type StorageAdapter,
} from '@stoawallet/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useOptionalWallet } from '../context/WalletContext';

export interface UseAddressBookOptions {
  /**
   * The storage seam. Defaults to the context-injected adapter so the book uses
   * the same backend as the vault; tests inject an in-memory double (and may
   * render the hook WITHOUT a provider — `useOptionalWallet` returns null then).
   */
  readonly storage?: StorageAdapter;
}

export interface UseAddressBookResult {
  /** The saved entries, newest-first. Empty until the initial load resolves. */
  readonly entries: AddressBookEntry[];
  /** True until the first load completes. */
  readonly isLoading: boolean;
  /** Whether `address` is already saved. */
  has(address: string): boolean;
  /** Save (upsert) a named address; refreshes the list. No-op without storage. */
  save(entry: AddressBookEntry): Promise<void>;
  /** Remove an address; refreshes the list. No-op without storage. */
  remove(address: string): Promise<void>;
  /** Re-read the book from storage. */
  refresh(): Promise<void>;
}

/**
 * Read/write hook over the recipient address book. It composes the context
 * storage adapter (or an injected double) with the core address-book functions,
 * keeping a live in-memory copy the picker + save prompt render. It never holds
 * key material — the book is plain, non-secret config (`name` + public `k:`).
 */
export function useAddressBook(
  options: UseAddressBookOptions = {},
): UseAddressBookResult {
  const wallet = useOptionalWallet();
  const storage = options.storage ?? wallet?.storage;

  const [entries, setEntries] = useState<AddressBookEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Drop a post-resolution write after unmount (MV3 popup close mid-read).
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (storage === undefined) {
      setIsLoading(false);
      return;
    }
    const next = await listAddressBook(storage);
    if (cancelledRef.current) return;
    setEntries(next);
    setIsLoading(false);
  }, [storage]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(
    async (entry: AddressBookEntry): Promise<void> => {
      if (storage === undefined) return;
      const next = await saveAddressBookEntry(storage, entry);
      if (cancelledRef.current) return;
      setEntries(next);
    },
    [storage],
  );

  const remove = useCallback(
    async (address: string): Promise<void> => {
      if (storage === undefined) return;
      const next = await removeAddressBookEntry(storage, address);
      if (cancelledRef.current) return;
      setEntries(next);
    },
    [storage],
  );

  const has = useCallback(
    (address: string): boolean => entries.some((e) => e.address === address),
    [entries],
  );

  return { entries, isLoading, has, save, remove, refresh };
}
