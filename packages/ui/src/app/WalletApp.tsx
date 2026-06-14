import { useState, type ReactNode } from 'react';

import { AddAdvancedAccount } from '../advanced/AddAdvancedAccount';
import { BalancesView } from '../balances/BalancesView';
import { useWallet } from '../context/WalletContext';
import {
  ContinuationRecoveryView,
  type ContinuationRecoveryPrefill,
} from '../crosschain/ContinuationRecoveryView';
import {
  CrossChainTransferForm,
  type CrossChainRecoveryRoute,
} from '../crosschain/CrossChainTransferForm';
import { MinerAggregationView } from '../miner/MinerAggregationView';
import { CreateWalletFlow } from '../onboarding/CreateWalletFlow';
import { ImportWalletFlow } from '../onboarding/ImportWalletFlow';
import { ReceiveView } from '../receive/ReceiveView';
import { SendForm } from '../send/SendForm';
import { NodeSettings } from '../settings/NodeSettings';
import { SettingsProvider } from '../settings/SettingsContext';
import { CollectUrStoa } from '../urstoa/CollectUrStoa';
import { StakeUnstakeUrStoaModal } from '../urstoa/StakeUnstakeUrStoaModal';
import { TransferUrStoaModal } from '../urstoa/TransferUrStoaModal';
import { UrStoaCard } from '../urstoa/UrStoaCard';
import { useUrStoaHoldings } from '../urstoa/useUrStoaHoldings';
import { AccountSwitcher } from '../wallet/AccountSwitcher';
import { UnlockScreen } from '../wallet/UnlockScreen';

import { useSessionGuard } from './useSessionGuard';
import styles from './WalletApp.module.css';

/**
 * The composed root shell BOTH apps mount (the extension popup and the Capacitor
 * mobile wrap render the SAME `<WalletApp/>` — no rewrite). It is a pure function
 * of the `useWallet()` context state, so it needs no router lib: a single
 * `useState` drives the unlocked-HOME tab, and the three top-level branches are
 * read straight off context:
 *
 *   - no wallet stored (`!hasExistingWallet`) → onboarding (create / import with
 *     a mode toggle).
 *   - wallet stored but locked → the UnlockScreen.
 *   - unlocked → the tabbed HOME (Balances / Send / Receive / Cross-chain /
 *     Advanced) with the AccountSwitcher in the header.
 *
 * MV3 SW-LIFECYCLE RESILIENCE: in the extension the background service worker —
 * NOT this popup — owns the unlocked session, and Chrome may terminate it (or the
 * idle auto-lock may clear it) at any time. So the locked/unlocked decision is
 * driven by `useSessionGuard`, which on mount re-derives the unlocked-state from
 * the BACKGROUND (the single source of truth) and surfaces a `sessionExpired`
 * flag when a mid-session op reported `locked`. The web/test path injects no
 * background; the guard reports `local` and the shell falls back to the local
 * `activeAccount` state — unchanged from before.
 *
 * It HOLDS NO KEY MATERIAL: every screen composes the context seam, which (in the
 * extension) delegates all signing to the background. The shell only navigates.
 */

type HomeTab =
  | 'balances'
  | 'send'
  | 'receive'
  | 'crosschain'
  | 'miner'
  | 'urstoa'
  | 'advanced'
  | 'settings';

const TAB_LABELS: Record<HomeTab, string> = {
  balances: 'Balances',
  send: 'Send',
  receive: 'Receive',
  crosschain: 'Cross-chain',
  miner: 'Miner',
  urstoa: 'UrStoa',
  advanced: 'Advanced',
  settings: 'Settings',
};

const TAB_ORDER: readonly HomeTab[] = [
  'balances',
  'send',
  'receive',
  'crosschain',
  'miner',
  'urstoa',
  'advanced',
  'settings',
];

export function WalletApp(): ReactNode {
  const { hasExistingWallet, activeAccount, biometric } = useWallet();
  const guard = useSessionGuard();

  if (!hasExistingWallet) {
    return <Onboarding />;
  }

  // While the first background unlocked-query is in flight, render nothing
  // decisive: showing the UnlockScreen here would flash a re-unlock prompt for an
  // already-unlocked session before the background answers.
  if (guard.status === 'checking') {
    return (
      <div className={styles.shell}>
        <div className={styles.body} aria-busy="true" />
      </div>
    );
  }

  // The unlocked decision treats the BACKGROUND as the single source of truth: in
  // remote mode the guard's `unlocked`/`locked` is authoritative; on the web/test
  // path (`local`) there is no background, so the local `activeAccount` decides.
  // A live session that EXPIRED mid-flight (`sessionExpired`) is locked regardless
  // of the mount-time status, so the popup never shows HOME over a dead session.
  const isUnlocked =
    !guard.sessionExpired &&
    (guard.status === 'unlocked' ||
      (guard.status === 'local' && activeAccount !== null));

  if (!isUnlocked) {
    // A locked-but-stored wallet routes to unlock. A mid-session expiry (the
    // background dropped the session while the popup was live) reuses the SAME
    // unlock flow, framed distinctly so the user knows their session lapsed.
    return (
      <div className={styles.shell}>
        <div className={styles.body}>
          <UnlockScreen
            biometric={biometric}
            sessionExpired={guard.sessionExpired}
          />
        </div>
      </div>
    );
  }

  return <Home onSessionLocked={guard.reportSessionLocked} />;
}

/** Onboarding: a create/import mode toggle wrapping the two shared flows. */
function Onboarding(): ReactNode {
  const { mode, setMode, startCreate } = useWallet();

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <span className={styles.brand}>
          <span className={styles.brandGlyph}>❖</span> StoaWallet
        </span>
      </header>
      <div className={styles.body}>
        <div className={styles.modeToggle} role="tablist" aria-label="Onboarding mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'create'}
            className={`${styles.modeButton} ${mode === 'create' ? styles.modeButtonActive : ''}`}
            onClick={() => {
              setMode('create');
              void startCreate();
            }}
          >
            Create new wallet
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'import'}
            className={`${styles.modeButton} ${mode === 'import' ? styles.modeButtonActive : ''}`}
            onClick={() => setMode('import')}
          >
            Import existing
          </button>
        </div>

        {mode === 'create' ? (
          <CreateWalletFlow onComplete={() => undefined} />
        ) : (
          <ImportWalletFlow />
        )}
      </div>
    </div>
  );
}

interface HomeProps {
  /**
   * Called when a screen op detected the background session is gone (its
   * `onRequireUnlock` fired). Flags the re-unlock as a "session expired" event —
   * distinct from the user-initiated Lock button, which lapses no live session.
   */
  readonly onSessionLocked: () => void;
}

/** The unlocked HOME: header with AccountSwitcher + a tab bar over the screens. */
function Home({ onSessionLocked }: HomeProps): ReactNode {
  const { lock, storage } = useWallet();
  const [tab, setTab] = useState<HomeTab>('balances');

  // A screen op surfaced a locked background (idle auto-lock fired, or the MV3
  // worker respawned between ops): mark the expiry, then drop the local session
  // so the shell re-derives to the re-unlock screen with the distinct framing.
  function requireUnlock(): void {
    onSessionLocked();
    void lock();
  }
  const [recoveryPrefill, setRecoveryPrefill] = useState<
    ContinuationRecoveryPrefill | undefined
  >(undefined);
  const [showRecovery, setShowRecovery] = useState(false);

  // Which UrStoa flow modal is open (null = none). The card's four action
  // buttons set this; the modal closes by resetting it to null. Holdings are
  // read once here so every flow shares the live figures (the Stake/Unstake max
  // + floor, Collect's earnings, Transfer's balance pre-flight).
  const [urstoaModal, setUrstoaModal] = useState<
    'stake' | 'unstake' | 'collect' | 'transfer' | null
  >(null);
  const urstoa = useUrStoaHoldings();

  // Route a pending cross-chain burn (from the cross-chain form OR a PENDING miner
  // source) into the recovery view with its identity prefilled — neither caller
  // re-burns; recovery only resumes step-1. The miner's `MinerRecoveryRoute` shares
  // this `{requestKey, sourceChain, targetChain}` shape, so it reuses this path.
  function routeToRecovery(route: CrossChainRecoveryRoute): void {
    setRecoveryPrefill({
      requestKey: route.requestKey,
      sourceChain: route.sourceChain,
      targetChain: route.targetChain,
    });
    setShowRecovery(true);
    setTab('crosschain');
  }

  function selectTab(next: HomeTab): void {
    setTab(next);
    if (next !== 'crosschain') setShowRecovery(false);
    if (next !== 'urstoa') setUrstoaModal(null);
  }

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <span className={styles.brand}>
          <span className={styles.brandGlyph}>❖</span> StoaWallet
        </span>
        <AccountSwitcher />
        <button type="button" className={styles.lockButton} onClick={() => void lock()}>
          Lock
        </button>
      </header>

      <div className={styles.body}>
        {tab === 'balances' && <BalancesView />}
        {tab === 'send' && <SendForm onRequireUnlock={requireUnlock} />}
        {tab === 'receive' && <ReceiveView />}
        {tab === 'crosschain' &&
          (showRecovery ? (
            <ContinuationRecoveryView prefill={recoveryPrefill} />
          ) : (
            <CrossChainTransferForm
              onRouteToRecovery={routeToRecovery}
              onRequireUnlock={requireUnlock}
            />
          ))}
        {tab === 'miner' && (
          <MinerAggregationView
            onRouteToRecovery={routeToRecovery}
            onRequireUnlock={requireUnlock}
          />
        )}
        {tab === 'urstoa' && (
          <>
            <UrStoaCard
              onStake={() => setUrstoaModal('stake')}
              onUnstake={() => setUrstoaModal('unstake')}
              onCollect={() => setUrstoaModal('collect')}
              onTransfer={() => setUrstoaModal('transfer')}
            />
            {(urstoaModal === 'stake' || urstoaModal === 'unstake') && (
              <StakeUnstakeUrStoaModal
                initialKind={urstoaModal}
                holdings={{
                  walletBalance: urstoa.walletBalance,
                  userStaked: urstoa.vaultBalance,
                  vaultTotal: urstoa.vaultTotal,
                }}
                hookOptions={{ refresh: () => void urstoa.refresh() }}
                onRequireUnlock={requireUnlock}
              />
            )}
            {urstoaModal === 'collect' && (
              <CollectUrStoa
                earnings={urstoa.vaultEarnings}
                hookOptions={{ refresh: () => void urstoa.refresh() }}
                onRequireUnlock={requireUnlock}
              />
            )}
            <TransferUrStoaModal
              open={urstoaModal === 'transfer'}
              onClose={() => setUrstoaModal(null)}
              hookOptions={{
                walletBalance: urstoa.walletBalance,
                refresh: () => void urstoa.refresh(),
              }}
              onRequireUnlock={requireUnlock}
            />
          </>
        )}
        {tab === 'advanced' && (
          <AddAdvancedAccount onRequireUnlock={requireUnlock} />
        )}
        {tab === 'settings' && (
          <SettingsProvider storage={storage}>
            <NodeSettings />
          </SettingsProvider>
        )}
      </div>

      <nav className={styles.tablist} role="tablist" aria-label="Wallet sections">
        {TAB_ORDER.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={`${styles.tab} ${tab === t ? styles.tabActive : ''}`}
            onClick={() => selectTab(t)}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </nav>
    </div>
  );
}
