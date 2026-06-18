import { formatEU } from '@stoachain/stoa-core/pact';
import { type ReactNode } from 'react';

import { StoaMark, UrStoaMark } from './glyph';
import styles from './UrStoaCard.module.css';
import {
  useUrStoaHoldings,
  type UseUrStoaHoldingsOptions,
} from './useUrStoaHoldings';

export interface UrStoaCardProps {
  /**
   * Forwarded verbatim to `useUrStoaHoldings` — the account override + the
   * injectable core reads. The app shell wires the real reads; tests inject
   * stubs. The card holds NO key material: it only reads + presents.
   */
  readonly hookOptions?: UseUrStoaHoldingsOptions;
  /**
   * Open the Stake/Unstake flow (T12.11 modal). The card OWNS the affordance;
   * the modal owns the flow. Optional so the card renders standalone in tests.
   */
  readonly onStake?: () => void;
  /** Open the Unstake side of the T12.11 modal. */
  readonly onUnstake?: () => void;
  /** Open the Collect-earnings flow (T12.12 modal). */
  readonly onCollect?: () => void;
  /** Open the native Transfer flow (T12.13 modal). */
  readonly onTransfer?: () => void;
}

/**
 * The UrStoa AssetItem card — the chain-0 holdings panel for the active account.
 *
 * It composes the T12.6 `useUrStoaHoldings` hook and renders three figures:
 *   - WALLET balance  — spendable UrStoa, silver ✦ (`UrStoaMark`).
 *   - VAULT balance   — staked UrStoa, silver ✦ (`UrStoaMark`).
 *   - VAULT EARNINGS  — pending earnings denominated in STOA, gold ❖
 *     (`StoaMark`). Per DESIGN.md a STOA-denominated figure ALWAYS uses the gold
 *     ❖ even on a UrStoa card.
 *
 * The wrapped-balance / wrapped-id rows are DELIBERATELY never rendered.
 *
 * It renders a distinct affordance for every hook state so the user is never
 * misled (Phase-3 RR#4 — null ≠ "0"):
 *   - idle/locked → a neutral "unlock" panel, never a loader or a "0".
 *   - loading     → a skeleton, never a premature "0".
 *   - error       → a whole-card "couldn't load" + retry.
 *   - unknown     → a distinct "unable to load" + retry, never a plain "0".
 *   - refreshing  → the existing rows stay on screen, marked in-progress.
 *
 * Pure presentation: it imports no core signing path and holds no key material.
 * The Stake / Unstake / Collect / Transfer buttons fire the handler props the
 * Wave-4 modals plug into. It emits NO telemetry — it never logs balances or
 * the account.
 */
export function UrStoaCard({
  hookOptions,
  onStake,
  onUnstake,
  onCollect,
  onTransfer,
}: UrStoaCardProps): ReactNode {
  const {
    walletBalance,
    vaultBalance,
    vaultEarnings,
    isLoading,
    isRefreshing,
    isUnknown,
    error,
    isIdle,
    refresh,
  } = useUrStoaHoldings(hookOptions);

  if (isIdle) {
    return (
      <section className={styles.card} data-testid="urstoa-idle">
        <Heading />
        <p className={styles.idle}>
          No wallet unlocked — unlock to see your UrStoa holdings.
        </p>
      </section>
    );
  }

  if (error !== null) {
    return (
      <section className={styles.card} data-testid="urstoa-error">
        <Heading />
        <p className={styles.errorText}>Couldn&apos;t load your UrStoa holdings.</p>
        <button
          type="button"
          className={styles.retry}
          onClick={() => void refresh()}
        >
          Retry
        </button>
      </section>
    );
  }

  if (isUnknown) {
    return (
      <section className={styles.card} data-testid="urstoa-unknown">
        <Heading />
        <p className={styles.unknownText}>Unable to load — the read didn&apos;t return trustworthy figures.</p>
        <button
          type="button"
          className={styles.retry}
          onClick={() => void refresh()}
        >
          Retry
        </button>
      </section>
    );
  }

  if (isLoading) {
    return (
      <section className={styles.card} data-testid="urstoa-loading">
        <Heading />
        <div className={styles.rowsSkeleton} aria-hidden="true">
          <div className={styles.rowSkeleton} />
          <div className={styles.rowSkeleton} />
          <div className={styles.rowSkeleton} />
        </div>
        <span className={styles.srOnly} role="status">
          Loading UrStoa holdings…
        </span>
      </section>
    );
  }

  return (
    <section className={styles.card} data-testid="urstoa-card">
      <Heading />

      <div className={styles.rows}>
        <HoldingRow
          label="Wallet"
          amount={walletBalance}
          testId="urstoa-wallet"
          denomination="UrStoa"
        />
        <HoldingRow
          label="Vault (staked)"
          amount={vaultBalance}
          testId="urstoa-vault"
          denomination="UrStoa"
        />
        <HoldingRow
          label="Claimable (STOA)"
          amount={vaultEarnings}
          testId="urstoa-earnings"
          denomination="STOA"
        />
      </div>

      <div className={styles.actions}>
        <button type="button" className={styles.action} onClick={() => onTransfer?.()}>
          <span className={styles.actionChip}>
            <TransferIcon className={styles.actionIcon} />
          </span>
          <span className={styles.actionLabel}>Transfer</span>
        </button>
        <button type="button" className={styles.action} onClick={() => onStake?.()}>
          <span className={styles.actionChip}>
            <StakeIcon className={styles.actionIcon} />
          </span>
          <span className={styles.actionLabel}>Stake</span>
        </button>
        <button type="button" className={styles.action} onClick={() => onUnstake?.()}>
          <span className={styles.actionChip}>
            <UnstakeIcon className={styles.actionIcon} />
          </span>
          <span className={styles.actionLabel}>Unstake</span>
        </button>
        <button type="button" className={styles.action} onClick={() => onCollect?.()}>
          <span className={styles.actionChip}>
            <CollectIcon className={styles.actionIcon} />
          </span>
          <span className={styles.actionLabel}>Collect</span>
        </button>
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
        {isRefreshing ? 'Refreshing…' : 'Refresh'}
      </button>

      {isRefreshing && (
        <span className={styles.refreshing} data-testid="urstoa-refreshing" role="status">
          Refreshing…
        </span>
      )}
    </section>
  );
}

/** The card title — the constant UrStoa heading (silver ✦), never derived from balances. */
function Heading(): ReactNode {
  return (
    <header className={styles.header}>
      <h2 className={styles.title}>
        <UrStoaMark className={styles.titleMark} />
        UrStoa
      </h2>
    </header>
  );
}

/**
 * Clamp/pad a raw decimal STRING to exactly `decimals` fractional digits WITHOUT
 * a `Number` round-trip (no drift). UrStoa is a 3-decimal token, the STOA-
 * denominated claimable earnings 12 — so each figure displays at its own
 * denomination precision. The raw on-chain value is kept verbatim on
 * `title`/`data-full-value`, so display-clamping never hides funds.
 */
function toFixedDecimals(raw: string, decimals: number): string {
  const trimmed = raw.trim();
  const negative = trimmed.startsWith('-');
  const body = negative ? trimmed.slice(1) : trimmed;
  const dot = body.indexOf('.');
  const intPart = (dot === -1 ? body : body.slice(0, dot)) || '0';
  const fracRaw = dot === -1 ? '' : body.slice(dot + 1);
  const frac = fracRaw.slice(0, decimals).padEnd(decimals, '0');
  const out = decimals > 0 ? `${intPart}.${frac}` : intPart;
  return negative ? `-${out}` : out;
}

interface HoldingRowProps {
  readonly label: string;
  /** The raw decimal figure, or `null` when the hook has no value to show. */
  readonly amount: string | null;
  /** Test-id stem: `{testId}-row` wraps the row, `{testId}-value` the figure. */
  readonly testId: string;
  /**
   * Drives the unit mark: `UrStoa` → silver ✦, `STOA` → gold ❖. A STOA-
   * denominated figure (vault earnings) uses the gold ❖ even on this card.
   */
  readonly denomination: 'UrStoa' | 'STOA';
}

/**
 * One label-left / value-right holdings row. The figure is formatted for display
 * via the SDK European formatter while the FULL-precision value is preserved on
 * `data-full-value`/`title` so trimming never hides funds. A `null` amount is
 * the distinct unknown dash — never a misleading "0".
 */
function HoldingRow({
  label,
  amount,
  testId,
  denomination,
}: HoldingRowProps): ReactNode {
  const Mark = denomination === 'STOA' ? StoaMark : UrStoaMark;
  // UrStoa figures carry 3 decimals on-chain; the STOA-denominated earnings 12.
  const decimals = denomination === 'STOA' ? 12 : 3;
  return (
    <div className={styles.row} data-testid={`${testId}-row`}>
      <span className={styles.label}>{label}</span>
      {amount === null ? (
        <span className={styles.unknownValue} data-testid={`${testId}-unknown`}>
          —
        </span>
      ) : (
        <span
          className={styles.value}
          data-testid={`${testId}-value`}
          data-full-value={amount}
          title={amount}
        >
          {formatEU(toFixedDecimals(amount, decimals))}
          <Mark />
        </span>
      )}
    </div>
  );
}

/**
 * Inline stroke icons for the four UrStoa action chips — no icon dependency
 * (mirrors `NavIcons`). Each inherits the chip's `currentColor` (silver) and is
 * `aria-hidden`; the button's label span supplies the accessible name.
 */
interface IconProps {
  readonly className?: string;
}

function svgProps(className?: string) {
  return {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className,
  };
}

/** Transfer: a paper-plane (native send to another account). */
function TransferIcon({ className }: IconProps): ReactNode {
  return (
    <svg {...svgProps(className)}>
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </svg>
  );
}

/** Stake: an arrow descending INTO the vault (deposit). */
function StakeIcon({ className }: IconProps): ReactNode {
  return (
    <svg {...svgProps(className)}>
      <rect x="3" y="14" width="18" height="7" rx="2" />
      <path d="M12 3v8" />
      <path d="m8 7 4 4 4-4" />
    </svg>
  );
}

/** Unstake: an arrow rising OUT of the vault (withdraw). */
function UnstakeIcon({ className }: IconProps): ReactNode {
  return (
    <svg {...svgProps(className)}>
      <rect x="3" y="14" width="18" height="7" rx="2" />
      <path d="M12 11V3" />
      <path d="m8 7 4-4 4 4" />
    </svg>
  );
}

/** Collect: a stack of coins (gather the vault's STOA rewards). */
function CollectIcon({ className }: IconProps): ReactNode {
  return (
    <svg {...svgProps(className)}>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v6c0 1.66 3.13 3 7 3s7-1.34 7-3V6" />
      <path d="M5 12v6c0 1.66 3.13 3 7 3s7-1.34 7-3v-6" />
    </svg>
  );
}
