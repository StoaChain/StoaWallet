import { coreInfo } from '@stoawallet/core';
import { type ReactNode } from 'react';

import { TokenGlyph } from '../theme/TokenGlyph';
import styles from './BalancesView.module.css';
import { ChainBalanceRow } from './ChainBalanceRow';
import { type GetBalancesFn, useBalances } from './useBalances';

export interface BalancesViewProps {
  /**
   * The `k:` account to read. When omitted the view resolves the active account
   * from `useWallet()`; `null` is the explicit idle/locked signal. Wired by the
   * app shell — tests inject it to render a specific account deterministically.
   */
  readonly account?: string | null;
  /** Override the core read (tests inject a stub); defaults to the real read. */
  readonly getBalances?: GetBalancesFn;
}

const TOTAL_CHAINS = coreInfo.chainCount;

/**
 * The cross-chain balances screen: a prominent aggregate total on top followed
 * by one row per StoaChain braided chain.
 *
 * It composes `useBalances` and renders a distinct affordance for every state so
 * the user is never misled:
 *   - idle/locked  → a neutral "no wallet" panel, never a loader or a "0".
 *   - loading      → a skeleton, never a blank screen or a premature "0 total".
 *   - total error  → a whole-view error with retry, separate from per-chain rows.
 *   - all-errored  → an "unable to load" hero, never a plain "0" reading as empty.
 *   - partial      → the total is footnoted "N of 10" with a retry when some
 *                    chains failed; the successful rows and figure still show.
 * A refresh keeps the existing rows + total on screen (it does NOT blank) and
 * marks the refresh in progress.
 */
export function BalancesView({
  account,
  getBalances,
}: BalancesViewProps): ReactNode {
  const {
    chains,
    total,
    isLoading,
    isRefreshing,
    error,
    refreshError,
    isIdle,
    refresh,
  } = useBalances({ account, getBalances });

  if (isIdle) {
    return (
      <section className={styles.view} data-testid="balances-idle">
        <p className={styles.idle}>No wallet unlocked — unlock to see balances.</p>
      </section>
    );
  }

  if (error !== null) {
    return (
      <section className={styles.view} data-testid="balances-error">
        <p className={styles.errorText}>Couldn&apos;t load balances.</p>
        <button
          type="button"
          className={styles.retry}
          onClick={() => void refresh()}
        >
          Retry
        </button>
      </section>
    );
  }

  if (isLoading) {
    return (
      <section className={styles.view} data-testid="balances-loading">
        <div className={styles.heroSkeleton} aria-hidden="true" />
        <div className={styles.rowsSkeleton} aria-hidden="true">
          {Array.from({ length: TOTAL_CHAINS }, (_, i) => (
            <div key={i} className={styles.rowSkeleton} />
          ))}
        </div>
        <span className={styles.srOnly} role="status">
          Loading balances…
        </span>
      </section>
    );
  }

  const unableToLoad =
    total.includedChains === 0 && total.erroredChains > 0;
  const includedChains = TOTAL_CHAINS - total.erroredChains;
  const isPartial = total.erroredChains > 0;

  return (
    <section className={styles.view} data-testid="balances-view">
      <div className={styles.hero} data-testid="balances-total">
        {unableToLoad ? (
          <span className={styles.heroUnknown}>Unable to load</span>
        ) : (
          <span className={styles.heroAmount}>
            {abbreviate(total.total)}
            <TokenGlyph token="STOA" className={styles.heroGlyph} />
          </span>
        )}
        {isPartial && (
          <span
            className={styles.partial}
            data-testid="balances-total-partial"
            role="status"
          >
            {unableToLoad
              ? `couldn't load any of ${TOTAL_CHAINS} chains`
              : `total across ${includedChains} of ${TOTAL_CHAINS} chains — some failed to load`}
          </span>
        )}
        {isRefreshing && (
          <span
            className={styles.refreshing}
            data-testid="balances-refreshing"
            role="status"
          >
            Refreshing…
          </span>
        )}
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.refresh}
          onClick={() => void refresh()}
          disabled={isRefreshing}
        >
          Refresh
        </button>
        {isPartial && (
          <button
            type="button"
            className={styles.retry}
            onClick={() => void refresh()}
            disabled={isRefreshing}
          >
            Retry
          </button>
        )}
        {refreshError !== null && (
          <span
            className={styles.refreshFailed}
            data-testid="balances-refresh-failed"
            role="status"
          >
            Refresh failed —{' '}
            <button
              type="button"
              className={styles.retry}
              onClick={() => void refresh()}
              disabled={isRefreshing}
            >
              retry
            </button>
          </span>
        )}
      </div>

      <div className={styles.rows}>
        {chains.map((status) => (
          <ChainBalanceRow key={status.chainId} status={status} />
        ))}
      </div>
    </section>
  );
}

/**
 * Abbreviate the 12-decimal aggregate for the hero's display width while keeping
 * the leading significant digits. The per-chain rows preserve full precision via
 * their own `data-full-value`, so the hero trimming never hides exact balances.
 */
function abbreviate(amount: string): string {
  const [intPart, fracPart = ''] = amount.split('.');
  if (fracPart.length <= 4) return amount;
  const trimmed = fracPart.slice(0, 4).replace(/0+$/, '');
  return trimmed.length > 0 ? `${intPart}.${trimmed}` : intPart;
}
