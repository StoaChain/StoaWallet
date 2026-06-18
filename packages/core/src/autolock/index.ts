/**
 * Barrel for the auto-lock preference — how long the wallet stays unlocked after
 * the last activity. Plain (non-secret) config over the shared `StorageAdapter`.
 * Browser-safe: no `node:`/SDK transport imports.
 */
export {
  getAutoLockMinutes,
  setAutoLockMinutes,
  clampAutoLockMinutes,
  AUTO_LOCK_OPTIONS,
  MIN_AUTO_LOCK_MINUTES,
  MAX_AUTO_LOCK_MINUTES,
  DEFAULT_AUTO_LOCK_MINUTES,
} from './autoLockPreference';
