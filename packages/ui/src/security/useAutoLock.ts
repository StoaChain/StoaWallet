import { useCallback, useEffect, useRef, useState } from 'react';

import { useWallet } from '../context/WalletContext';

/**
 * The auto-lock countdown + keepalive hook (extension path).
 *
 * It polls the background's session tick (`getSession`) on an interval. That poll
 * does DOUBLE duty:
 *   1. KEEPALIVE — each message resets the MV3 worker's ~30s idle-termination
 *      timer, so the in-memory unlocked session survives the user filling a form
 *      (the fix for "wallet is locked on every send").
 *   2. COUNTDOWN — the tick reports the epoch-ms auto-lock instant; the hook
 *      renders a local 1s countdown from it and, when it reaches zero, locks
 *      immediately (so the lock is exact, not up to one poll late).
 *
 * On the web/mobile path `getSession` resolves null (no background worker / no
 * auto-lock window) and the hook reports `isActive: false` so the UI hides the
 * countdown. Holds no key material.
 */
export interface UseAutoLockResult {
  /** Milliseconds until auto-lock, or null when there is no active window. */
  readonly remainingMs: number | null;
  /** The configured window in minutes (0 when unknown / inactive). */
  readonly autoLockMinutes: number;
  /** True when an auto-lock window is live (the countdown should render). */
  readonly isActive: boolean;
}

export interface UseAutoLockOptions {
  /** Poll cadence in ms (keepalive + tick). Default 10s — under the MV3 ~30s floor. */
  readonly pollMs?: number;
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export function useAutoLock(options: UseAutoLockOptions = {}): UseAutoLockResult {
  const { getSession, lock, refreshRemoteUnlocked } = useWallet();
  const pollMs = options.pollMs ?? 10_000;
  const clock = options.now ?? (() => Date.now());

  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [autoLockMinutes, setAutoLockMinutes] = useState(0);
  const [nowMs, setNowMs] = useState(() => clock());
  // Guard against a double-lock (the zero-tick effect + the poll both noticing).
  const lockedRef = useRef(false);

  // Poll the background session tick: keepalive + read the live expiry.
  useEffect(() => {
    let alive = true;
    async function poll(): Promise<void> {
      const status = await getSession();
      if (!alive) return;
      if (status === null) {
        setExpiresAt(null);
        return;
      }
      setExpiresAt(status.expiresAt);
      setAutoLockMinutes(status.autoLockMinutes);
      // The tick locked the wallet (window elapsed while we were away) — reflect it.
      if (!status.unlocked && status.expiresAt === null) {
        void refreshRemoteUnlocked();
      }
    }
    void poll();
    const id = setInterval(() => void poll(), pollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [getSession, pollMs, refreshRemoteUnlocked]);

  // Local 1s tick so the displayed countdown advances between polls.
  useEffect(() => {
    if (expiresAt === null) return;
    lockedRef.current = false;
    const id = setInterval(() => setNowMs(clock()), 1000);
    return () => clearInterval(id);
    // `clock` is stable in practice; intentionally keyed on the window only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt]);

  const remainingMs =
    expiresAt === null ? null : Math.max(0, expiresAt - nowMs);

  // Lock the instant the countdown hits zero — don't wait for the next poll.
  const lockNow = useCallback(() => {
    if (lockedRef.current) return;
    lockedRef.current = true;
    void lock();
    void refreshRemoteUnlocked();
  }, [lock, refreshRemoteUnlocked]);

  useEffect(() => {
    if (expiresAt !== null && remainingMs === 0) lockNow();
  }, [expiresAt, remainingMs, lockNow]);

  return {
    remainingMs,
    autoLockMinutes,
    isActive: expiresAt !== null,
  };
}
