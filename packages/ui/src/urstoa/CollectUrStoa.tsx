import { useEffect, useRef, type ReactNode } from 'react';

import { StoaMark } from './glyph';
import { unwrapDecimal } from './amount';
import { useToast } from '../toast/ToastContext';
import { useTxToast } from '../toast/useTxToast';
import styles from './CollectUrStoa.module.css';
import {
  useCollectUrStoa,
  type UseCollectUrStoaOptions,
} from './useCollectUrStoa';

export interface CollectUrStoaProps {
  /**
   * The vault's accrued earnings as the RAW read value from the holdings hook
   * (a Pact `{ decimal }` envelope, a plain number, a string, or `null`). It is
   * forwarded VERBATIM to `useCollectUrStoa`, which owns the non-zero gate
   * (unwrap + numeric `> 0`); the view only DISPLAYS the unwrapped figure and
   * never re-implements the gate with `String()`/truthiness (RR#7).
   */
  readonly earnings?: unknown;
  /**
   * Options forwarded to `useCollectUrStoa` — the stubbed core Collect op, the
   * signer resolver, and the on-success holdings refresh. The card (T12.10) wires
   * the real ops; tests inject stubs. `earnings` is merged in from the prop above.
   */
  readonly hookOptions?: Omit<UseCollectUrStoaOptions, 'earnings'>;
  /** Called when a `locked` error should route the user to unlock. */
  readonly onRequireUnlock?: () => void;
  /** Dismiss the modal (the UrStoa tab owns the open-state and closes it). */
  readonly onClose?: () => void;
}

/** Statuses during which the Collect control must be disabled (double-submit). */
const IN_FLIGHT = new Set<string>(['building', 'submitting']);

/**
 * The COLLECT action surface for the UrStoa vault: it shows the claimable vault
 * earnings denominated in STOA (gold ❖) and a single gasless Collect control that
 * composes `useCollectUrStoa`. The button's enabled state binds to the hook's
 * `canCollect` (the hook's `{decimal}`-unwrap + numeric `> 0` gate — NEVER a
 * view-side `String()` on the envelope, which would stringify `{decimal:"0"}` to
 * the truthy "[object Object]" and wrongly enable a zero Collect, RR#7), and it is
 * additionally locked while a submit is in flight.
 *
 * Every terminal state gets a DISTINCT affordance so the user is never misled:
 *   - in-flight → an honest "collecting" stage; the control is disabled.
 *   - success   → the request key (the earnings move to the coin balance on the
 *                 hook-driven holdings refresh).
 *   - locked    → routes to unlock rather than a generic error.
 *   - pending   → a "submitted — confirmation unknown" message, never a success.
 *   - error     → a distinct failure message, never a false success.
 *
 * The create-account-when-absent path is handled transparently in core (T12.4) —
 * the UI does NOT branch on it. Presentation + the hook only: no core import, no
 * signing, no telemetry (nothing logs the earnings or any key material).
 */
export function CollectUrStoa({
  earnings,
  hookOptions,
  onRequireUnlock,
  onClose,
}: CollectUrStoaProps): ReactNode {
  const { state, canCollect, collect } = useCollectUrStoa({
    ...hookOptions,
    earnings,
  });

  const status = state.status;
  const inFlight = IN_FLIGHT.has(status);
  const isLocked = status === 'error' && state.reason === 'locked';

  // Once SUBMITTED, hand off to the shared floating tx toast + return to overview.
  const trackTx = useTxToast();
  const toast = useToast();
  const refresh = hookOptions?.refresh;
  const firedRef = useRef<string | null>(null);
  useEffect(() => {
    if (status !== 'success' && status !== 'pending') return;
    const requestKey =
      'requestKey' in state ? (state.requestKey ?? undefined) : undefined;
    const fireKey = requestKey ?? (status === 'pending' ? 'pending' : null);
    if (fireKey === null || firedRef.current === fireKey) return;
    firedRef.current = fireKey;
    if (requestKey !== undefined) {
      trackTx({ requestKey, chainId: '0', label: 'Collect', onConfirmed: refresh });
    } else {
      toast.show({
        status: 'info',
        title: 'Collect submitted',
        detail: 'Confirmation unknown — check the explorer.',
        autoDismissMs: 9000,
      });
    }
    onClose?.();
  }, [status, state, trackTx, toast, refresh, onClose]);

  // The displayed figure is the SAME `{decimal}`-unwrap the gate uses (never the
  // "[object Object]" String() of the raw envelope). The hook still owns the
  // enable/disable decision via `canCollect`.
  const displayEarnings = String(unwrapDecimal(earnings ?? '0'));

  if (isLocked) {
    return (
      <section className={styles.page} data-testid="collect-locked">
        <p className={styles.lockedText}>
          Your wallet is locked — unlock it to collect.
        </p>
        <button
          type="button"
          data-testid="collect-unlock"
          className={styles.primary}
          onClick={() => onRequireUnlock?.()}
        >
          Unlock
        </button>
      </section>
    );
  }

  return (
    <section className={styles.page} data-testid="collect-urstoa">
      <div className={styles.earningsRow}>
        <span className={styles.earningsLabel}>Claimable earnings</span>
        <span className={styles.earningsValue} data-testid="collect-earnings">
          <span className={styles.mono}>{displayEarnings}</span>{' '}
          <StoaMark className={styles.amountGlyph} />
        </span>
      </div>

      <span className={styles.gaslessBadge} data-testid="gasless-badge">
        gasless — the gas station pays
      </span>

      <button
        type="button"
        data-testid="collect-submit"
        className={styles.primary}
        onClick={() => void collect()}
        disabled={!canCollect || inFlight}
      >
        Collect
      </button>

      {inFlight && (
        <div className={styles.stage} role="status" data-testid="collect-stage">
          Collecting earnings…
        </div>
      )}

      {/* Submitted/pending outcomes are handed to the floating tx toast (which
          confirms on-chain + auto-dismisses); the page returns to the overview. */}

      {status === 'error' && state.reason !== 'locked' && (
        <div className={styles.error} role="alert" data-testid="collect-error">
          <p className={styles.errorText}>
            The collect couldn&apos;t be completed. Try again.
          </p>
        </div>
      )}
    </section>
  );
}
