import { STOA_CHAINS } from '@stoawallet/core';
import { useCallback, useState, type ReactNode } from 'react';

import styles from './ContinuationRecoveryView.module.css';
import {
  useContinuationResume,
  type UseContinuationResumeOptions,
} from './useContinuationResume';

/** The braided chain IDs — core's canonical `STOA_CHAINS` is the single source. */
const CHAIN_IDS: readonly string[] = STOA_CHAINS;

const EXPLORER_TX = 'https://explorer.stoachain.com/transactions/';

/**
 * The identity a routed pending-transfer affordance hands this view so the user
 * never re-types the burn it already knows about. The shape MATCHES T5.7's
 * `onRouteToRecovery` payload — request key plus the source/target chain pair.
 */
export interface ContinuationRecoveryPrefill {
  readonly requestKey: string;
  readonly sourceChain: string;
  readonly targetChain: string;
}

export interface ContinuationRecoveryViewProps {
  /**
   * Forwarded verbatim to `useContinuationResume` — the stubbed resume op and
   * the on-success refresh trigger. The app shell wires the real ops; tests
   * inject stubs. The view holds NO key material: the continuation is the
   * unsigned/public gas-station path, so this seam wraps core directly.
   */
  readonly hookOptions?: UseContinuationResumeOptions;
  /**
   * Pre-populates the request-key + chain inputs when routed from a pending
   * transfer (T5.7), so the user resumes without re-typing the burn identity.
   */
  readonly prefill?: ContinuationRecoveryPrefill;
}

/**
 * The RECOVERY ("Continue X-Chain") screen: drive a STALLED cross-chain transfer
 * to completion. RESUME, NEVER RESTART — the source-chain burn already committed
 * the funds to escrow; this view only nudges the step-1 continuation home. It
 * has NO control that re-builds or re-submits the original Step-0 transfer, and
 * it holds NO key material (the continuation is gas-station-sponsored/unsigned).
 *
 * The user supplies the Step-0 request key (with a paste helper) and the
 * source/target chain pair; the matching target option is disabled so a
 * nonsensical same-chain resume can't be picked. The single "Check & Resume"
 * control binds its `disabled` to the hook's `canResume` rather than re-deriving
 * the condition inline.
 *
 * Every hook state maps to a CLEARLY-DISTINCT surface so the user is never
 * misled:
 *   - checking         → a staged progress line.
 *   - step0-pending    → "Step 0 still pending — check again later" (retryable).
 *   - spv-unavailable  → "Proof not yet available — try again shortly" (retryable).
 *   - continuation-pending / thrown → submitted-but-unconfirmed (retryable).
 *   - not-found        → "Not found on this chain".
 *   - no-continuation  → "Not a cross-chain transfer".
 *   - error            → a hard failure surface.
 *   - success (incl. already-completed) → "Continuation Executed" with the
 *                        continuation key, a copy control, an explorer link, and
 *                        a "Resume Another" reset. already-completed shows the
 *                        success-without-resubmit variant.
 */
export function ContinuationRecoveryView({
  hookOptions,
  prefill,
}: ContinuationRecoveryViewProps): ReactNode {
  const [requestKey, setRequestKey] = useState(prefill?.requestKey ?? '');
  const [sourceChain, setSourceChain] = useState(
    prefill?.sourceChain ?? CHAIN_IDS[0],
  );
  const [targetChain, setTargetChain] = useState(
    prefill?.targetChain ?? CHAIN_IDS[1],
  );

  const { state, canResume, resume, reset } = useContinuationResume({
    ...hookOptions,
    requestKey,
    sourceChain,
    targetChain,
  });

  const onPaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim() !== '') setRequestKey(text.trim());
    } catch {
      // Clipboard read can be denied; the field stays manually editable, so a
      // paste failure is non-fatal and intentionally quiet.
    }
  }, []);

  const onSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    void resume({ requestKey, sourceChain, targetChain });
  };

  const onResumeAnother = (): void => {
    reset();
    setRequestKey('');
  };

  return (
    <section className={styles.view} data-testid="recovery-view">
      <h1 className={styles.heading}>Continue X-Chain</h1>
      <p className={styles.subheading}>
        Resume a stalled cross-chain transfer. This drives the pending step home
        — it never re-sends the original transfer.
      </p>

      <form className={styles.fields} onSubmit={onSubmit}>
        <label className={styles.label}>
          <span className={styles.labelText}>Step-0 request key</span>
          <div className={styles.requestRow}>
            <input
              data-testid="recovery-request-key"
              className={styles.input}
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="request key from the original transfer"
              value={requestKey}
              onChange={(e) => setRequestKey(e.target.value)}
            />
            <button
              type="button"
              className={styles.paste}
              onClick={() => void onPaste()}
            >
              Paste
            </button>
          </div>
        </label>

        <div className={styles.chainRow}>
          <label className={styles.label}>
            <span className={styles.labelText}>From chain</span>
            <select
              data-testid="recovery-source"
              className={styles.input}
              value={sourceChain}
              onChange={(e) => setSourceChain(e.target.value)}
            >
              {CHAIN_IDS.map((id) => (
                <option key={id} value={id}>
                  Chain {id}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.label}>
            <span className={styles.labelText}>To chain</span>
            <select
              data-testid="recovery-target"
              className={styles.input}
              value={targetChain}
              onChange={(e) => setTargetChain(e.target.value)}
            >
              {CHAIN_IDS.map((id) => (
                <option key={id} value={id} disabled={id === sourceChain}>
                  Chain {id}
                </option>
              ))}
            </select>
          </label>
        </div>

        <button
          type="submit"
          data-testid="recovery-submit"
          className={styles.primary}
          disabled={!canResume}
        >
          Check &amp; Resume
        </button>
      </form>

      <StatusSurface state={state} onResumeAnother={onResumeAnother} />
    </section>
  );
}

/** Map each hook state to its own distinct surface. */
function StatusSurface({
  state,
  onResumeAnother,
}: {
  state: ReturnType<typeof useContinuationResume>['state'];
  onResumeAnother: () => void;
}): ReactNode {
  switch (state.step) {
    case 'idle':
      return null;

    case 'checking':
      return (
        <div className={styles.stage} role="status" data-testid="recovery-checking">
          Checking the transfer and driving the continuation…
        </div>
      );

    case 'pending':
      return <PendingSurface reason={state.reason} requestKey={state.requestKey} />;

    case 'not-found':
      return (
        <div className={styles.error} role="alert" data-testid="recovery-not-found">
          <p className={styles.errorText}>
            Not found on this chain. Check the request key and the From chain.
          </p>
        </div>
      );

    case 'no-continuation':
      return (
        <div
          className={styles.info}
          role="status"
          data-testid="recovery-no-continuation"
        >
          <p className={styles.infoText}>
            Not a cross-chain transfer — this request key has no continuation to
            resume.
          </p>
        </div>
      );

    case 'same-chain':
      return (
        <div className={styles.info} role="status" data-testid="recovery-same-chain">
          <p className={styles.infoText}>
            Pick two different chains — a cross-chain resume needs a distinct
            source and target.
          </p>
        </div>
      );

    case 'error':
      return (
        <div className={styles.error} role="alert" data-testid="recovery-error">
          <p className={styles.errorText}>
            The continuation could not be completed. Check the explorer before
            retrying.
          </p>
          {state.requestKey !== undefined && (
            <p className={styles.requestKey}>
              Request key:{' '}
              <span className={styles.mono} data-testid="recovery-error-request-key">
                {state.requestKey}
              </span>
            </p>
          )}
        </div>
      );

    case 'success':
      return (
        <SuccessSurface
          continuationKey={state.continuationKey}
          alreadyCompleted={state.reason === 'already-completed'}
          onResumeAnother={onResumeAnother}
        />
      );
  }
}

/** The retryable pending surfaces — distinct copy per reason, no resubmit. */
function PendingSurface({
  reason,
  requestKey,
}: {
  reason: 'step0-pending' | 'spv-unavailable' | 'continuation-pending' | 'thrown';
  requestKey?: string;
}): ReactNode {
  const message =
    reason === 'step0-pending'
      ? 'Step 0 still pending — check again later.'
      : reason === 'spv-unavailable'
        ? 'Proof not yet available — try again shortly.'
        : 'Submitted — confirmation unknown. Check the explorer before retrying.';

  return (
    <div className={styles.pending} role="status" data-testid="recovery-pending">
      <p className={styles.pendingText}>{message}</p>
      {requestKey !== undefined && (
        <p className={styles.requestKey}>
          Request key: <span className={styles.mono}>{requestKey}</span>
        </p>
      )}
    </div>
  );
}

/** The terminal success surface — continuation key, copy, explorer, reset. */
function SuccessSurface({
  continuationKey,
  alreadyCompleted,
  onResumeAnother,
}: {
  continuationKey?: string;
  alreadyCompleted: boolean;
  onResumeAnother: () => void;
}): ReactNode {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    if (continuationKey === undefined) return;
    try {
      await navigator.clipboard.writeText(continuationKey);
      setCopied(true);
    } catch {
      // Clipboard write can be denied; the key is still selectable on screen.
      setCopied(false);
    }
  }, [continuationKey]);

  return (
    <div className={styles.success} data-testid="recovery-success">
      <p className={styles.successText}>Continuation Executed</p>
      <p className={styles.successDetail}>
        {alreadyCompleted
          ? "This transfer's continuation already completed."
          : 'The transfer has landed on the target chain.'}
      </p>

      {continuationKey !== undefined && (
        <>
          <p className={styles.requestKey}>
            Continuation key:{' '}
            <span className={styles.mono} data-testid="recovery-continuation-key">
              {continuationKey}
            </span>
          </p>
          <div className={styles.successActions}>
            <button type="button" className={styles.secondary} onClick={() => void onCopy()}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            <a
              className={styles.explorerLink}
              href={`${EXPLORER_TX}${continuationKey}`}
              target="_blank"
              rel="noreferrer"
            >
              View on explorer
            </a>
          </div>
        </>
      )}

      <button type="button" className={styles.secondary} onClick={onResumeAnother}>
        Resume Another
      </button>
    </div>
  );
}
