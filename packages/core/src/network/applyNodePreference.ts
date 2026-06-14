/**
 * The runtime node-preference applier — the path the Settings UI drives to
 * change the active node WITHOUT a restart.
 *
 * It maps a {@link NodePreference} to the SDK failover config via the shared
 * {@link applySelector} (mapping + `setNodeConfig`-before-`initNodeFailover`
 * ordering), and for a `custom` node runs the full trust boundary (shape +
 * reachability/network-identity probe) BEFORE touching the SDK config.
 *
 * Two invariants govern every path here:
 *   1. **Never leave the wallet pointing at a broken endpoint.** A custom apply
 *      validates+probes FIRST; on ANY failure it returns a discriminated reason
 *      and does NOT call `setNodeConfig`, so the prior working config is retained.
 *   2. **The apply path NEVER throws.** Even a residual synchronous `TypeError`
 *      from `setNodeConfig` (e.g. a port-bearing URL the SDK rejects) is caught
 *      and converted to a discriminated `malformed-url`/`insecure-scheme` result.
 *
 * The candidate URL is written to NO `console.*`/logger in any path — failures
 * carry a reason code, never the untrusted URL.
 */
import type { StorageAdapter } from '../storage';
import {
  validateCustomNodeUrl,
  probeCustomNode,
  type NodeInfoReadDeps,
} from './customNodeValidation';
import { applySelector } from './applySelector';
import { setNodePreference, type NodePreference } from './nodePreference';

export { applySelector } from './applySelector';
export type { ApplySelectorDeps } from './applySelector';

/** Every reason a custom apply can fail — the union of shape + probe reasons. */
export type ApplyFailureReason =
  | 'malformed-url'
  | 'insecure-scheme'
  | 'unreachable'
  | 'wrong-network';

/**
 * Discriminated apply result. On success, `url` carries the origin-only custom
 * URL that was applied (for a `custom` apply) so a caller can persist exactly
 * what took effect; it is absent for `default`/`node2`.
 */
export type ApplyResult =
  | { ok: true; url?: string }
  | { ok: false; reason: ApplyFailureReason };

/** Options for the apply functions — the injectable probe network seam. */
export interface ApplyOptions {
  /** Injected `/info` read seam for the custom-node probe (tests stub it). */
  probeDeps?: NodeInfoReadDeps;
  /** Optional caller abort signal forwarded to the probe. */
  signal?: AbortSignal;
}

/**
 * Apply a node preference to the SDK failover config at runtime.
 *
 * `default`/`node2` apply directly via {@link applySelector}. `custom` runs the
 * shape gate then the live probe FIRST; on any failure it returns the reason and
 * leaves the prior config untouched. The selector call is additionally wrapped
 * so a residual synchronous `TypeError` becomes a discriminated result rather
 * than a throw (the apply path never throws).
 */
export async function applyNodePreference(
  pref: NodePreference,
  opts: ApplyOptions = {},
): Promise<ApplyResult> {
  if (pref.kind !== 'custom') {
    await applySelector(pref);
    return { ok: true };
  }

  const shape = validateCustomNodeUrl(pref.customUrl);
  if (!shape.ok) return { ok: false, reason: shape.reason };

  const probe = await probeCustomNode(shape.url, {
    deps: opts.probeDeps,
    signal: opts.signal,
  });
  if (!probe.ok) return { ok: false, reason: probe.reason };

  try {
    await applySelector({ kind: 'custom', customUrl: shape.url });
  } catch (err) {
    // The shape gate already guaranteed an https origin-only URL, so a throw
    // here is unexpected — but the apply path must never throw. Classify a
    // residual TypeError to the nearest shape reason WITHOUT echoing the URL.
    return {
      ok: false,
      reason:
        err instanceof TypeError && /scheme|protocol|https/i.test(err.message)
          ? 'insecure-scheme'
          : 'malformed-url',
    };
  }

  return { ok: true, url: shape.url };
}

/**
 * Apply a preference and, ONLY on success, persist it.
 *
 * Order is validate → apply → persist: a rejected custom URL never reaches
 * storage, so a broken endpoint can never be the persisted preference. For a
 * `custom` apply, the ORIGIN-only URL that actually took effect is persisted
 * (not the raw input), keeping storage and the live config in lock-step.
 */
export async function applyAndPersistNodePreference(
  pref: NodePreference,
  adapter: StorageAdapter,
  opts: ApplyOptions = {},
): Promise<ApplyResult> {
  const result = await applyNodePreference(pref, opts);
  if (!result.ok) return result;

  const toPersist: NodePreference =
    pref.kind === 'custom'
      ? { kind: 'custom', customUrl: result.url ?? pref.customUrl }
      : pref;

  await setNodePreference(adapter, toPersist);
  return result;
}

/**
 * Revert to the default node1-primary / node2-fallback failover in one action:
 * applies `{ kind: 'default' }` and persists it. Restores normal failover after
 * a custom node (which has no node1/node2 fallback) was in effect.
 */
export async function revertToDefault(
  adapter: StorageAdapter,
): Promise<ApplyResult> {
  return applyAndPersistNodePreference({ kind: 'default' }, adapter);
}
