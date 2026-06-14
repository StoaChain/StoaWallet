/**
 * Storage sub-barrel for `@stoawallet/core`.
 *
 * Exposes the platform-agnostic storage contract — `StorageAdapter` (at-rest
 * encrypted blobs) and `KeyVault` (in-memory unlocked-key lifecycle) — so the
 * extension (chrome.storage + service-worker in-memory key) and mobile
 * (Capacitor secure storage + keychain) can each implement it later without
 * forking the UI. No `chrome.*` and no Capacitor imports live here or below.
 *
 * The root barrel (`packages/core/src/index.ts`) re-exports this sub-barrel;
 * this file is the single export surface for the storage layer — including the
 * shared `storageKeys` registry and the biometric-unlock contract.
 */
export type { StorageAdapter, StoredBlob } from './StorageAdapter';
export type { KeyVault, UnlockedKey } from './KeyVault';

// The single registry of persisted `StorageAdapter` keys (the one place a key
// collision is caught) and its value type.
export {
  VAULT_KEY,
  ACTIVE_ACCOUNT_KEY,
  CROSSCHAIN_INFLIGHT_KEY,
  MINER_AGGREGATION_KEY,
  DAPP_PERMISSIONS_KEY,
  DAPP_RATELIMIT_KEY,
  NODE_PREFERENCE_KEY,
  STORAGE_KEYS,
  type StorageKey,
} from './storageKeys';

// Biometric-unlock contract + the web/extension default that has no biometrics.
export {
  UnsupportedBiometricUnlock,
  type BiometricUnlock,
  type BiometricSecret,
  type BiometricUnlockResult,
  type BiometricUnlockFailureReason,
} from './BiometricUnlock';

// QR-scan contract (recipient-address scanning) + the web/extension default
// that has no camera scanner, plus the RR#5 input-bounding helper/constant.
export {
  UnsupportedQrScanner,
  isBoundedQrPayload,
  MAX_QR_PAYLOAD_LENGTH,
  type QrScanner,
  type QrScanResult,
  type QrScanFailureReason,
} from './QrScanner';
