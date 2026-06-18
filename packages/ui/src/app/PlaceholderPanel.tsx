import { type ReactNode } from 'react';

import styles from './PlaceholderPanel.module.css';

export interface PlaceholderPanelProps {
  /** The destination title shown above the explanatory line. */
  readonly title: string;
  /** A short line explaining the destination is not built yet. */
  readonly message: string;
}

/**
 * A neutral coming-soon panel for nav destinations that are not yet built. Used
 * for Fiat-Ramp (no on/off-ramp wired yet) and Advanced (rebuilt in a later
 * increment) so the nav has a real, non-misleading body for every destination.
 */
export function PlaceholderPanel({
  title,
  message,
}: PlaceholderPanelProps): ReactNode {
  return (
    <section className={styles.panel} data-testid="placeholder-panel">
      <h2 className={styles.title}>{title}</h2>
      <p className={styles.message}>{message}</p>
    </section>
  );
}
