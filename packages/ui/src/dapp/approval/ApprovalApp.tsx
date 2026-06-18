import { useCallback, type ReactNode } from 'react';

// Global theme stylesheet (the `--color-stoa-*` vars the approval views' module
// CSS references). The approval window mounts ApprovalApp, NOT WalletApp, so it
// needs its own load of the shared theme or it renders unstyled.
import '../../theme/theme.css';

import { useSessionGuard } from '../../app/useSessionGuard';
import { UnlockScreen } from '../../wallet/UnlockScreen';
import type {
  ApprovalDecision,
  ApprovalPendingRequest,
} from './approvalTypes';
import { ConnectionApprovalView } from './ConnectionApprovalView';
import { SignatureApprovalView } from './SignatureApprovalView';

/**
 * The in-popup dApp APPROVAL surface — the wallet's highest-risk screen. The
 * router (T9.6) opens this in a window with a pending request and awaits exactly
 * ONE {@link ApprovalDecision} keyed on the SAME nonce + request id (RR#2). It
 * dispatches to the connection or signature view and reuses the Phase-7
 * re-unlock UX when the vault is locked at approval time.
 *
 * SECURITY POSTURE (load-bearing):
 *
 *   - REJECT-BY-DEFAULT (RR#13): an `approved: true` decision is ONLY ever
 *     produced by an explicit Approve click. There is NO unmount / teardown
 *     handler that sends an approve — a dismissed window emits nothing from here,
 *     and the router's `onRemoved` reconciles the closed window to
 *     `user-rejected` on its side. (Unmount-rejects are the router's job; the UI
 *     must merely never auto-approve.)
 *
 *   - LOCKED-FIRST: when `locked`, the reused {@link UnlockScreen} renders FIRST
 *     (never a broken/empty approval). Only once the background reports unlocked
 *     does the approval preview appear — the user unlocks, THEN sees what they're
 *     approving.
 *
 *   - SECRET-FREE: this surface previews only the PUBLIC artifact (the `cmd`
 *     string + origin) and emits only the user's yes/no. Signing happens in the
 *     background after an approve. Nothing key-shaped is rendered, returned, or
 *     logged.
 */
export interface ApprovalAppProps {
  /** The pending request the router opened this window with. */
  readonly request: ApprovalPendingRequest;
  /**
   * True when the vault was locked at approval time. While locked, the reused
   * unlock screen renders first; the approval appears only after the background
   * reports the session unlocked.
   */
  readonly locked?: boolean;
  /**
   * Emit the user's decision back to the background (the extension entry wires
   * this to `chrome.runtime.sendMessage`). Called at most once per click; never
   * called on unmount.
   */
  readonly onDecision: (decision: ApprovalDecision) => void;
}

export function ApprovalApp({
  request,
  locked = false,
  onDecision,
}: ApprovalAppProps): ReactNode {
  const { status } = useSessionGuard();

  const decide = useCallback(
    (approved: boolean) => {
      onDecision({
        requestId: request.requestId,
        nonce: request.nonce,
        approved,
      });
    },
    [onDecision, request.requestId, request.nonce],
  );

  const onApprove = useCallback(() => decide(true), [decide]);
  const onReject = useCallback(() => decide(false), [decide]);

  // Locked-first: show the reused unlock screen until the background confirms an
  // unlocked session. The session guard re-derives unlocked-state from the
  // background (the single source of truth under MV3), so a successful unlock
  // flips `status` to 'unlocked' and the approval is revealed.
  if (locked && status !== 'unlocked') {
    return <UnlockScreen sessionExpired />;
  }

  if (request.kind === 'connect') {
    return (
      <ConnectionApprovalView
        origin={request.origin}
        networkId={request.networkId}
        onApprove={onApprove}
        onReject={onReject}
      />
    );
  }

  return (
    <SignatureApprovalView
      origin={request.origin}
      commandSigDatas={request.commandSigDatas}
      onApprove={onApprove}
      onReject={onReject}
    />
  );
}
