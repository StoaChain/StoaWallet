/**
 * The persisted node-failover PREFERENCE — non-secret wallet config, NOT the
 * encrypted vault. It records which node the wallet should lead with:
 *   - `default` — node1-primary with node2 as fallback (the wallet's baseline).
 *   - `node2`   — flip the lead to node2 (node1 stays as fallback).
 *   - `custom`  — a user-supplied RPC base URL (`customUrl`).
 *
 * Because this is plain config (a tiny `{ kind, customUrl? }` JSON), it is
 * stored as an opaque serialized string via `StorageAdapter.set` — NEVER through
 * `smartEncrypt`, which is reserved for the seed/vault envelope. Reads are
 * degrade-safe: an absent OR malformed blob resolves to the default rather than
 * throwing, so a fresh install or a tampered/legacy value can never wedge boot.
 */

import type { StorageAdapter } from '../storage';
import { NODE_PREFERENCE_KEY } from '../storage/storageKeys';

/**
 * The wallet's node selection.
 *
 * INVARIANT (enforced by the validator below, not merely the type): a `custom`
 * preference MUST carry a non-empty `customUrl`; `default`/`node2` MUST NOT
 * carry one. `recoveredFromCorrupt` is set ONLY on a degraded read — a clean
 * default never sets it — so a caller can tell "user chose default" apart from
 * "we reset a corrupt setting" and surface a one-time reset notice for the latter.
 */
export type NodePreference =
  | { kind: 'default'; customUrl?: undefined; recoveredFromCorrupt?: true }
  | { kind: 'node2'; customUrl?: undefined; recoveredFromCorrupt?: true }
  | { kind: 'custom'; customUrl: string; recoveredFromCorrupt?: undefined };

/** The node1-primary / node2-fallback baseline, returned for absent reads. */
const DEFAULT_PREFERENCE: NodePreference = { kind: 'default' };

/** A degraded default, flagged so a later phase can show a "setting was reset" notice. */
const RECOVERED_DEFAULT: NodePreference = {
  kind: 'default',
  recoveredFromCorrupt: true,
};

/**
 * Validate a candidate preference against the kind/customUrl invariant.
 *
 * Returns the narrowed `NodePreference` on success or `null` on any violation —
 * an unknown `kind`, a `custom` without a non-empty `customUrl`, or a
 * `default`/`node2` that wrongly carries a `customUrl`. The `recoveredFromCorrupt`
 * flag is a READ- side artifact and is intentionally NOT accepted from a blob.
 */
function validateNodePreference(value: unknown): NodePreference | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;

  if (v.kind === 'custom') {
    return typeof v.customUrl === 'string' && v.customUrl.length > 0
      ? { kind: 'custom', customUrl: v.customUrl }
      : null;
  }

  if (v.kind === 'default' || v.kind === 'node2') {
    // A non-custom kind must not smuggle a URL through.
    return v.customUrl === undefined ? { kind: v.kind } : null;
  }

  return null;
}

/**
 * Read the persisted node preference.
 *
 * An ABSENT key resolves to `{ kind: 'default' }` (backward compat — a fresh
 * install has no blob). A MALFORMED blob (invalid JSON or a structurally-wrong
 * shape) degrades to `{ kind: 'default', recoveredFromCorrupt: true }` rather
 * than throwing, so corruption surfaces as a one-time reset instead of a crash.
 */
export async function getNodePreference(
  adapter: StorageAdapter,
): Promise<NodePreference> {
  const raw = await adapter.get(NODE_PREFERENCE_KEY);
  if (raw === null) return DEFAULT_PREFERENCE;

  const text = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return RECOVERED_DEFAULT;
  }

  return validateNodePreference(parsed) ?? RECOVERED_DEFAULT;
}

/**
 * Persist a node preference as an opaque serialized string.
 *
 * Validates the kind/customUrl invariant BEFORE writing — a `custom` without a
 * non-empty `customUrl`, or a `default`/`node2` carrying one, is rejected and
 * nothing is persisted. The `recoveredFromCorrupt` read-flag is never written.
 *
 * @throws {Error} if `pref` violates the kind/customUrl invariant.
 */
export async function setNodePreference(
  adapter: StorageAdapter,
  pref: NodePreference,
): Promise<void> {
  const validated = validateNodePreference(pref);
  if (validated === null) {
    // Deliberately does NOT echo the URL — keeps a user's custom RPC out of any
    // error string that might be logged upstream.
    throw new Error(
      `Invalid node preference for kind "${(pref as { kind?: unknown }).kind}": ` +
        'a "custom" preference requires a non-empty customUrl, and "default"/"node2" must not carry one.',
    );
  }

  await adapter.set(NODE_PREFERENCE_KEY, JSON.stringify(validated));
}
