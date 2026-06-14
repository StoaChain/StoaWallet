/**
 * Shared in-memory test doubles for `@stoawallet/core`, consumed via the
 * `@stoawallet/core/testing` subpath. Single source for the storage/keyvault
 * doubles that every suite (core + ui) drives a real KeyringManager through.
 */
export { InMemoryStorageAdapter, InMemoryKeyVault } from './inMemory';
