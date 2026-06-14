import type { ReactNode } from 'react';

import type { ApprovalCommandSigData } from './approvalTypes';
import styles from './ApprovalApp.module.css';
import { ApprovalActions, ApprovalHeader } from './ApprovalChrome';
import {
  decodePactPreviews,
  type PactCapability,
  type PactPreview,
} from './decodePactPreview';

/**
 * The SIGNATURE-approval view (Phase-4 RR#5 preview discipline, but GENERIC):
 * render a TRANSACTION PREVIEW decoded from the dApp's command(s) so the user
 * sees EXACTLY what they sign BEFORE approving. Unlike the Phase-4 transfer
 * panel, this is a transfer-agnostic Pact-command preview — the pact CODE /
 * intent, the SIGNERS, the CAPABILITIES being signed (incl. a gas-payer sponsor
 * if present), and the requesting origin. Approve proceeds to sign in the
 * background; reject yields `user-rejected`.
 *
 * The view holds NO key material: it shows only the public `cmd` + origin.
 * Signing happens in the background after an approve.
 */
export interface SignatureApprovalViewProps {
  readonly origin: string;
  readonly commandSigDatas: readonly ApprovalCommandSigData[];
  readonly onApprove: () => void;
  readonly onReject: () => void;
}

function CapabilityRow({ cap }: { cap: PactCapability }): ReactNode {
  return (
    <li className={styles.cap}>
      <span
        className={
          cap.isGasPayer ? `${styles.capName} ${styles.capGasPayer}` : styles.capName
        }
      >
        {cap.name}
        {cap.isGasPayer ? ' (gas sponsor)' : ''}
      </span>
      {cap.args.length > 0 && (
        <span className={styles.capArgs}>{cap.args.join(', ')}</span>
      )}
    </li>
  );
}

function CommandPreview({
  preview,
  index,
}: {
  preview: PactPreview;
  index: number;
}): ReactNode {
  return (
    <div className={styles.previewCard} data-testid={`approval-command-${index}`}>
      <div>
        <p className={styles.sectionLabel}>Code</p>
        <pre className={styles.code} data-testid="approval-pact-code">
          {preview.code}
        </pre>
      </div>

      {(preview.chainId !== undefined || preview.sender !== undefined) && (
        <div className={styles.metaRow} data-testid="approval-meta">
          {preview.chainId !== undefined && <span>Chain {preview.chainId}</span>}
          {preview.sender !== undefined && <span>Gas: {preview.sender}</span>}
        </div>
      )}

      <div>
        <p className={styles.sectionLabel}>Signers</p>
        {preview.signers.length > 0 ? (
          <div className={styles.signers} data-testid="approval-signers">
            {preview.signers.map((s) => (
              <span key={s.pubKey} className={styles.signer}>
                {s.pubKey}
              </span>
            ))}
          </div>
        ) : (
          <p className={styles.empty} data-testid="approval-signers">
            No signer keys declared in this command.
          </p>
        )}
      </div>

      <div>
        <p className={styles.sectionLabel}>Capabilities</p>
        {preview.capabilities.length > 0 ? (
          <ul className={styles.caps} data-testid="approval-caps">
            {preview.capabilities.map((cap, i) => (
              <CapabilityRow key={`${cap.name}-${i}`} cap={cap} />
            ))}
          </ul>
        ) : (
          <p className={styles.empty} data-testid="approval-caps">
            No scoped capabilities — this command grants an unrestricted
            signature.
          </p>
        )}
      </div>
    </div>
  );
}

export function SignatureApprovalView({
  origin,
  commandSigDatas,
  onApprove,
  onReject,
}: SignatureApprovalViewProps): ReactNode {
  const previews = decodePactPreviews(commandSigDatas);

  return (
    <section className={styles.screen} data-testid="approval-signature">
      <ApprovalHeader
        origin={origin}
        title="Sign transaction"
        framing="This site is asking you to sign:"
      />
      <div className={styles.preview} data-testid="approval-preview">
        {previews.map((preview, i) => (
          <CommandPreview key={i} preview={preview} index={i} />
        ))}
      </div>
      <ApprovalActions
        approveLabel="Approve & sign"
        onApprove={onApprove}
        onReject={onReject}
      />
    </section>
  );
}
