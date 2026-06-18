import { useEffect, useRef, useState, type ReactNode } from 'react';

import { TokenGlyph } from '../theme/TokenGlyph';

import { AmountDisplay } from '../components/AmountDisplay';
import { useToast } from '../toast/ToastContext';
import { useTxToast } from '../toast/useTxToast';

import { maxUnstake } from './maxUnstake';
import styles from './StakeUnstakeUrStoaModal.module.css';
import {
  useStakeUnstakeUrStoa,
  type StakeUnstakeKind,
  type UseStakeUnstakeUrStoaOptions,
} from './useStakeUnstakeUrStoa';

/**
 * The active account's UrStoa holdings the modal needs to bound the amount + the
 * "max" affordance. All decimal STRINGS (or null when a read is unknown) — the
 * SAME precise strings the hook is fed, never Number()'d. `vaultTotal` null is the
 * fail-closed `vault-total-unknown` case: an unstake max cannot be computed.
 */
export interface StakeUnstakeHoldings {
  /** Spendable UrStoa wallet balance — bounds a STAKE's max. */
  readonly walletBalance: string | null;
  /** The user's own staked UrStoa — bounds an UNSTAKE + feeds the last-staker floor. */
  readonly userStaked: string | null;
  /** The live vault total — null BLOCKS computing an unstake max (never coerced to 0). */
  readonly vaultTotal: string | null;
}

export interface StakeUnstakeUrStoaModalProps {
  /**
   * The live UrStoa holdings (from T12.6). Forwarded to the hook as
   * `walletBalance`/`userStaked`/`vaultTotal` AND used locally to compute the
   * "max" affordance (the floor-clamped unstake max via T12.1 `maxUnstake`).
   */
  readonly holdings: StakeUnstakeHoldings;
  /**
   * Extra options forwarded to `useStakeUnstakeUrStoa` (the on-success refresh,
   * test stubs for the core ops / signer resolution). The holdings above always
   * win for the balance/floor bounds. The modal holds no key material; signing
   * happens inside the hook's context seam.
   */
  readonly hookOptions?: UseStakeUnstakeUrStoaOptions;
  /**
   * Which side the modal opens on. The T12.10 card exposes separate `onStake` /
   * `onUnstake` affordances; the shell opens this modal with the matching kind
   * (default `'stake'`). The user can still flip the in-modal toggle afterward.
   */
  readonly initialKind?: StakeUnstakeKind;
  /** Called when a `locked` outcome should route the user to unlock. */
  readonly onRequireUnlock?: () => void;
  /** Dismiss the modal (the UrStoa tab owns the open-state and closes it). */
  readonly onClose?: () => void;
}

/**
 * The STAKE / UNSTAKE modal: a mode toggle, a decimal-aware amount input with a
 * floor-aware "max" affordance, a gold gasless badge, a confirm that drives the
 * T12.7 staged flow, and a result panel with a distinct affordance per terminal
 * state. Presentation over `useStakeUnstakeUrStoa` only — no core import, no
 * signing, no telemetry (nothing logs the amount or any key material).
 *
 * The amount is passed to the hook as the typed STRING — never Number()'d,
 * rounded, or truncated — so 24-decimal precision survives intact (T12.1 formats
 * it downstream).
 *
 * UNSTAKE "max" honors the last-staker floor (REQ-21): when the user is the sole
 * staker (`userStaked >= vaultTotal`) the max is `userStaked - 1.0`, with a note
 * that 1.0 UrStoa must remain in the vault. When the vault total is unknown the
 * max is FAIL-CLOSED — a distinct "can't compute max" affordance shows instead of
 * a misleading 0/full max.
 */
export function StakeUnstakeUrStoaModal({
  holdings,
  hookOptions,
  initialKind = 'stake',
  onRequireUnlock,
  onClose,
}: StakeUnstakeUrStoaModalProps): ReactNode {
  const [kind, setKind] = useState<StakeUnstakeKind>(initialKind);
  const [amount, setAmount] = useState('');

  const { state, stake, unstake, reset } = useStakeUnstakeUrStoa({
    ...hookOptions,
    walletBalance: holdings.walletBalance,
    userStaked: holdings.userStaked,
    vaultTotal: holdings.vaultTotal,
  });

  const status = state.status;
  const inFlight = status === 'building' || status === 'submitting';
  const isLocked = status === 'error' && state.reason === 'locked';

  // Once SUBMITTED, hand off to the shared floating tx toast (pending → confirmed
  // → auto-dismiss) and return to the overview — the SAME mechanism every flow
  // uses, so a submitted stake/unstake never lingers as a static rectangle.
  const trackTx = useTxToast();
  const toast = useToast();
  const refresh = hookOptions?.refresh;
  const firedRef = useRef<string | null>(null);
  useEffect(() => {
    if (status !== 'success' && status !== 'pending') return;
    const requestKey =
      'requestKey' in state ? (state.requestKey ?? undefined) : undefined;
    const fireKey = requestKey ?? (status === 'pending' ? 'pending' : null);
    if (fireKey === null || firedRef.current === fireKey) return;
    firedRef.current = fireKey;
    const label = kind === 'stake' ? 'Stake' : 'Unstake';
    if (requestKey !== undefined) {
      trackTx({ requestKey, chainId: '0', label, onConfirmed: refresh });
    } else {
      toast.show({
        status: 'info',
        title: `${label} submitted`,
        detail: 'Confirmation unknown — check the explorer.',
        autoDismissMs: 9000,
      });
    }
    onClose?.();
  }, [status, state, kind, trackTx, toast, refresh, onClose]);

  // The floor-clamped unstake max (REQ-21). A sole staker (`userStaked >=
  // vaultTotal`) gets `userStaked - 1.0`; otherwise the full stake. A fail-closed
  // result (unknown vault total) yields no max button at all — an honest
  // "unavailable" affordance instead, never a misleading 0/full max.
  const unstakeMax =
    kind === 'unstake' ? maxUnstake(holdings.userStaked, holdings.vaultTotal) : null;
  // The last-staker floor APPLIED iff the user is the sole staker. `maxUnstake`
  // returns the canonical full stake when not sole and `userStaked - 1.0` when
  // sole, so comparing against the canonical full stake isolates that. The
  // canonical full stake is `maxUnstake(userStaked, hugeVaultTotal)` — a vault
  // total guaranteed larger than the stake forces the non-floor (full) branch.
  const hugeVaultTotal =
    holdings.userStaked === null ? null : `9${holdings.userStaked}`;
  const fullStake =
    kind === 'unstake' ? maxUnstake(holdings.userStaked, hugeVaultTotal) : null;
  const isSoleStaker =
    unstakeMax?.ok === true &&
    fullStake?.ok === true &&
    unstakeMax.max !== fullStake.max;

  const onConfirm = (): void => {
    if (kind === 'stake') {
      void stake({ amount });
    } else {
      void unstake({ amount });
    }
  };

  const onMax = (): void => {
    if (kind === 'stake') {
      if (holdings.walletBalance !== null) setAmount(holdings.walletBalance);
      return;
    }
    if (unstakeMax?.ok === true) setAmount(unstakeMax.max);
  };

  // The balance shown beneath the amount: STAKE bounds against the spendable
  // WALLET balance, UNSTAKE against the user's own VAULT stake.
  const modeBalance =
    kind === 'stake' ? holdings.walletBalance : holdings.userStaked;

  if (isLocked) {
    return (
      <section className={styles.page} data-testid="stake-locked">
        <p className={styles.lockedText}>
          Your wallet is locked — unlock it to stake or unstake.
        </p>
        <button
          type="button"
          className={styles.primary}
          data-testid="stake-unlock"
          onClick={() => onRequireUnlock?.()}
        >
          Unlock
        </button>
      </section>
    );
  }

  return (
    <section className={styles.page} data-testid="stake-modal">
      <div className={styles.modeToggle} role="group" aria-label="Stake or unstake">
        <button
          type="button"
          data-testid="stake-mode-stake"
          className={`${styles.modeButton} ${kind === 'stake' ? styles.modeButtonActive : ''}`}
          aria-pressed={kind === 'stake'}
          onClick={() => setKind('stake')}
        >
          Stake
        </button>
        <button
          type="button"
          data-testid="stake-mode-unstake"
          className={`${styles.modeButton} ${kind === 'unstake' ? styles.modeButtonActive : ''}`}
          aria-pressed={kind === 'unstake'}
          onClick={() => setKind('unstake')}
        >
          Unstake
        </button>
      </div>

      <div className={styles.fields}>
        <label className={styles.label}>
          <span className={styles.labelText}>
            Amount <TokenGlyph token="UrStoa" className={styles.amountGlyph} />
          </span>
          <div className={styles.fieldGroup}>
            <input
              data-testid="stake-amount"
              className={styles.ghostInput}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              placeholder="0.000"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <span className={styles.fieldDivider} aria-hidden="true" />
            {kind === 'unstake' && unstakeMax?.ok === false ? (
              <span
                className={styles.maxUnavailable}
                data-testid="stake-max-unavailable"
              >
                Max unavailable
              </span>
            ) : (
              <button
                type="button"
                className={styles.fieldMax}
                data-testid="stake-max"
                onClick={onMax}
              >
                MAX
              </button>
            )}
          </div>
          <span className={styles.balanceRow} data-testid="stake-balance">
            <span className={styles.balanceLeft}>
              {kind === 'stake' ? 'Wallet balance' : 'Vault (staked)'}
            </span>
            <span className={styles.balanceValue}>
              {modeBalance !== null ? (
                <AmountDisplay
                  amount={modeBalance}
                  size="sub"
                  glyph="urstoa"
                  align="right"
                />
              ) : (
                <span className={styles.balanceUnknown}>—</span>
              )}
            </span>
          </span>
        </label>

        {kind === 'unstake' && isSoleStaker && (
          <p className={styles.floorNote} data-testid="stake-floor-note">
            You&apos;re the vault&apos;s only staker — 1.0 UrStoa must remain, so
            the most you can unstake is your stake minus 1.0.
          </p>
        )}

        <GaslessBadge />

        <button
          type="button"
          data-testid="stake-confirm"
          className={styles.primary}
          onClick={onConfirm}
          disabled={inFlight}
        >
          {kind === 'stake' ? 'Confirm stake' : 'Confirm unstake'}
        </button>
      </div>

      {inFlight && (
        <div className={styles.stage} role="status" data-testid="stake-stage">
          {kind === 'stake' ? 'Staking…' : 'Unstaking…'}
        </div>
      )}

      {/* Submitted/pending outcomes are handed to the floating tx toast (which
          confirms on-chain + auto-dismisses); the page returns to the overview. */}

      {status === 'error' && (
        <div className={styles.error} role="alert" data-testid="stake-error">
          <p className={styles.errorText}>{errorMessage(state.reason)}</p>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => reset()}
          >
            Try again
          </button>
        </div>
      )}
    </section>
  );
}

/** Map a hook error reason to an honest, distinct message (no false success). */
function errorMessage(reason: string): string {
  switch (reason) {
    case 'insufficient-funds':
      return 'Insufficient UrStoa for this amount.';
    case 'invalid-amount':
      return 'Enter a valid amount — a positive number.';
    case 'vault-total-unknown':
      return "The vault total is unavailable, so this unstake can't be checked safely. Try again once holdings load.";
    default:
      return "The transaction couldn't be submitted. Check the amount and try again.";
  }
}

/**
 * The gold-tinted gasless pill (DESIGN.md "gasless"). UrStoa stake/unstake runs on
 * chain 0 and is sponsored by the gas station — the user pays no fee.
 */
function GaslessBadge(): ReactNode {
  return (
    <span className={styles.gaslessBadge} data-testid="stake-gasless-badge">
      gasless — the gas station pays
    </span>
  );
}
