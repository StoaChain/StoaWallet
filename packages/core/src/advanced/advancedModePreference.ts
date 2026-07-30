/**
 * The persisted ADVANCED-MODE preference — whether the Advanced tab shows the
 * full multi-seed surface (every seed, pure keys, codex import) instead of just
 * the active seed. Non-secret wallet config (a single boolean), so it is stored
 * as an opaque serialized string via `StorageAdapter.set` — NEVER through the
 * vault's `smartEncrypt`.
 *
 * Reads are degrade-safe: an absent OR malformed blob resolves to the default
 * rather than throwing, so a fresh install or a tampered/legacy value can never
 * wedge the Advanced tab. The stored `enabled` must be a real boolean — a
 * truthy non-boolean (e.g. `"yes"`) degrades to the default rather than
 * coercing, so a tampered blob cannot silently widen the visible surface.
 */

import type { StorageAdapter } from '../storage';
import { ADVANCED_MODE_KEY } from '../storage/storageKeys';

/** Advanced mode is OFF until the user asks for it. */
export const DEFAULT_ADVANCED_MODE = false;

/** Decode a stored blob to a UTF-8 string regardless of the backend's representation. */
function blobToString(raw: string | Uint8Array): string {
  return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
}

/**
 * Read the advanced-mode flag. An absent key OR a malformed blob resolves to
 * {@link DEFAULT_ADVANCED_MODE}, never a throw.
 */
export async function getAdvancedMode(
  adapter: StorageAdapter,
): Promise<boolean> {
  const raw = await adapter.get(ADVANCED_MODE_KEY);
  if (raw === null) return DEFAULT_ADVANCED_MODE;
  try {
    const parsed = JSON.parse(blobToString(raw)) as { enabled?: unknown };
    if (typeof parsed?.enabled !== 'boolean') return DEFAULT_ADVANCED_MODE;
    return parsed.enabled;
  } catch {
    return DEFAULT_ADVANCED_MODE;
  }
}

/** Persist the advanced-mode flag. */
export async function setAdvancedMode(
  adapter: StorageAdapter,
  enabled: boolean,
): Promise<void> {
  await adapter.set(ADVANCED_MODE_KEY, JSON.stringify({ enabled }));
}
