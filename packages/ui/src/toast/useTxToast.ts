import { useCallback } from 'react';

import { useOptionalWallet } from '../context/WalletContext';
import { useToast } from './ToastContext';

/** The StoaChain explorer transaction URL for a request key. */
function explorerTxUrl(requestKey: string): string {
  return `https://explorer.stoachain.com/transactions/${requestKey}`;
}

export interface TrackTxOptions {
  /** The submitted transaction's request key (the explorer + confirmation handle). */
  readonly requestKey: string;
  /** The chain the tx was submitted on (UrStoa ops are chain "0"). */
  readonly chainId: string;
  /** Human label for the action, e.g. "Stake", "Transfer", "Collect". */
  readonly label: string;
  /** Fired once the tx is CONFIRMED on-chain (e.g. to refresh balances). */
  readonly onConfirmed?: () => void;
  /** Cooldown before a confirmed toast auto-dismisses (ms). Default 6000. */
  readonly confirmedDismissMs?: number;
  /** Cooldown before a failed/unconfirmed toast auto-dismisses (ms). Default 9000. */
  readonly failedDismissMs?: number;
}

/**
 * The ONE transaction-feedback mechanism shared across every flow (UrStoa
 * stake/unstake/collect/transfer, and any single-tx submit): given a submitted
 * request key, it opens a floating PENDING toast ("… submitted — confirming
 * on-chain"), polls the generic on-chain confirmation seam
 * (`awaitSendConfirmation`, which works for any request key on any chain), and
 * flips the SAME toast to a terminal state with an auto-dismiss cooldown:
 *
 *   - confirmed  → ✓ success + an explorer link, auto-dismiss after the cooldown.
 *   - failed     → ✗ error + the on-chain reason.
 *   - timeout/listen-failed → ℹ "couldn't confirm yet — check the explorer"
 *     (the tx MAY still be on chain; never read as success, never as a re-send).
 *
 * The returned `track` is fire-and-forget: the poll + toast updates run on the
 * app-level toast context, so they survive the submitting screen unmounting (the
 * UrStoa flows return to their overview the moment a tx is submitted).
 */
export function useTxToast(): (opts: TrackTxOptions) => void {
  const toast = useToast();
  // Non-throwing read so the hook is safe in standalone renders (e.g. a unit test
  // mounting a flow component without a WalletProvider). Without a wallet there is
  // no confirmation seam, so `track` becomes a no-op.
  const wallet = useOptionalWallet();
  const awaitSendConfirmation = wallet?.awaitSendConfirmation;

  return useCallback(
    (opts: TrackTxOptions): void => {
      if (awaitSendConfirmation === undefined) return;
      const {
        requestKey,
        chainId,
        label,
        onConfirmed,
        confirmedDismissMs = 6000,
        failedDismissMs = 9000,
      } = opts;

      const id = toast.show({
        status: 'pending',
        title: `${label} submitted`,
        detail: 'Confirming on-chain…',
      });

      const lower = label.toLowerCase();
      void awaitSendConfirmation(requestKey, chainId)
        .then((res) => {
          if (res.ok && res.status === 'confirmed') {
            // Surface WHERE it confirmed: the chain, plus the mined block when the
            // node's listen result exposed it ("On chain #0 · block 4815162").
            const where = `On chain #${chainId}`;
            const detail =
              res.blockHeight !== undefined
                ? `${where} · block ${res.blockHeight}`
                : where;
            toast.update(id, {
              status: 'success',
              title: `${label} confirmed`,
              detail,
              explorerUrl: explorerTxUrl(requestKey),
              autoDismissMs: confirmedDismissMs,
            });
            onConfirmed?.();
          } else if (res.ok && res.status === 'failed') {
            toast.update(id, {
              status: 'error',
              title: `${label} failed on-chain`,
              detail: res.detail,
              explorerUrl: explorerTxUrl(requestKey),
              autoDismissMs: failedDismissMs,
            });
          } else {
            // timeout / listen-failed: the tx may still be on chain — never a
            // success, never a prompt to re-send.
            toast.update(id, {
              status: 'info',
              title: `Couldn't confirm ${lower} yet`,
              detail: 'It may still be processing — check the explorer.',
              explorerUrl: explorerTxUrl(requestKey),
              autoDismissMs: failedDismissMs,
            });
          }
        })
        .catch(() => {
          toast.update(id, {
            status: 'info',
            title: `Couldn't confirm ${lower} yet`,
            detail: 'It may still be processing — check the explorer.',
            explorerUrl: explorerTxUrl(requestKey),
            autoDismissMs: failedDismissMs,
          });
        });
    },
    [toast, awaitSendConfirmation],
  );
}
