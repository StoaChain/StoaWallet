import { type ReactNode } from 'react';

import { useAutoLock, type UseAutoLockOptions } from './useAutoLock';
import styles from './AutoLockCountdown.module.css';

/** Format milliseconds as `m:ss` (e.g. 4:07). Floors to whole seconds. */
function formatCountdown(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * A small header chip showing the time until the wallet auto-locks itself — a
 * lock glyph + `m:ss`, turning amber as it nears zero. Renders nothing when there
 * is no active auto-lock window (the web/mobile path, or a locked wallet). It also
 * carries the keepalive poll (see {@link useAutoLock}), so mounting it keeps the
 * MV3 worker alive while the popup is open.
 */
export function AutoLockCountdown(options: UseAutoLockOptions = {}): ReactNode {
  const { remainingMs, isActive } = useAutoLock(options);
  if (!isActive || remainingMs === null) return null;

  const urgent = remainingMs <= 30_000;
  return (
    <span
      className={`${styles.chip} ${urgent ? styles.urgent : ''}`}
      data-testid="auto-lock-countdown"
      title={`Wallet auto-locks in ${formatCountdown(remainingMs)}`}
      aria-label={`Wallet auto-locks in ${formatCountdown(remainingMs)}`}
    >
      <span className={styles.glyph} aria-hidden="true">
        🔒
      </span>
      {formatCountdown(remainingMs)}
    </span>
  );
}
