import { STOA_CHAINS } from '@stoawallet/core';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  CrossChainIcon,
  MinerIcon,
  ReceiveIcon,
  SendIcon,
} from '../app/NavIcons';
import { useBalances, type GetBalancesFn } from '../balances/useBalances';
import { useWallet } from '../context/WalletContext';
import { AmountDisplay } from '../components/AmountDisplay';
import {
  ContinuationRecoveryView,
  type ContinuationRecoveryPrefill,
} from '../crosschain/ContinuationRecoveryView';
import { type CrossChainRecoveryRoute } from '../crosschain/CrossChainTransferForm';
import { MinerAggregationView } from '../miner/MinerAggregationView';
import { ReceiveView } from '../receive/ReceiveView';
import { SendForm } from '../send/SendForm';
import styles from './StoaTab.module.css';

/** The native Stoa-coin actions reachable from the Stoa overview. */
type StoaAction = 'send' | 'receive' | 'crosschain' | 'miner';

/**
 * Split a `k:` address into the parts the account line renders: the `k:` prefix,
 * the first-3 hex + last-3 hex (highlighted gold), and the truncatable middle.
 * The line fills the popup width and MIDDLE-truncates (CSS ellipsis on the middle,
 * the gold tail pinned right) only when the full key doesn't fit — so the
 * recognizable ends always stay visible.
 */
function splitAccount(account: string): {
  prefix: string;
  head: string;
  middle: string;
  tail: string;
} {
  const hasK = account.startsWith('k:');
  const hex = hasK ? account.slice(2) : account;
  const prefix = hasK ? 'k:' : '';
  if (hex.length <= 6) {
    return { prefix, head: hex, middle: '', tail: '' };
  }
  return {
    prefix,
    head: hex.slice(0, 3),
    middle: hex.slice(3, -3),
    tail: hex.slice(-3),
  };
}

/**
 * The full-width account line: `#index` + the `k:` address (gold first-3/last-3,
 * middle-truncated to fit) + a copy affordance.
 */
function AccountLine({
  address,
  index,
}: {
  readonly address: string;
  readonly index: number;
}): ReactNode {
  const { prefix, head, middle, tail } = splitAccount(address);
  return (
    <div className={styles.cardAccount} data-testid="card-account">
      <span className={styles.accountIndex}>#{index}</span>
      <span className={styles.accountAddress} title={address}>
        <span className={styles.addrHead}>
          <span className={styles.addrPrefix}>{prefix}</span>
          <span className={styles.addrGold} data-testid="addr-head">
            {head}
          </span>
          <span className={styles.addrMid}>{middle}</span>
        </span>
        <span className={styles.addrGold} data-testid="addr-tail">
          {tail}
        </span>
      </span>
      <button
        type="button"
        className={styles.copyButton}
        aria-label="Copy address"
        title="Copy address"
        onClick={() => {
          void navigator.clipboard?.writeText(address);
        }}
      >
        ⧉
      </button>
    </div>
  );
}

export interface StoaTabProps {
  /**
   * The `k:` account to read balances for. When omitted the balances hook
   * resolves the active account from context; tests inject a fixed account.
   */
  readonly account?: string | null;
  /** Override the core balances read (tests inject a stub); defaults to the real read. */
  readonly getBalances?: GetBalancesFn;
  /** Routed to the action views so a `locked` op sends the user back to unlock. */
  readonly onRequireUnlock?: () => void;
  /**
   * A cross-chain burn (from the cross-chain form OR a PENDING miner source) is
   * resumed in the recovery sub-view with its identity prefilled — the burn is
   * NEVER re-run. Wired to the SAME shell route the prior top-tab structure used.
   */
  readonly onRouteToRecovery?: (route: CrossChainRecoveryRoute) => void;
  /**
   * When set, the Stoa tab opens the cross-chain action straight into the
   * recovery sub-view with this prefill (the shell routed a pending burn here).
   */
  readonly recoveryPrefill?: ContinuationRecoveryPrefill;
  /**
   * Registers (or clears) the sub-view BACK handler with the shell, so the back
   * affordance lives in the app HEADER rather than wasting a full row above the
   * form. Called with the handler when a sub-view opens, and `null` on return to
   * the overview / unmount.
   */
  readonly onBackChange?: (back: (() => void) | null) => void;
}

/**
 * The Stoa tab: the wallet's native Stoa-coin home. Top-to-bottom it is a
 * searchable chain combobox, the dual balance (all-chain SUM hero + the selected
 * chain below), a refresh, and the Send / Receive / Cross-chain / Miner icon-chip
 * action row. Picking an action opens the EXISTING view as a routed sub-view with
 * a back affordance — the action views own their own chain selection, so the
 * chain combobox here governs only the displayed per-chain balance.
 *
 * The active account is displayed in the shell HEADER (full-width), so the tab
 * carries no separate account line — the chain combobox is the only chrome above
 * the balance.
 *
 * StoaChain is a single-key chain: the account is the SAME across all chains, so
 * the chain combobox and the account are independent — the selection never
 * implies a different account per chain.
 */
export function StoaTab({
  account,
  getBalances,
  onRequireUnlock,
  onRouteToRecovery,
  recoveryPrefill,
  onBackChange,
}: StoaTabProps): ReactNode {
  const { activeAccount } = useWallet();
  const { chains, total, isLoading, isRefreshing, refresh } = useBalances({
    account,
    getBalances,
  });

  // The account shown in the card line: the injected `account` prop (tests / an
  // explicit override) wins, else the context's active account. The HD index
  // comes from the context record when it matches; otherwise 0 (the base account).
  const cardAddress = account ?? activeAccount?.account ?? null;
  const cardIndex = activeAccount?.index ?? 0;

  const [selectedChain, setSelectedChain] = useState<string>(STOA_CHAINS[0]);
  // The chain-search query: filters the dropdown by typed chain number. Empty →
  // the whole chain list shows (future-proof: a long chain list stays navigable
  // by number rather than scrolling a fixed list).
  const [chainQuery, setChainQuery] = useState('');
  // The chain selector is a COLLAPSED single-line field; clicking it opens the
  // dropdown (search + scrollable list). Closed is the resting state so the whole
  // screen fits the popup without an always-visible chain grid.
  const [chainOpen, setChainOpen] = useState(false);
  const chainBoxRef = useRef<HTMLDivElement | null>(null);

  // Close the open dropdown on an outside click so the collapsed line is the
  // resting state once the user has picked (or dismissed) a chain.
  useEffect(() => {
    if (!chainOpen) return;
    function onDocClick(e: MouseEvent): void {
      if (chainBoxRef.current && !chainBoxRef.current.contains(e.target as Node)) {
        setChainOpen(false);
        setChainQuery('');
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [chainOpen]);
  // When the shell routed a pending burn here, open straight on the recovery
  // sub-view; otherwise the overview is the resting state (action === null).
  const [action, setAction] = useState<StoaAction | null>(
    recoveryPrefill !== undefined ? 'crosschain' : null,
  );

  // The chains matching the typed query (filtered by chain number). A blank
  // query shows every chain; a typed number narrows the list to chains whose id
  // contains it. Keyed off the immutable STOA_CHAINS source, never a hardcoded range.
  const filteredChains = useMemo<readonly string[]>(() => {
    const q = chainQuery.trim();
    if (q === '') return STOA_CHAINS;
    return STOA_CHAINS.filter((chainId) => chainId.includes(q));
  }, [chainQuery]);

  // The selected chain's balance string, or null when the chain read failed /
  // the account is absent there — null renders the unknown dash, never a fake 0.
  const selectedChainBalance = useMemo<string | null>(() => {
    const status = chains.find((c) => String(c.chainId) === selectedChain);
    if (status === undefined) return null;
    if (status.kind === 'funded' || status.kind === 'zero') return status.balance;
    return null;
  }, [chains, selectedChain]);

  // The all-chain SUM is unknown when every chain failed (no included chains).
  const heroAmount =
    total.includedChains === 0 && total.erroredChains > 0 ? null : total.total;

  function routeToRecovery(route: CrossChainRecoveryRoute): void {
    // A pending cross-chain burn can originate from the Send action too — switch
    // to the cross-chain action (whose Continue section renders the recovery),
    // then surface the route to the shell so it prefills the recovery inputs.
    setAction('crosschain');
    onRouteToRecovery?.(route);
  }

  function openAction(next: StoaAction): void {
    setAction(next);
  }

  const backToOverview = useCallback((): void => {
    setAction(null);
  }, []);

  // Register the sub-view BACK handler with the shell so the back button lives in
  // the app header (not a wasteful row above the form). Cleared on return / unmount.
  useEffect(() => {
    onBackChange?.(action !== null ? backToOverview : null);
    return () => onBackChange?.(null);
  }, [action, onBackChange, backToOverview]);

  if (action !== null) {
    return (
      <section className={styles.subview} data-testid="stoa-subview">
        {action === 'send' && (
          <SendForm
            sourceChain={selectedChain}
            onRequireUnlock={onRequireUnlock}
            onRouteToRecovery={routeToRecovery}
          />
        )}
        {action === 'receive' && <ReceiveView />}
        {action === 'crosschain' && (
          // Cross-chain is the SAME form as Send, but the From chain is editable
          // (`lockSource={false}`) — pick any source. Beneath it, a continuation
          // section resumes a stalled transfer whose step-1 never submitted.
          <>
            <SendForm
              lockSource={false}
              sourceChain={selectedChain}
              onRequireUnlock={onRequireUnlock}
              onRouteToRecovery={routeToRecovery}
            />
            <details
              className={styles.continueSection}
              data-testid="stoa-continue-section"
              open={recoveryPrefill !== undefined}
            >
              <summary className={styles.continueSummary}>
                Continue an unfinished cross-chain transfer
              </summary>
              <ContinuationRecoveryView prefill={recoveryPrefill} />
            </details>
          </>
        )}
        {action === 'miner' && (
          <MinerAggregationView
            hookOptions={{ targetChain: selectedChain }}
            onRouteToRecovery={routeToRecovery}
            onRequireUnlock={onRequireUnlock}
          />
        )}
      </section>
    );
  }

  return (
    <section className={styles.tab} data-testid="stoa-tab">
      <div className={styles.card} data-testid="stoa-balance-card">
        {cardAddress !== null && (
          <AccountLine address={cardAddress} index={cardIndex} />
        )}

        <div className={styles.chainSelector} ref={chainBoxRef}>
          <button
            type="button"
            className={styles.chainToggle}
            aria-haspopup="listbox"
            aria-expanded={chainOpen}
            aria-label={`Chain ${selectedChain} — change chain`}
            onClick={() => setChainOpen((open) => !open)}
          >
            <span>Chain {selectedChain}</span>
            <span className={styles.chainChevron} aria-hidden="true">
              ▾
            </span>
          </button>

          {chainOpen && (
            <div className={styles.chainDropdown}>
              <input
                type="search"
                inputMode="numeric"
                className={styles.chainSearch}
                aria-label="Search chains by number"
                placeholder="Search chain #"
                value={chainQuery}
                onChange={(e) => setChainQuery(e.target.value)}
                autoFocus
              />
              <ul
                className={styles.chainList}
                role="listbox"
                aria-label="Chains"
              >
                {filteredChains.map((chainId) => (
                  <li key={chainId} role="presentation">
                    <button
                      type="button"
                      role="option"
                      aria-selected={chainId === selectedChain}
                      className={`${styles.chainOption} ${
                        chainId === selectedChain ? styles.chainOptionActive : ''
                      }`}
                      onClick={() => {
                        setSelectedChain(chainId);
                        setChainQuery('');
                        setChainOpen(false);
                      }}
                    >
                      Chain {chainId}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className={styles.hero} data-testid="stoa-balance-hero">
          {isLoading ? (
            <span className={styles.skeleton} aria-hidden="true" />
          ) : (
            <AmountDisplay amount={heroAmount} size="hero" glyph="stoa" align="right" />
          )}
          <span className={styles.heroLabel}>All chains</span>
        </div>

        <div className={styles.chainBalance} data-testid="stoa-balance-chain">
          {isLoading ? (
            <span className={styles.skeletonSub} aria-hidden="true" />
          ) : (
            <AmountDisplay
              amount={selectedChainBalance}
              size="sub"
              glyph="stoa"
              align="right"
            />
          )}
          <span className={styles.chainBalanceLabel}>Chain {selectedChain}</span>
        </div>

        <button
          type="button"
          className={styles.refresh}
          onClick={() => void refresh()}
          disabled={isRefreshing}
        >
          <span className={styles.refreshGlyph} aria-hidden="true">
            ↻
          </span>
          {isRefreshing ? 'Refreshing…' : 'Refresh balances'}
        </button>

        <div className={styles.actions} data-testid="stoa-actions">
        <button
          type="button"
          className={styles.action}
          onClick={() => openAction('send')}
        >
          <span className={styles.actionChip}>
            <SendIcon className={styles.actionIcon} />
          </span>
          <span className={styles.actionLabel}>Send</span>
        </button>
        <button
          type="button"
          className={styles.action}
          onClick={() => openAction('receive')}
        >
          <span className={styles.actionChip}>
            <ReceiveIcon className={styles.actionIcon} />
          </span>
          <span className={styles.actionLabel}>Receive</span>
        </button>
        <button
          type="button"
          className={styles.action}
          onClick={() => openAction('crosschain')}
        >
          <span className={styles.actionChip}>
            <CrossChainIcon className={styles.actionIcon} />
          </span>
          <span className={styles.actionLabel}>Cross-chain</span>
        </button>
        <button
          type="button"
          className={styles.action}
          onClick={() => openAction('miner')}
        >
          <span className={styles.actionChip}>
            <MinerIcon className={styles.actionIcon} />
          </span>
          <span className={styles.actionLabel}>Miner</span>
        </button>
        </div>
      </div>
    </section>
  );
}
