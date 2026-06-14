import { type StoredAccount } from '@stoawallet/core';
import { useState, type ReactNode } from 'react';

import { useWallet } from '../context/WalletContext';
import styles from './AccountSwitcher.module.css';

/**
 * Render a `k:` address compactly: keep the `k:` prefix + first 4 hex and the
 * last 4 hex, eliding the rest. A 64-char key never fits a popup row, and the
 * head+tail is enough for a human to recognize the account at a glance.
 */
function truncateAddress(account: string): string {
  const hex = account.startsWith('k:') ? account.slice(2) : account;
  if (hex.length <= 8) return account;
  return `k:${hex.slice(0, 4)}…${hex.slice(-4)}`;
}

export interface AccountSwitcherProps {
  /**
   * Optional override for the active wallet's derived accounts. By default the
   * switcher reads `activeWalletAccounts` straight off the wallet context (which
   * refreshes after every addAccount / switchAccount); this prop only exists so
   * a caller can render a fixed list in isolation.
   */
  readonly accounts?: readonly StoredAccount[];
}

export function AccountSwitcher({ accounts }: AccountSwitcherProps): ReactNode {
  const { activeAccount, activeWalletAccounts, switchAccount, addAccount } =
    useWallet();
  const rows = accounts ?? activeWalletAccounts;
  const activeIndex = activeAccount?.index ?? null;
  const [error, setError] = useState<string | null>(null);

  const failureMessage = 'Unlock the wallet to manage accounts.';

  const onSwitch = async (index: number) => {
    const result = await switchAccount(index);
    setError(result.ok ? null : failureMessage);
  };

  const onAdd = async () => {
    const result = await addAccount();
    setError(result.ok ? null : failureMessage);
  };

  return (
    <div className={styles.switcher}>
      <div className={styles.list}>
        {rows.map((acct) => {
          const isActive = acct.index === activeIndex;
          return (
            <button
              key={acct.index}
              type="button"
              className={`${styles.row} ${isActive ? styles.rowActive : ''}`}
              aria-pressed={isActive}
              aria-label={`Account #${acct.index}`}
              onClick={() => void onSwitch(acct.index)}
            >
              <span className={styles.index}>#{acct.index}</span>
              <span className={styles.address}>
                {truncateAddress(acct.account)}
              </span>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        className={styles.add}
        aria-label="Add account"
        onClick={() => void onAdd()}
      >
        Add account
      </button>

      {error !== null ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
