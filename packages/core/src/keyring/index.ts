/**
 * Keyring sub-barrel for `@stoawallet/core`.
 *
 * The single export surface for the wallet's key lifecycle: the at-rest vault
 * model + pure (de)serialization, encrypt-at-rest of the seed phrase, mnemonic
 * generate/validate, multi-account derivation, and the `KeyringManager` that
 * orchestrates them over the storage contracts. The root barrel re-exports this.
 *
 * No `chrome.*` and no Capacitor imports live here or below — the keyring is
 * platform-agnostic; concrete storage backers are wired per-platform.
 */

// At-rest vault model + pure (de)serialization.
export {
  serializeVault,
  deserializeVault,
  advancedAccountsOf,
  pureKeypairsOf,
  CorruptVaultError,
  type EncryptedBlob,
  type SeedType,
  type StoredAccount,
  type StoredWallet,
  type Vault,
} from './vault';

// Encrypt-at-rest of the seed phrase (V2 envelope; distinct decrypt taxonomy).
export { encryptPhrase, decryptPhrase } from './encryptAtRest';

// Mnemonic generation + pre-derivation validation.
export {
  generateMnemonic,
  validateMnemonic,
  type MnemonicRejection,
  type MnemonicValidation,
} from './mnemonic';

// Multi-account discovery from a mnemonic.
export { deriveAccounts, type AccountRecord } from './deriveAccounts';

// Orchestration over StorageAdapter + KeyVault.
export {
  KeyringManager,
  InvalidMnemonicError,
  WalletLockedError,
  BiometricUnlockFailedError,
  type KeyringManagerDeps,
  type OnboardOptions,
  type OnboardResult,
} from './KeyringManager';
