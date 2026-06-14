import {
  getNodeConfig,
  initNodeFailover,
  resetNodeFailover,
  setNodeConfig,
} from '@stoachain/stoa-core/network';

import type { StorageAdapter } from '../storage';
import { applySelector } from './applySelector';
import { getNodePreference } from './nodePreference';
import type { NodePreference } from './nodePreference';

/**
 * The host a given preference is EXPECTED to configure as primary, resolved from
 * the REAL SDK `setNodeConfig`/`getNodeConfig` (never a hardcoded literal). We
 * apply the preset, read back the configured primary, then reset failover so the
 * probe leaves no residue on shared SDK state. Resolving from the REAL
 * `setNodeConfig`/`getNodeConfig` (not the injected deps) keeps the self-check
 * independent of any injected/broken `setNodeConfig` double — a no-op override
 * still gets measured against the genuine SDK-derived host.
 *
 * The expected host is computed PER preference (node1 by default, node2 for a
 * node2 pref, the origin-only host for a custom URL), so the self-check tracks
 * whatever the preference SELECTED rather than asserting a stale node1 literal.
 */
function expectedPrimaryHost(pref: NodePreference): string {
  switch (pref.kind) {
    case 'custom':
      setNodeConfig('custom', pref.customUrl);
      break;
    case 'node2':
      setNodeConfig('node2');
      break;
    case 'default':
      setNodeConfig('node1');
      break;
  }
  const host = getNodeConfig().primary;
  resetNodeFailover();
  return host;
}

/** Injectable SDK seam — real failover functions in production, doubles in tests. */
export interface ConfigureNodeDeps {
  setNodeConfig: typeof setNodeConfig;
  initNodeFailover: typeof initNodeFailover;
  getNodeConfig: typeof getNodeConfig;
}

const realDeps: ConfigureNodeDeps = {
  setNodeConfig,
  initNodeFailover,
  getNodeConfig,
};

/**
 * Boot the StoaChain node failover for the wallet.
 *
 * Reads the persisted node preference (`getNodePreference`, defaulting to node1
 * when absent or recovered-from-corrupt) and applies it via the shared
 * `applySelector` — the SINGLE site mapping a preference to `setNodeConfig` and
 * enforcing the `setNodeConfig`-before-`initNodeFailover` ordering. Overriding
 * after init would silently boot onto the SDK-default node2, since failover-init
 * reads the configured primary at init time.
 *
 * A self-check then asserts the CONFIGURED primary matches the SELECTED
 * preference's expected host — node1 by default, node2 for a node2 pref, the
 * custom origin for a custom pref. Selecting the wrong primary is a
 * security-relevant misconfiguration that must fail loudly rather than route
 * signed transactions to the wrong host.
 *
 * A persisted `custom` preference is applied with the URL the user already
 * accepted; boot does NOT re-run the custom-node validation probe. The SDK's
 * `setNodeConfig` still parses + https-checks the URL synchronously, and the
 * failover health probe covers reachability — a broken custom node degrades via
 * failover/self-check rather than blocking boot.
 *
 * The transient runtime `active` host is NOT checked: if the primary's startup
 * probe fails, the SDK legitimately serves traffic from the fallback while
 * `primary` stays the selected host. That fallback is tolerated; only the
 * configured primary is asserted.
 *
 * @throws {Error} if the configured primary does not match the selected
 *   preference's expected host after the override.
 */
export async function configureNode(
  adapter: StorageAdapter,
  deps: Partial<ConfigureNodeDeps> = {},
): Promise<void> {
  const { setNodeConfig, initNodeFailover, getNodeConfig } = {
    ...realDeps,
    ...deps,
  };

  const preference = await getNodePreference(adapter);

  // Resolve the expected primary host BEFORE applying the caller's preference:
  // this probe applies+resets failover via the REAL SDK, so running it after the
  // override would clobber the override's configured primary.
  const expectedHost = expectedPrimaryHost(preference);

  await applySelector(preference, { setNodeConfig, initNodeFailover });

  const configuredPrimary = getNodeConfig().primary;
  if (configuredPrimary !== expectedHost) {
    // The error names the expected host (an SDK-derived public node host or the
    // origin-only custom host) and the actual configured primary — never the raw
    // user-supplied URL, which for custom equals its origin-only host anyway.
    throw new Error(
      `configureNode self-check failed: expected configured primary to be "${expectedHost}", ` +
        `but failover is configured with primary "${configuredPrimary}". The node override did not take effect.`,
    );
  }
}
