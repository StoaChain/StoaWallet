import { useCallback, useState, type ReactNode } from 'react';
import { QRCodeSVG } from 'qrcode.react';

import { useWallet } from '../context/WalletContext';
import styles from './ReceiveView.module.css';

/**
 * The RECEIVE screen: surface the active `k:` account's address so funds can be
 * sent to it.
 *
 * It renders the address three complementary ways, never just one:
 *   - as FULL selectable/copyable text (a user can hand-select the whole key),
 *   - as a scannable QR encoding the EXACT address (a sender scans it), and
 *   - behind a one-tap copy control with confirmation feedback.
 *
 * When no account is active (locked / no wallet) it shows a neutral idle
 * affordance and renders NO QR — encoding an empty value would produce a
 * garbage code a sender could scan into a void. The address is never logged.
 */
export function ReceiveView(): ReactNode {
  const { activeAccount } = useWallet();
  const address = activeAccount?.account ?? null;
  const [copied, setCopied] = useState(false);

  const copyAddress = useCallback(async () => {
    if (address === null) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      // Clipboard access can be denied; the address is still selectable on
      // screen, so a copy failure is non-fatal and intentionally quiet.
      setCopied(false);
    }
  }, [address]);

  if (address === null) {
    return (
      <section className={styles.view} data-testid="receive-idle">
        <p className={styles.idle}>
          No wallet unlocked — unlock to see your receive address.
        </p>
      </section>
    );
  }

  return (
    <section className={styles.view} data-testid="receive-view">
      <h1 className={styles.heading}>Receive</h1>
      <p className={styles.subheading}>
        Share this address or QR to receive Stoa Coin on this account.
      </p>

      {/* `key={address}` remounts the QR + resets the copied flag whenever the
          active account changes, so a scan never reflects a stale address. */}
      <div className={styles.qrFrame} data-testid="receive-qr" data-qr-value={address}>
        <QRCodeSVG key={address} value={address} className={styles.qr} />
      </div>

      <p className={styles.address} data-testid="receive-address">
        {address}
      </p>

      <button
        type="button"
        className={styles.copy}
        onClick={() => void copyAddress()}
      >
        {copied ? 'Copied' : 'Copy address'}
      </button>
    </section>
  );
}
