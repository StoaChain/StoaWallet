/**
 * The wire contract between the dApp-request ROUTER (T9.6, in the background) and
 * the in-popup APPROVAL surface (this package).
 *
 * The router opens an approval window with an {@link ApprovalPendingRequest} —
 * the canonical origin it verified, the RR#2 correlation `nonce`, the correlation
 * `requestId`, and (for a sign) the FROZEN command(s) to preview. The surface
 * renders an explicit approve/reject prompt and emits exactly ONE
 * {@link ApprovalDecision} carrying the SAME `nonce` + `requestId` back to the
 * background, which resolves the matching pending request.
 *
 * SECURITY INVARIANTS:
 *
 *   - The surface NEVER holds or returns key material. It previews only the
 *     PUBLIC artifact (the `cmd` string, the requesting origin) and the user's
 *     yes/no. Signing happens in the background AFTER an approve.
 *
 *   - REJECT-BY-DEFAULT (RR#13): the only way an `approved: true` decision is
 *     produced is an explicit user click. A dismiss / unmount / teardown emits
 *     no approve — the router's `onRemoved` close-handler reconciles a closed
 *     window to `user-rejected` on its side.
 *
 *   - NONCE-CORRELATION (RR#2): the decision echoes the request `nonce` so two
 *     concurrent approvals never cross-resolve.
 */

/** A single signature slot mirrored from the protocol's `DappSig` (public data). */
export interface ApprovalSig {
  readonly pubKey: string;
  readonly sig: string | null;
}

/** A dApp command envelope to preview — the stringified `cmd` plus its sig slots. */
export interface ApprovalCommandSigData {
  readonly cmd: string;
  readonly sigs: readonly ApprovalSig[];
}

/**
 * The pending request the router hands the approval surface. A `connect` shows
 * the origin asking for account access; a `sign` additionally carries the FROZEN
 * command(s) to render as a generic Pact preview.
 */
export type ApprovalPendingRequest =
  | {
      readonly kind: 'connect';
      readonly requestId: string;
      readonly nonce: string;
      readonly origin: string;
      readonly networkId: string;
    }
  | {
      readonly kind: 'sign';
      readonly requestId: string;
      readonly nonce: string;
      readonly origin: string;
      readonly networkId: string;
      readonly commandSigDatas: readonly ApprovalCommandSigData[];
    };

/**
 * The user's decision, echoing the correlation keys. `approved: true` is ONLY
 * ever produced by an explicit approve click. The background maps `approved`
 * false → `user-rejected`.
 */
export interface ApprovalDecision {
  readonly requestId: string;
  readonly nonce: string;
  readonly approved: boolean;
}
