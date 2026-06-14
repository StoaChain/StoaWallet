/**
 * Thin re-export of the SDK's live node-failover STATUS reads, so UI/app code can
 * display the wallet's currently-configured/active node WITHOUT importing
 * `@stoachain/*` directly (`packages/ui` only depends on `@stoawallet/core`).
 *
 * These are pure reads of the SDK's in-process failover config — `getNodeConfig`
 * returns the configured `{ primary, fallback }`, and `getCurrentNodeStatus` adds
 * the live `active` host plus an `isOnPrimary` flag (false when failover has
 * switched to the fallback). Neither mutates SDK state.
 */
import {
  getCurrentNodeStatus,
  getNodeConfig,
} from '@stoachain/stoa-core/network';

/** The configured node failover pair: the lead host and its fallback. */
export interface NodeConfig {
  readonly primary: string;
  readonly fallback: string;
}

/** The live node status: the configured pair plus the active host + a flag. */
export interface NodeStatus extends NodeConfig {
  /** The host requests are currently routed to (primary unless failover fired). */
  readonly active: string;
  /** False once failover switched to the fallback host. */
  readonly isOnPrimary: boolean;
}

export { getCurrentNodeStatus, getNodeConfig };
