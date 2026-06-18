import { AUTO_LOCK_OPTIONS, getAutoLockMinutes } from '@stoawallet/core';
import { useEffect, useState, type ReactNode } from 'react';

import { useWallet } from '../context/WalletContext';
import styles from './AutoLockSettings.module.css';

/** The selectable auto-lock windows (minutes): 5, 15, 30, 60. */
const MINUTE_OPTIONS = AUTO_LOCK_OPTIONS;

/**
 * The auto-lock duration setting: how long the wallet stays unlocked after the
 * last activity before it locks itself (1–6 minutes). Reads the current window
 * from the background session tick (extension) or the persisted preference
 * (web/mobile), and writes through the wallet context — which updates the live
 * background window AND persists it.
 */
export function AutoLockSettings(): ReactNode {
  const { getSession, setAutoLock, storage } = useWallet();
  const [minutes, setMinutes] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  // Load the current window: prefer the live background tick, fall back to the
  // persisted preference when there is no background (web/mobile).
  useEffect(() => {
    let alive = true;
    void (async () => {
      const session = await getSession();
      if (!alive) return;
      if (session !== null) {
        setMinutes(session.autoLockMinutes);
        return;
      }
      setMinutes(await getAutoLockMinutes(storage));
    })();
    return () => {
      alive = false;
    };
  }, [getSession, storage]);

  async function onChange(next: number): Promise<void> {
    setSaving(true);
    try {
      const applied = await setAutoLock(next);
      setMinutes(applied);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={styles.section} data-testid="auto-lock-settings">
      <h3 className={styles.heading}>Auto-lock</h3>
      <p className={styles.help}>
        Lock the wallet automatically after this long without activity.
      </p>
      <label className={styles.row}>
        <span className={styles.label}>Lock after</span>
        <select
          data-testid="auto-lock-minutes"
          className={styles.select}
          value={minutes ?? ''}
          disabled={minutes === null || saving}
          onChange={(e) => void onChange(Number(e.target.value))}
        >
          {MINUTE_OPTIONS.map((m) => (
            <option key={m} value={m}>
              {m} minute{m === 1 ? '' : 's'}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}
