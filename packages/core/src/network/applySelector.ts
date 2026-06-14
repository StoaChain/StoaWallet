/**
 * The single source of the `NodePreference.kind → setNodeConfig` mapping AND the
 * `setNodeConfig`-before-`initNodeFailover()` ordering.
 *
 * BOTH apply sites import this helper so neither restates the mapping or the
 * ordering: the runtime applier (`applyNodePreference`) and the startup applier
 * (Phase-1 `configureNode`, amended). Keeping the two paths convergent here is
 * what prevents them drifting — e.g. one site selecting node1 while the other
 * selects node2 for the same preference, or one running `initNodeFailover`
 * before `setNodeConfig` (which would boot onto the wrong primary, since
 * failover-init reads the configured primary host at init time).
 */
import {
  initNodeFailover,
  setNodeConfig,
} from '@stoachain/stoa-core/network';

import type { NodePreference } from './nodePreference';

/**
 * The SDK seam both apply sites delegate to. Real failover functions in
 * production, injectable doubles in tests. `getNodeConfig`/getters are read
 * directly from the SDK by callers — only the two mutating calls are seamed,
 * since they are the mapping + ordering this helper encapsulates.
 */
export interface ApplySelectorDeps {
  setNodeConfig: typeof setNodeConfig;
  initNodeFailover: typeof initNodeFailover;
}

const realDeps: ApplySelectorDeps = { setNodeConfig, initNodeFailover };

/**
 * Apply a `NodePreference` to the SDK failover config.
 *
 * Mapping: `default` → `setNodeConfig("node1")`; `node2` → `setNodeConfig("node2")`;
 * `custom` → `setNodeConfig("custom", customUrl)`. Then `initNodeFailover()`.
 *
 * The custom gas limit is DELIBERATELY left at the SDK default
 * (`CHAINWEB_DEFAULT_GAS_LIMIT`) by omitting `customNodeGasLimit` — a custom node
 * has no known block gas limit, so the conservative default applies (PAT-002).
 *
 * For `custom`, the `customUrl` MUST already be the validated origin-only URL —
 * the caller (the applier) runs the shape + probe gates first. This helper does
 * NOT re-validate; it is the bare mapping + ordering.
 */
export async function applySelector(
  pref: NodePreference,
  deps: Partial<ApplySelectorDeps> = {},
): Promise<void> {
  const { setNodeConfig, initNodeFailover } = { ...realDeps, ...deps };

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

  await initNodeFailover();
}
