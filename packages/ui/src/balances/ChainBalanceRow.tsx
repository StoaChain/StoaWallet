import { type ReactNode } from 'react';

import { TokenGlyph } from '../theme/TokenGlyph';
import { type ChainBalanceStatus } from './balanceModel';
import styles from './ChainBalanceRow.module.css';

export interface ChainBalanceRowProps {
  /** The classified per-chain status to render. Drives the entire row. */
  readonly status: ChainBalanceStatus;
}

/**
 * One row of the per-chain balance list for StoaChain's 10 braided chains.
 *
 * Pure presentation: it renders the chain label plus a state-specific value for
 * each of the four `ChainBalanceStatus` kinds. It does no fetching, reads no
 * context, and imports nothing from core — the parent passes a fully classified
 * status. The four states are kept visually and structurally distinct so a user
 * can never confuse a present-but-empty (`zero`) account with a missing
 * (`absent`) one, nor mistake a failed read (`errored`) for either.
 */
export function ChainBalanceRow({ status }: ChainBalanceRowProps): ReactNode {
  return (
    <div className={styles.row} data-testid="chain-balance-row">
      <span className={styles.label}>Chain {status.chainId}</span>
      {renderValue(status)}
    </div>
  );
}

function renderValue(status: ChainBalanceStatus): ReactNode {
  switch (status.kind) {
    case 'funded':
      return (
        <span
          className={styles.value}
          data-testid="chain-balance-value"
          data-full-value={status.balance}
          title={status.balance}
        >
          {abbreviate(status.balance)}
          <TokenGlyph token="STOA" />
        </span>
      );

    case 'zero':
      return (
        <span
          className={`${styles.value} ${styles.zero}`}
          data-testid="chain-balance-value"
          data-full-value={status.balance}
          title={status.balance}
        >
          0
          <TokenGlyph token="STOA" />
        </span>
      );

    case 'absent':
      return (
        <span className={styles.absent} data-testid="chain-balance-absent">
          — no account
        </span>
      );

    case 'errored':
      return (
        <span
          className={styles.error}
          role="status"
          data-testid="chain-balance-error"
        >
          <WarningIcon />
          couldn&apos;t load — {status.error}
        </span>
      );
  }
}

/**
 * Abbreviate a 12-decimal balance for the row's limited width while keeping it
 * recognizable. The full precise value is always preserved on the element's
 * `data-full-value` / `title`, so trimming here never loses information.
 */
function abbreviate(balance: string): string {
  const [intPart, fracPart = ''] = balance.split('.');
  if (fracPart.length <= 6) return balance;
  return `${intPart}.${fracPart.slice(0, 6)}…`;
}

/** Inline warning glyph (lucide-react is not a dependency of this package). */
function WarningIcon(): ReactNode {
  return (
    <svg
      className={styles.errorIcon}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
