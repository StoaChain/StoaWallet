import type { ReactNode } from 'react';

import styles from './ApprovalApp.module.css';

/**
 * The shared approval chrome: a prominent ORIGIN header with "this site is
 * requesting…" framing, and the explicit APPROVE (filled gold) / REJECT (gold
 * outline) action pair. Both the connection and signature views render this so
 * the origin appears on BOTH and the decision affordances are identical.
 */

export interface ApprovalHeaderProps {
  /** The canonical origin the router verified — shown prominently, verbatim. */
  readonly origin: string;
  /** The view title (e.g. "Connect to wallet" / "Sign transaction"). */
  readonly title: string;
  /** The "…is requesting…" framing line. */
  readonly framing: string;
}

export function ApprovalHeader({
  origin,
  title,
  framing,
}: ApprovalHeaderProps): ReactNode {
  return (
    <header className={styles.header}>
      <p className={styles.framing}>{framing}</p>
      <span className={styles.origin} data-testid="approval-origin">
        {origin}
      </span>
      <h1 className={styles.title}>{title}</h1>
    </header>
  );
}

export interface ApprovalActionsProps {
  readonly approveLabel: string;
  readonly onApprove: () => void;
  readonly onReject: () => void;
}

export function ApprovalActions({
  approveLabel,
  onApprove,
  onReject,
}: ApprovalActionsProps): ReactNode {
  return (
    <div className={styles.actions}>
      <button
        type="button"
        className={styles.reject}
        data-testid="approval-reject"
        onClick={onReject}
      >
        Reject
      </button>
      <button
        type="button"
        className={styles.approve}
        data-testid="approval-approve"
        onClick={onApprove}
      >
        {approveLabel}
      </button>
    </div>
  );
}
