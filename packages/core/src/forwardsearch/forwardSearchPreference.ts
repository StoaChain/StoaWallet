/**
 * The persisted, WALLET-WIDE FORWARD KEY-SEARCH preference.
 *
 * By DEFAULT the wallet resolves a key only from what it HOLDS — pure/imported
 * keys and explicitly-added accounts. Forward search is an ADVANCED opt-in: when
 * enabled, key resolution-by-address additionally probes a bounded range of
 * derivation indices per seed (the `depth`) to find an address a seed controls
 * but hasn't added. It applies wherever the wallet resolves a key by address
 * (today: the "sign a message" tool).
 *
 * Non-secret config, stored as an opaque serialized blob via `StorageAdapter.set`
 * — NEVER through the vault's `smartEncrypt`. Reads are degrade-safe (absent or
 * malformed → defaults, never a throw). `depth` snaps to an offered option and is
 * capped at 100 because BIP32-Ed25519 derivation is expensive and a deeper scan
 * would freeze the signer for too long.
 */

import type { StorageAdapter } from '../storage';
import { FORWARD_SEARCH_KEY } from '../storage/storageKeys';

/** The selectable forward-search depths — a fixed discrete set. */
export const FORWARD_SEARCH_OPTIONS = [30, 50, 100] as const;
/** The shallowest selectable depth. */
export const MIN_FORWARD_SEARCH_DEPTH = FORWARD_SEARCH_OPTIONS[0];
/** The deepest selectable depth (product cap — derivation cost). */
export const MAX_FORWARD_SEARCH_DEPTH = FORWARD_SEARCH_OPTIONS[FORWARD_SEARCH_OPTIONS.length - 1];
/** The default depth when nothing is stored (only relevant once enabled). */
export const DEFAULT_FORWARD_SEARCH_DEPTH = 30;

/** The wallet-wide forward-search preference. */
export interface ForwardSearchPref {
  /** Off by default — the wallet uses only keys it holds (pure + added). */
  readonly enabled: boolean;
  /** Indices probed per seed when enabled (snapped to an option, capped 100). */
  readonly depth: number;
}

/** The default: forward search OFF, depth 30 (used once turned on). */
export const DEFAULT_FORWARD_SEARCH: ForwardSearchPref = { enabled: false, depth: DEFAULT_FORWARD_SEARCH_DEPTH };

/**
 * SNAP an arbitrary depth to the nearest allowed {@link FORWARD_SEARCH_OPTIONS}
 * entry (30 / 50 / 100). A non-finite input falls back to the default. Ties
 * favor the smaller (cheaper) depth.
 */
export function clampForwardSearchDepth(depth: number): number {
  if (!Number.isFinite(depth)) return DEFAULT_FORWARD_SEARCH_DEPTH;
  return FORWARD_SEARCH_OPTIONS.reduce<number>(
    (best, opt) => (Math.abs(opt - depth) < Math.abs(best - depth) ? opt : best),
    FORWARD_SEARCH_OPTIONS[0],
  );
}

/** Decode a stored blob to a UTF-8 string regardless of the backend's representation. */
function blobToString(raw: string | Uint8Array): string {
  return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
}

/**
 * Read the wallet-wide forward-search preference. An absent key OR a malformed
 * blob resolves to {@link DEFAULT_FORWARD_SEARCH} (off), never a throw. `depth`
 * is always snapped to an offered option.
 */
export async function getForwardSearchPref(adapter: StorageAdapter): Promise<ForwardSearchPref> {
  const raw = await adapter.get(FORWARD_SEARCH_KEY);
  if (raw === null) return DEFAULT_FORWARD_SEARCH;
  try {
    const parsed = JSON.parse(blobToString(raw)) as { enabled?: unknown; depth?: unknown };
    return {
      enabled: parsed?.enabled === true,
      depth:
        typeof parsed?.depth === 'number'
          ? clampForwardSearchDepth(parsed.depth)
          : DEFAULT_FORWARD_SEARCH_DEPTH,
    };
  } catch {
    return DEFAULT_FORWARD_SEARCH;
  }
}

/**
 * Persist a partial update to the forward-search preference (merged over the
 * current value; `depth` snapped). Returns the new effective preference.
 */
export async function setForwardSearchPref(
  adapter: StorageAdapter,
  patch: Partial<ForwardSearchPref>,
): Promise<ForwardSearchPref> {
  const current = await getForwardSearchPref(adapter);
  const next: ForwardSearchPref = {
    enabled: patch.enabled ?? current.enabled,
    depth: clampForwardSearchDepth(patch.depth ?? current.depth),
  };
  await adapter.set(FORWARD_SEARCH_KEY, JSON.stringify(next));
  return next;
}
