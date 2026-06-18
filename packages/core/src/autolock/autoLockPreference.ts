/**
 * The persisted AUTO-LOCK preference — how long the wallet stays unlocked after
 * the last activity before it locks itself. Non-secret wallet config (a tiny
 * integer of MINUTES), so it is stored as an opaque serialized string via
 * `StorageAdapter.set` — NEVER through the vault's `smartEncrypt`.
 *
 * Reads are degrade-safe: an absent OR malformed blob resolves to the default
 * rather than throwing, so a fresh install or a tampered/legacy value can never
 * wedge the auto-lock. The value is clamped to [MIN, MAX] minutes on both read
 * and write so a out-of-range stored value can never disable the lock or set an
 * absurd window.
 */

import type { StorageAdapter } from '../storage';
import { AUTO_LOCK_KEY } from '../storage/storageKeys';

/** The selectable auto-lock windows, in minutes — a fixed discrete set. */
export const AUTO_LOCK_OPTIONS = [5, 15, 30, 60] as const;
/** The shortest selectable auto-lock window, in minutes. */
export const MIN_AUTO_LOCK_MINUTES = AUTO_LOCK_OPTIONS[0];
/** The longest selectable auto-lock window, in minutes (product cap). */
export const MAX_AUTO_LOCK_MINUTES = AUTO_LOCK_OPTIONS[AUTO_LOCK_OPTIONS.length - 1];
/** The default window when nothing is stored. */
export const DEFAULT_AUTO_LOCK_MINUTES = 5;

/**
 * SNAP an arbitrary minute value to the nearest allowed {@link AUTO_LOCK_OPTIONS}
 * entry, so a stored/requested window is always one of the offered choices (5,
 * 15, 30, 60). A non-finite input falls back to the default. Ties favor the
 * smaller (more conservative) window.
 */
export function clampAutoLockMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return DEFAULT_AUTO_LOCK_MINUTES;
  return AUTO_LOCK_OPTIONS.reduce<number>(
    (best, opt) =>
      Math.abs(opt - minutes) < Math.abs(best - minutes) ? opt : best,
    AUTO_LOCK_OPTIONS[0],
  );
}

/** Decode a stored blob to a UTF-8 string regardless of the backend's representation. */
function blobToString(raw: string | Uint8Array): string {
  return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
}

/**
 * Read the auto-lock window in MINUTES. An absent key OR a malformed/out-of-range
 * blob resolves to {@link DEFAULT_AUTO_LOCK_MINUTES} (clamped), never a throw.
 */
export async function getAutoLockMinutes(
  adapter: StorageAdapter,
): Promise<number> {
  const raw = await adapter.get(AUTO_LOCK_KEY);
  if (raw === null) return DEFAULT_AUTO_LOCK_MINUTES;
  try {
    const parsed = JSON.parse(blobToString(raw)) as { minutes?: unknown };
    if (typeof parsed?.minutes !== 'number') return DEFAULT_AUTO_LOCK_MINUTES;
    return clampAutoLockMinutes(parsed.minutes);
  } catch {
    return DEFAULT_AUTO_LOCK_MINUTES;
  }
}

/** Persist the auto-lock window in MINUTES (clamped to [MIN, MAX]). */
export async function setAutoLockMinutes(
  adapter: StorageAdapter,
  minutes: number,
): Promise<number> {
  const clamped = clampAutoLockMinutes(minutes);
  await adapter.set(AUTO_LOCK_KEY, JSON.stringify({ minutes: clamped }));
  return clamped;
}
