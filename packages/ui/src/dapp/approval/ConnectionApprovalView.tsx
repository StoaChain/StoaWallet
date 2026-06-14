import type { ReactNode } from 'react';

import styles from './ApprovalApp.module.css';
import { ApprovalActions, ApprovalHeader } from './ApprovalChrome';

/**
 * The CONNECTION-approval view: a site is asking the wallet to expose account
 * access. It renders the requesting ORIGIN prominently (the canonical origin the
 * router verified — matching the T9.2 allow-list key, so a path/subdomain trick
 * cannot mislead the user) and explicit APPROVE / REJECT.
 *
 * Approve resolves the router's pending connect with approval (→ allow(origin));
 * reject yields `user-rejected`. This view holds no key material — connecting
 * grants the origin read access to PUBLIC `k:` accounts only.
 */
export interface ConnectionApprovalViewProps {
  readonly origin: string;
  readonly networkId: string;
  readonly onApprove: () => void;
  readonly onReject: () => void;
}

export function ConnectionApprovalView({
  origin,
  networkId,
  onApprove,
  onReject,
}: ConnectionApprovalViewProps): ReactNode {
  return (
    <section className={styles.screen} data-testid="approval-connection">
      <ApprovalHeader
        origin={origin}
        title="Connect to wallet"
        framing="This site is requesting to connect:"
      />
      <div className={styles.body}>
        <p className={styles.connectNote}>
          Approving lets this site see your public account address on{' '}
          <strong>{networkId}</strong> and ask you to sign transactions. It
          cannot move funds or sign anything without your explicit approval each
          time.
        </p>
      </div>
      <ApprovalActions
        approveLabel="Approve"
        onApprove={onApprove}
        onReject={onReject}
      />
    </section>
  );
}
