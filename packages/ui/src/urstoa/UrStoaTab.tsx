import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { CollectUrStoa } from './CollectUrStoa';
import { StakeUnstakeUrStoaModal } from './StakeUnstakeUrStoaModal';
import { TransferUrStoaModal } from './TransferUrStoaModal';
import { UrStoaCard } from './UrStoaCard';
import { useUrStoaHoldings } from './useUrStoaHoldings';
import styles from './UrStoaTab.module.css';

/** The UrStoa vault actions reachable from the overview card. */
type UrStoaAction = 'transfer' | 'stake' | 'unstake' | 'collect';

export interface UrStoaTabProps {
  /** Routed to the UrStoa flows so a `locked` op sends the user back to unlock. */
  readonly onRequireUnlock?: () => void;
  /**
   * Registers (or clears) the sub-view BACK handler with the shell, so the back
   * affordance lives in the app HEADER — the SAME pattern the Stoa tab uses. Called
   * with the handler when an action page opens, and `null` on return / unmount.
   */
  readonly onBackChange?: (back: (() => void) | null) => void;
}

/**
 * The UrStoa destination. The overview is the holdings card + the four action
 * chips (Transfer / Stake / Unstake / Collect). Picking an action opens it as a
 * routed FULL-PAGE sub-view with a back affordance in the app header (mirroring the
 * Stoa tab) — NOT a modal overlay. The holdings are read once here so every flow
 * shares the live figures, and the silver `.actionPage` scope recolors the flows'
 * brand accents to UrStoa silver (STOA-denominated figures stay gold).
 */
export function UrStoaTab({ onRequireUnlock, onBackChange }: UrStoaTabProps): ReactNode {
  const [action, setAction] = useState<UrStoaAction | null>(null);
  const urstoa = useUrStoaHoldings();

  const backToOverview = useCallback((): void => setAction(null), []);

  // Register the BACK handler with the shell so the back button lives in the app
  // header (not a wasted row above the form). Cleared on return / unmount.
  useEffect(() => {
    onBackChange?.(action !== null ? backToOverview : null);
    return () => onBackChange?.(null);
  }, [action, onBackChange, backToOverview]);

  if (action !== null) {
    return (
      <section className={styles.actionPage} data-testid="urstoa-subview">
        {(action === 'stake' || action === 'unstake') && (
          <StakeUnstakeUrStoaModal
            initialKind={action}
            holdings={{
              walletBalance: urstoa.walletBalance,
              userStaked: urstoa.vaultBalance,
              vaultTotal: urstoa.vaultTotal,
            }}
            hookOptions={{ refresh: () => void urstoa.refresh() }}
            onRequireUnlock={onRequireUnlock}
            onClose={backToOverview}
          />
        )}
        {action === 'collect' && (
          <CollectUrStoa
            earnings={urstoa.vaultEarnings}
            hookOptions={{ refresh: () => void urstoa.refresh() }}
            onRequireUnlock={onRequireUnlock}
            onClose={backToOverview}
          />
        )}
        {action === 'transfer' && (
          <TransferUrStoaModal
            open
            onClose={backToOverview}
            hookOptions={{
              walletBalance: urstoa.walletBalance,
              refresh: () => void urstoa.refresh(),
            }}
            onRequireUnlock={onRequireUnlock}
          />
        )}
      </section>
    );
  }

  return (
    <UrStoaCard
      onStake={() => setAction('stake')}
      onUnstake={() => setAction('unstake')}
      onCollect={() => setAction('collect')}
      onTransfer={() => setAction('transfer')}
    />
  );
}
