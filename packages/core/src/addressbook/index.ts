/**
 * Barrel for the recipient address book — named `k:` addresses stored as plain
 * (non-secret) config over the shared `StorageAdapter`. Browser-safe: no
 * `node:`/SDK transport imports.
 */
export {
  listAddressBook,
  isInAddressBook,
  saveAddressBookEntry,
  removeAddressBookEntry,
  type AddressBookEntry,
} from './addressBook';
