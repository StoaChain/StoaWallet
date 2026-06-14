import { type StoredAccount } from '@stoawallet/core';
import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WalletProvider,
  useWallet,
  type WalletContextValue,
} from '../../context/WalletContext';
import { ReceiveView } from '../ReceiveView';

const PASSWORD = 'correct horse battery staple';

/**
 * Render the receive view under a real provider plus a control probe, so the
 * active account the view reads is the SAME one the test onboards into the
 * shared keyring manager — no hand-rolled account fixtures that could drift
 * from the real derivation.
 */
function renderReceive(
  storage = new InMemoryStorageAdapter(),
  keyVault = new InMemoryKeyVault(),
) {
  const ctl: { current: WalletContextValue | null } = { current: null };

  function Probe(): null {
    ctl.current = useWallet();
    return null;
  }

  render(
    <WalletProvider storage={storage} keyVault={keyVault}>
      <Probe />
      <ReceiveView />
    </WalletProvider>,
  );

  return { ctl, storage, keyVault };
}

async function onboard(ctl: { current: WalletContextValue | null }) {
  await act(async () => {
    await ctl.current!.startCreate();
    await ctl.current!.saveWallet(PASSWORD);
  });
}

describe('ReceiveView', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the FULL active k: address as real selectable text (not truncated, not an image)', async () => {
    const { ctl } = renderReceive();
    await onboard(ctl);
    const account = ctl.current!.activeAccount as StoredAccount;

    // The complete address must appear verbatim as DOM text so the user can
    // hand-select it — a truncated "k:abcd…wxyz" would be unusable for receiving.
    await waitFor(() =>
      expect(screen.getByTestId('receive-address')).toHaveTextContent(
        account.account,
      ),
    );
    // Belt-and-suspenders: the exact full string is queryable as text, proving
    // it is not rendered as an <img>/canvas the user cannot select.
    expect(screen.getByText(account.account)).toBeInTheDocument();
  });

  it('encodes the EXACT full k: address into the scannable QR', async () => {
    const { ctl } = renderReceive();
    await onboard(ctl);
    const account = ctl.current!.activeAccount as StoredAccount;

    // The QR must carry the precise address — a QR that drops a character or
    // encodes a truncated form would send funds to the wrong place when scanned.
    await waitFor(() =>
      expect(screen.getByTestId('receive-qr')).toBeInTheDocument(),
    );
    const qr = screen.getByTestId('receive-qr');
    expect(qr).toHaveAttribute('data-qr-value', account.account);
    // qrcode.react emits a real <svg> — assert the scannable element exists.
    expect(qr.querySelector('svg')).not.toBeNull();
  });

  it('copy control invokes clipboard.writeText with the EXACT active address and shows confirmation', async () => {
    const { ctl } = renderReceive();
    await onboard(ctl);
    const account = ctl.current!.activeAccount as StoredAccount;

    await waitFor(() => expect(screen.getByTestId('receive-qr')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    });

    // The handler must copy the precise full address, not a truncated/derived
    // string — pinning the argument catches any accidental slicing.
    expect(writeText).toHaveBeenCalledWith(account.account);
    // Confirmation feedback tells the user the copy succeeded.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument(),
    );
  });

  it('switching the active account updates BOTH the displayed address and the QR value', async () => {
    const { ctl } = renderReceive();
    await onboard(ctl);
    const account0 = ctl.current!.activeAccount as StoredAccount;

    // Derive a second account and make it active — the view must follow.
    await act(async () => {
      await ctl.current!.addAccount();
    });
    const account1 = ctl.current!.activeAccount as StoredAccount;
    expect(account1.account).not.toBe(account0.account);

    // Both the selectable text AND the QR must now reflect account 1's address,
    // so a user who switched accounts never receives to the previous account.
    await waitFor(() =>
      expect(screen.getByTestId('receive-address')).toHaveTextContent(
        account1.account,
      ),
    );
    expect(screen.getByTestId('receive-qr')).toHaveAttribute(
      'data-qr-value',
      account1.account,
    );
    expect(
      within(screen.getByTestId('receive-address')).queryByText(
        account0.account,
      ),
    ).toBeNull();
  });

  it('with NO active account shows a distinct idle/locked affordance — no QR, no address, never an empty QR', async () => {
    // Render without onboarding: activeAccount stays null.
    renderReceive();

    await waitFor(() =>
      expect(screen.getByTestId('receive-idle')).toBeInTheDocument(),
    );

    // The idle state must NOT render a QR (which would encode an empty/garbage
    // value) nor an address — both are meaningless with no account.
    expect(screen.queryByTestId('receive-qr')).not.toBeInTheDocument();
    expect(screen.queryByTestId('receive-address')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /copy/i }),
    ).not.toBeInTheDocument();
  });

  it('does not log the k: address', async () => {
    const logSpy = vi.spyOn(console, 'log');
    const errSpy = vi.spyOn(console, 'error');
    const { ctl } = renderReceive();
    await onboard(ctl);
    const account = ctl.current!.activeAccount as StoredAccount;

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    });

    const logged = [...logSpy.mock.calls, ...errSpy.mock.calls]
      .flat()
      .map((arg: unknown) =>
        typeof arg === 'string' ? arg : JSON.stringify(arg),
      )
      .join('\n');
    expect(logged).not.toContain(account.account);
  });
});
