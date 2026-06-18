import { useEffect, useState } from 'react';

import { useWallet } from '../context/WalletContext';

/**
 * The MV3 popup-lifecycle guard.
 *
 * Chrome can terminate the background service worker at ANY time — discarding the
 * in-memory mnemonic — and the idle auto-lock clears it too. So the popup must NOT
 * trust its own cached "unlocked" assumption across teardown: it treats the
 * BACKGROUND as the single source of truth and re-derives the unlocked-state from
 * it on every popup open.
 *
 * On mount this asks the context (which forwards to the background `isUnlocked()`)
 * for the authoritative unlocked-state and reports one of:
 *   - `checking`  — the async background query is in flight (first paint).
 *   - `unlocked`  — the background holds a live session → render the wallet HOME.
 *   - `locked`    — the background holds NO session (SW terminated / auto-locked)
 *                   → route to re-unlock.
 *   - `local`     — NO background is wired (the web/test path); defer to the local
 *                   `activeAccount` state so the shell's pre-existing branching is
 *                   unchanged.
 *
 * It also surfaces the context's `sessionExpired` flag (set when a mid-session op
 * reported `locked`) and the `reportSessionLocked` trigger, so the shell can frame
 * a re-unlock as a distinct "session expired" event rather than a first-open lock.
 *
 * SECURITY: this holds no key material. It only reads booleans across the seam and
 * never logs a secret; the actual password is obtained fresh by the unlock screen.
 */
export type SessionGuardStatus = 'checking' | 'unlocked' | 'locked' | 'local';

export interface SessionGuard {
  readonly status: SessionGuardStatus;
  /** True when a mid-session op reported the background session had expired. */
  readonly sessionExpired: boolean;
  /** Flag a mid-session expiry (called when an op surfaces a `locked` reason). */
  reportSessionLocked(): void;
}

export function useSessionGuard(): SessionGuard {
  const { refreshRemoteUnlocked, remoteUnlocked, sessionExpired, reportSessionLocked } =
    useWallet();
  // Whether the first background query has resolved. Until it does the guard
  // reports `checking`; afterwards it derives the status REACTIVELY from the
  // context's `remoteUnlocked`, so an in-popup unlock/lock (which flips that
  // state) re-renders the shell to HOME / re-unlock without a fresh mount query.
  const [resolved, setResolved] = useState(false);
  // A fail-safe sticky `locked` for the MV3 rejected-query case, where there IS
  // a background (so `remoteUnlocked` would not be the local-path null) but the
  // query could not establish a connection.
  const [queryFailed, setQueryFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        // `refreshRemoteUnlocked` returns null on the web/test path (no
        // background) and stores the queried boolean into `remoteUnlocked`
        // otherwise — the guard derives its status from that reactive value.
        await refreshRemoteUnlocked();
        if (!alive) return;
        setResolved(true);
      } catch {
        // The background query rejected — the MV3 "could not establish
        // connection / port closed" case while the SW spins up. Fail SAFE to
        // `locked` (route to unlock) rather than spinning on `checking` forever.
        if (!alive) return;
        setQueryFailed(true);
        setResolved(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [refreshRemoteUnlocked]);

  // Derive the status from the reactive context state. Until the first query
  // resolves → `checking`. A rejected query is sticky `locked`. Then: `null`
  // (no background) → `local` (defer to `activeAccount`); a boolean → the live
  // background unlocked-state, which a successful in-popup unlock/lock updates.
  const status: SessionGuardStatus = !resolved
    ? 'checking'
    : queryFailed
      ? 'locked'
      : remoteUnlocked === null
        ? 'local'
        : remoteUnlocked
          ? 'unlocked'
          : 'locked';

  return { status, sessionExpired, reportSessionLocked };
}
