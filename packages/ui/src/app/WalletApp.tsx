import { KADENA_NETWORK } from '@stoachain/stoa-core/constants';
import { useCallback, useState, type ReactNode } from 'react';

import { useWallet } from '../context/WalletContext';
import {
  type ContinuationRecoveryPrefill,
} from '../crosschain/ContinuationRecoveryView';
import { type CrossChainRecoveryRoute } from '../crosschain/CrossChainTransferForm';
import { BrandSplash } from '../components/BrandSplash';
import { CreateWalletFlow } from '../onboarding/CreateWalletFlow';
import { ImportWalletFlow } from '../onboarding/ImportWalletFlow';
import { AutoLockSettings } from '../settings/AutoLockSettings';
import { NodeSettings } from '../settings/NodeSettings';
import { SettingsProvider } from '../settings/SettingsContext';
import { AdvancedTab } from '../advanced/AdvancedTab';
import { AutoLockCountdown } from '../security/AutoLockCountdown';
import { StoaTab } from '../stoa/StoaTab';
import { ToastProvider } from '../toast/ToastContext';
import { ToastViewport } from '../toast/ToastViewport';
import { UrStoaTab } from '../urstoa/UrStoaTab';
import { UnlockScreen } from '../wallet/UnlockScreen';

import {
  AdvancedIcon,
  ExpandIcon,
  FiatRampIcon,
  LockIcon,
  SettingsIcon,
  SidePanelIcon,
  StoaIcon,
  UrStoaIcon,
} from './NavIcons';
import { PlaceholderPanel } from './PlaceholderPanel';
import { seedTypeChipStyle } from './seedTypeConfig';
import { useSessionGuard } from './useSessionGuard';
// Global theme stylesheet — defines the `--color-stoa-*` / `--color-status-*` /
// `--font-sans` custom properties that EVERY screen's module CSS references.
// Without this side-effect import nothing loads those vars and the whole app
// renders unstyled. Imported here (the shared root both apps mount) so popup +
// mobile both get it. The extension popup's fixed WIDTH lives in popup.css.
import '../theme/theme.css';
import styles from './WalletApp.module.css';

/**
 * The composed root shell BOTH apps mount (the extension popup and the Capacitor
 * mobile wrap render the SAME `<WalletApp/>` — no rewrite). It is a pure function
 * of the `useWallet()` context state, so it needs no router lib: a single
 * `useState` drives the unlocked-HOME destination, and the three top-level
 * branches are read straight off context:
 *
 *   - no wallet stored (`!hasExistingWallet`) → onboarding (create / import with
 *     a mode toggle).
 *   - wallet stored but locked → the UnlockScreen.
 *   - unlocked → the HOME shell: a floating BOTTOM nav of five destinations
 *     (Stoa / UrStoa / Fiat-Ramp / Advanced / Settings) over the active body.
 *     The header reads top→bottom: the StoaWallet title, the active account
 *     full-width, then the Expand + Lock controls.
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

/** The five floating-bottom-nav destinations. */
type NavDest = 'stoa' | 'urstoa' | 'fiat' | 'advanced' | 'settings';

interface NavItem {
  readonly dest: NavDest;
  readonly label: string;
  readonly Icon: (props: { className?: string }) => ReactNode;
}

const NAV_ITEMS: readonly NavItem[] = [
  { dest: 'stoa', label: 'Stoa', Icon: StoaIcon },
  { dest: 'urstoa', label: 'UrStoa', Icon: UrStoaIcon },
  { dest: 'fiat', label: 'Fiat-Ramp', Icon: FiatRampIcon },
  { dest: 'advanced', label: 'Advanced', Icon: AdvancedIcon },
  { dest: 'settings', label: 'Settings', Icon: SettingsIcon },
];

/**
 * Props for the shared shell. BOTH are optional and BOTH are extension-popup-only:
 * mobile (`apps/mobile`) and the extension's own full-tab page mount `<WalletApp/>`
 * with NEITHER, so their behavior is unchanged and the shell stays `chrome.*`-free.
 *
 * The extension POPUP passes them in (the `chrome.tabs.create` call lives in the
 * popup entry, handed in here as a plain callback) so the dangerous 24-word seed
 * flows never run inside the focus-loss-closeable action popup.
 */
export interface WalletAppProps {
  /**
   * Open the wallet in a full browser tab. When provided, the shell renders an
   * "open in tab" affordance. Absent on mobile + the tab itself → nothing renders.
   */
  readonly onExpand?: () => void;
  /**
   * Open the wallet in the Chrome side panel. When provided (the popup, on
   * Chrome 114+ with the API present), the header renders a side-panel icon that
   * invokes this callback from the user gesture. Absent on mobile + the tab, and
   * absent in the popup when `chrome.sidePanel` is unavailable → no button renders,
   * mirroring `onExpand` so the shared shell stays `chrome.*`-free.
   */
  readonly onOpenSidePanel?: () => void;
  /**
   * When true (the popup), picking Create/Import in onboarding calls `onExpand`
   * (opens the tab) INSTEAD of running the seed-showing flow inline. Absent/false
   * (mobile + the tab) → the flows run inline on the safe full-page surface.
   */
  readonly routeOnboardingToExpand?: boolean;
}

export function WalletApp({
  onExpand,
  onOpenSidePanel,
  routeOnboardingToExpand,
}: WalletAppProps = {}): ReactNode {
  const { hasExistingWallet, activeAccount, biometric } = useWallet();
  const guard = useSessionGuard();

  if (!hasExistingWallet) {
    return (
      <Onboarding
        onExpand={onExpand}
        routeOnboardingToExpand={routeOnboardingToExpand}
      />
    );
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
        {onExpand && (
          <header className={styles.header}>
            <span className={styles.brand}>
              <span className={styles.brandGlyph}>❖</span> StoaWallet
            </span>
            <ExpandButton onExpand={onExpand} />
          </header>
        )}
        <div className={styles.body}>
          <UnlockScreen
            biometric={biometric}
            sessionExpired={guard.sessionExpired}
          />
        </div>
      </div>
    );
  }

  return (
    <Home
      onSessionLocked={guard.reportSessionLocked}
      onExpand={onExpand}
      onOpenSidePanel={onOpenSidePanel}
    />
  );
}

/**
 * The extension-popup "open in tab" affordance. Rendered ONLY when the popup
 * passed an `onExpand` callback; it is a plain button that invokes that callback,
 * so the shared shell never touches `chrome.*` — the popup entry owns the
 * `chrome.tabs.create` that the callback wraps.
 */
function ExpandButton({ onExpand }: { readonly onExpand: () => void }): ReactNode {
  return (
    <button
      type="button"
      className={styles.iconButton}
      onClick={onExpand}
      aria-label="Open in tab"
      title="Open in a full browser tab"
    >
      <ExpandIcon className={styles.headerIcon} />
    </button>
  );
}

interface OnboardingProps {
  readonly onExpand?: () => void;
  readonly routeOnboardingToExpand?: boolean;
}

/**
 * Onboarding: a create/import mode toggle wrapping the two shared flows.
 *
 * Both flows show/enter the 24-word phrase, which is unsafe in the focus-loss-
 * closeable MV3 action popup. So when the popup passes `routeOnboardingToExpand`
 * (with its `onExpand` callback), picking Create or Import OPENS THE TAB instead
 * of entering the inline flow — the seed is then shown on the safe full-page
 * surface. Mobile + the tab itself pass neither, so the flows run inline as before.
 */
function Onboarding({
  onExpand,
  routeOnboardingToExpand,
}: OnboardingProps): ReactNode {
  const { mode, setMode, startCreate } = useWallet();
  const routeToExpand = Boolean(routeOnboardingToExpand && onExpand);

  // The landing CHOICE (no inline flow yet) gets the full brand splash with a
  // tagline; once a flow is entered inline the inner step renders below the
  // mode toggle. In the popup (`routeToExpand`) the choice always routes to the
  // safe full tab, so the choice screen is what the popup shows.
  const showLandingTagline = routeToExpand || mode === 'create';

  return (
    <div className={styles.shell}>
      {onExpand && (
        <header className={styles.headerFloat}>
          <ExpandButton onExpand={onExpand} />
        </header>
      )}
      <div className={styles.body}>
        <BrandSplash
          tagline={showLandingTagline ? 'An economy built to endure' : undefined}
        >
          <div
            className={styles.modeToggle}
            role="tablist"
            aria-label="Onboarding mode"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'create'}
              className={`${styles.modeButton} ${mode === 'create' ? styles.modeButtonActive : ''}`}
              onClick={() => {
                if (routeToExpand) {
                  onExpand!();
                  return;
                }
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
              className={`${styles.modeButton} ${styles.modeButtonGlass} ${mode === 'import' ? styles.modeButtonActive : ''}`}
              onClick={() => {
                if (routeToExpand) {
                  onExpand!();
                  return;
                }
                setMode('import');
              }}
            >
              Import existing
            </button>
          </div>

          {routeToExpand ? (
            <p className={styles.placeholder}>
              For your security, creating or importing a wallet opens in a full
              browser tab so your 24-word recovery phrase is never shown in this
              pop-up.
            </p>
          ) : mode === 'create' ? (
            <CreateWalletFlow onComplete={() => undefined} />
          ) : (
            <ImportWalletFlow />
          )}
        </BrandSplash>
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
  /**
   * The extension-popup "open in tab" callback. Present only in the popup; absent
   * on mobile + the tab itself, where no expand affordance renders.
   */
  readonly onExpand?: () => void;
  /**
   * The extension-popup "open in side panel" callback. Present only in the popup
   * on a side-panel-capable Chrome; absent on mobile + the tab + older Chrome.
   */
  readonly onOpenSidePanel?: () => void;
}

/**
 * Present the single network designator from the SDK's `KADENA_NETWORK` id.
 * There is one StoaChain network, so the label is fixed ("Mainnet"), but the id
 * itself is sourced from the constant — never hardcoded — so a network rename in
 * the SDK flows through here without a literal edit.
 */
function networkDesignator(): string {
  return `Mainnet · ${KADENA_NETWORK}`;
}

/**
 * The top bar's LEFT cluster: the active seed name, the network designator, and
 * the color-coded seed-type chip (koala→pink, etc.). Reads the active wallet's
 * plaintext summary from context; renders nothing seed-specific when no wallet.
 */
function HeaderSeed(): ReactNode {
  const { activeWallet } = useWallet();
  const seedType = activeWallet?.seedType ?? 'koala';
  const chip = seedTypeChipStyle(seedType);
  return (
    <div className={styles.seedCluster}>
      <span className={styles.seedName} data-testid="header-seed">
        {activeWallet?.name ?? 'Seed'}
      </span>
      <span className={styles.seedMeta}>
        <span className={styles.network} data-testid="header-network">
          {networkDesignator()}
        </span>
        <span
          className={styles.seedTypeChip}
          data-testid="header-seed-type-chip"
          style={{ color: chip.color, background: chip.background }}
        >
          {chip.label}
        </span>
      </span>
    </div>
  );
}

/** The unlocked HOME: a structured header + a floating bottom nav over the body. */
function Home({ onSessionLocked, onExpand, onOpenSidePanel }: HomeProps): ReactNode {
  const { lock, storage } = useWallet();
  const [dest, setDest] = useState<NavDest>('stoa');

  // The active sub-view's BACK handler, lifted into the HEADER so the back button
  // doesn't waste a row above the form. A tab registers its handler when a
  // sub-view opens and clears it on return / unmount. Wrapped in a thunk so React
  // stores the function itself rather than treating it as a state updater.
  const [subviewBack, setSubviewBack] = useState<(() => void) | null>(null);
  const handleBackChange = useCallback(
    (back: (() => void) | null) => setSubviewBack(() => back),
    [],
  );

  // A screen op surfaced a locked background (idle auto-lock fired, or the MV3
  // worker respawned between ops): mark the expiry, then drop the local session
  // so the shell re-derives to the re-unlock screen with the distinct framing.
  function requireUnlock(): void {
    onSessionLocked();
    void lock();
  }

  // A pending cross-chain burn (from the cross-chain form OR a PENDING miner
  // source) routes into the Stoa tab's recovery sub-view with its identity
  // prefilled — neither caller re-burns; recovery only resumes step-1. The miner's
  // `MinerRecoveryRoute` shares this `{requestKey, sourceChain, targetChain}`
  // shape, so it reuses this path.
  const [recoveryPrefill, setRecoveryPrefill] = useState<
    ContinuationRecoveryPrefill | undefined
  >(undefined);

  function routeToRecovery(route: CrossChainRecoveryRoute): void {
    setRecoveryPrefill({
      requestKey: route.requestKey,
      sourceChain: route.sourceChain,
      targetChain: route.targetChain,
    });
    setDest('stoa');
  }

  return (
    <ToastProvider>
    <div className={styles.shell}>
      <header className={styles.topBar}>
        <div className={styles.topBarLeft}>
          <span className={styles.brand}>
            <span className={styles.brandGlyph}>❖</span> StoaWallet
          </span>
          <HeaderSeed />
        </div>
        <div className={styles.headerControls}>
          <div className={styles.headerControlsRow}>
            <AutoLockCountdown />
            {onOpenSidePanel && (
              <button
                type="button"
                className={styles.iconButton}
                onClick={onOpenSidePanel}
                aria-label="Open in side panel"
                title="Open in the Chrome side panel"
              >
                <SidePanelIcon className={styles.headerIcon} />
              </button>
            )}
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => setDest('settings')}
              aria-label="Settings"
              title="Settings"
            >
              <SettingsIcon className={styles.headerIcon} />
            </button>
            {onExpand && <ExpandButton onExpand={onExpand} />}
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => void lock()}
              aria-label="Lock"
              title="Lock wallet"
            >
              <LockIcon className={styles.headerIcon} />
            </button>
          </div>
          {/* The sub-view back button sits INSIDE the header beneath the icon row
              (above the divider), so it never claims its own vertical row. */}
          {subviewBack !== null && (
            <button
              type="button"
              className={styles.subviewBack}
              data-testid="subview-back"
              onClick={subviewBack}
            >
              ← Back
            </button>
          )}
        </div>
      </header>

      <div className={styles.body}>
        {dest === 'stoa' && (
          <StoaTab
            onRequireUnlock={requireUnlock}
            onRouteToRecovery={routeToRecovery}
            recoveryPrefill={recoveryPrefill}
            onBackChange={handleBackChange}
          />
        )}
        {dest === 'urstoa' && (
          <UrStoaTab
            onRequireUnlock={requireUnlock}
            onBackChange={handleBackChange}
          />
        )}
        {dest === 'fiat' && (
          <PlaceholderPanel
            title="Buy / Sell STOA"
            message="Fiat on/off-ramp — coming soon (WIP)."
          />
        )}
        {dest === 'advanced' && <AdvancedTab onRequireUnlock={requireUnlock} />}
        {dest === 'settings' && (
          <div className={styles.settingsStack}>
            <AutoLockSettings />
            <SettingsProvider storage={storage}>
              <NodeSettings />
            </SettingsProvider>
          </div>
        )}
      </div>

      <nav className={styles.bottomNav} role="tablist" aria-label="Wallet sections">
        {NAV_ITEMS.map(({ dest: d, label, Icon }) => {
          const isActive = dest === d;
          return (
            <button
              key={d}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`${styles.navButton} ${isActive ? styles.navButtonActive : ''}`}
              onClick={() => setDest(d)}
            >
              <Icon className={styles.navIcon} />
              <span className={styles.navLabel}>{label}</span>
            </button>
          );
        })}
      </nav>

      <ToastViewport />
    </div>
    </ToastProvider>
  );
}
