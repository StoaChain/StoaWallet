import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import { fireEvent, render, screen } from '@testing-library/react';
import { type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { WalletProvider } from '../../../context/WalletContext';
import { ApprovalApp } from '../ApprovalApp';
import type {
  ApprovalDecision,
  ApprovalPendingRequest,
} from '../approvalTypes';

/**
 * UI contract tests for the dApp APPROVAL surface — the wallet's highest-risk
 * screen. The router (T9.6) opens this in a window with a pending request and
 * awaits an {@link ApprovalDecision} keyed on the SAME nonce + request id it
 * opened with (RR#2 nonce-correlation). These tests pin:
 *
 *   - the CONNECTION view: origin shown; approve → approved decision; reject →
 *     user-rejected — both carrying the request's nonce + id.
 *   - the SIGNATURE view: a NON-EMPTY GENERIC Pact preview (code + signers +
 *     caps) decoded from a non-transfer `cmd`; approve → approved; reject →
 *     user-rejected.
 *   - REJECT-BY-DEFAULT (RR#13): a dismiss/unmount path NEVER sends an approve.
 *   - the origin appears on BOTH views.
 *   - LOCKED: the re-unlock screen renders FIRST (reused), not the approval.
 *
 * Only the OUTWARD decision seam (`onDecision`) is a double — it stands in for
 * the `chrome.runtime.sendMessage` the extension entry wires. The views are
 * real; the WalletProvider is real (over in-memory adapters) so the reused
 * `UnlockScreen` mounts exactly as it does in production.
 */

const ORIGIN = 'https://dapp.example.com';
const NONCE = 'nonce-abc123';
const REQUEST_ID = 'req-42';

/** A non-transfer Pact command: a generic on-chain call with a gas-payer cap. */
const NON_TRANSFER_CMD = JSON.stringify({
  payload: {
    exec: {
      code: '(free.my-dao.cast-vote "proposal-7" true)',
      data: {},
    },
  },
  signers: [
    {
      pubKey: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888',
      clist: [
        { name: 'free.my-dao.VOTE', args: ['proposal-7'] },
        {
          name: 'coin.GAS_PAYER',
          args: ['gas-station', { int: 1 }, 1.0],
        },
      ],
    },
  ],
  meta: { chainId: '3', sender: 'gas-station', gasLimit: 1500 },
  networkId: 'stoachain',
});

function connectRequest(): ApprovalPendingRequest {
  return {
    kind: 'connect',
    requestId: REQUEST_ID,
    nonce: NONCE,
    origin: ORIGIN,
    networkId: 'stoachain',
  };
}

function signRequest(cmd: string = NON_TRANSFER_CMD): ApprovalPendingRequest {
  return {
    kind: 'sign',
    requestId: REQUEST_ID,
    nonce: NONCE,
    origin: ORIGIN,
    networkId: 'stoachain',
    commandSigDatas: [{ cmd, sigs: [{ pubKey: 'aaaa1111', sig: null }] }],
  };
}

function renderApproval(
  request: ApprovalPendingRequest,
  opts: { locked?: boolean; onDecision?: (d: ApprovalDecision) => void } = {},
): { onDecision: (d: ApprovalDecision) => void; unmount: () => void } {
  const onDecision = opts.onDecision ?? vi.fn();
  const storage = new InMemoryStorageAdapter();
  const keyVault = new InMemoryKeyVault();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <WalletProvider storage={storage} keyVault={keyVault}>
      {children}
    </WalletProvider>
  );
  const { unmount } = render(
    <Wrapper>
      <ApprovalApp
        request={request}
        locked={opts.locked ?? false}
        onDecision={onDecision}
      />
    </Wrapper>,
  );
  return { onDecision, unmount };
}

describe('ApprovalApp — connection view', () => {
  it('renders the requesting origin so the user is not misled about who is asking', () => {
    renderApproval(connectRequest());
    expect(screen.getByTestId('approval-origin')).toHaveTextContent(ORIGIN);
  });

  it('APPROVE sends an approved decision carrying the request nonce + id (RR#2)', () => {
    const onDecision = vi.fn();
    renderApproval(connectRequest(), { onDecision });

    fireEvent.click(screen.getByTestId('approval-approve'));

    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      nonce: NONCE,
      approved: true,
    });
  });

  it('REJECT sends an unapproved decision (user-rejected), never an allow', () => {
    const onDecision = vi.fn();
    renderApproval(connectRequest(), { onDecision });

    fireEvent.click(screen.getByTestId('approval-reject'));

    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      nonce: NONCE,
      approved: false,
    });
  });
});

describe('ApprovalApp — signature view (generic Pact preview)', () => {
  it('renders the decoded Pact CODE from a non-transfer command (non-empty preview)', () => {
    renderApproval(signRequest());
    expect(screen.getByTestId('approval-pact-code')).toHaveTextContent(
      '(free.my-dao.cast-vote "proposal-7" true)',
    );
  });

  it('renders the SIGNERS decoded from the command', () => {
    renderApproval(signRequest());
    expect(screen.getByTestId('approval-signers')).toHaveTextContent(
      'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888',
    );
  });

  it('renders the CAPABILITIES (clist) the user is about to sign, including the gas-payer sponsor', () => {
    renderApproval(signRequest());
    const caps = screen.getByTestId('approval-caps');
    expect(caps).toHaveTextContent('free.my-dao.VOTE');
    expect(caps).toHaveTextContent('coin.GAS_PAYER');
  });

  it('renders a NON-EMPTY preview even for a command with no signers/caps (a bare exec)', () => {
    const bare = JSON.stringify({ payload: { exec: { code: '(format "{}" [1])' } } });
    renderApproval(signRequest(bare));
    expect(screen.getByTestId('approval-pact-code')).toHaveTextContent('(format "{}" [1])');
    expect(screen.getByTestId('approval-preview')).toBeInTheDocument();
  });

  it('APPROVE on a sign sends an approved decision (proceed-to-sign) with nonce + id', () => {
    const onDecision = vi.fn();
    renderApproval(signRequest(), { onDecision });

    fireEvent.click(screen.getByTestId('approval-approve'));

    expect(onDecision).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      nonce: NONCE,
      approved: true,
    });
  });

  it('REJECT on a sign sends user-rejected and the signer never proceeds', () => {
    const onDecision = vi.fn();
    renderApproval(signRequest(), { onDecision });

    fireEvent.click(screen.getByTestId('approval-reject'));

    expect(onDecision).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      nonce: NONCE,
      approved: false,
    });
  });
});

describe('ApprovalApp — reject-by-default (RR#13)', () => {
  it('an unmount WITHOUT an explicit approve never emits an approved decision', () => {
    const onDecision = vi.fn();
    const { unmount } = renderApproval(signRequest(), { onDecision });

    // The user dismisses the window (close / navigate away) — teardown only.
    unmount();

    const approvedCalls = onDecision.mock.calls.filter(
      ([d]) => (d as ApprovalDecision).approved === true,
    );
    expect(approvedCalls).toHaveLength(0);
  });
});

describe('ApprovalApp — origin on both views', () => {
  it('shows the origin on the connection view', () => {
    renderApproval(connectRequest());
    expect(screen.getByTestId('approval-origin')).toHaveTextContent(ORIGIN);
  });

  it('shows the origin on the signature view', () => {
    renderApproval(signRequest());
    expect(screen.getByTestId('approval-origin')).toHaveTextContent(ORIGIN);
  });
});

describe('ApprovalApp — locked handling (re-unlock first)', () => {
  it('renders the reused unlock screen FIRST when the wallet is locked, not the approval', () => {
    renderApproval(signRequest(), { locked: true });

    // The reused UnlockScreen heading is present…
    expect(screen.getByText('Unlock wallet')).toBeInTheDocument();
    // …and the approval preview/decision controls are NOT yet rendered.
    expect(screen.queryByTestId('approval-preview')).not.toBeInTheDocument();
    expect(screen.queryByTestId('approval-approve')).not.toBeInTheDocument();
  });

  it('does not auto-approve while locked (no decision is emitted from the unlock gate)', () => {
    const onDecision = vi.fn();
    renderApproval(signRequest(), { locked: true, onDecision });
    expect(onDecision).not.toHaveBeenCalled();
  });
});
