/**
 * Barrel for the wallet-wide forward key-search preference (advanced opt-in:
 * probe derivation indices to resolve an address a seed controls but hasn't
 * added). Plain (non-secret) config over the shared `StorageAdapter`.
 * Browser-safe: no `node:`/SDK transport imports.
 */
export {
  getForwardSearchPref,
  setForwardSearchPref,
  clampForwardSearchDepth,
  type ForwardSearchPref,
  DEFAULT_FORWARD_SEARCH,
  FORWARD_SEARCH_OPTIONS,
  MIN_FORWARD_SEARCH_DEPTH,
  MAX_FORWARD_SEARCH_DEPTH,
  DEFAULT_FORWARD_SEARCH_DEPTH,
} from './forwardSearchPreference';
