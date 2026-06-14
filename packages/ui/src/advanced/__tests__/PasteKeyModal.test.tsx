import type { AdvancedAccount } from '@stoawallet/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PasteKeyModal } from '../PasteKeyModal';
import type { ContextResolveForeignKeyResult } from '../useAdvancedAccounts';

/**
 * A 64-char hex private key used as the secret under test. The DOM must NEVER
 * contain this whole token, and no console sink may receive it.
 */
const PRIVATE_KEY_64 =
  'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
/** A second public key the guard still needs, distinct from the entered key. */
const NEEDED_PUBKEY =
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

function makeAccount(
  overrides: Partial<AdvancedAccount> = {},
): AdvancedAccount {
  return {
    id: 'adv-1',
    address:
      'k:2222222222222222222222222222222222222222222222222222222222222222',
    type: 'custom-account',
    mode: 'watch-only',
    createdAt: '2026-01-01T00:00:00.000Z',
    guardSummary: {
      pred: 'keys-all',
      threshold: 2,
      neededMore: 2,
      predicateRecognized: true,
      keys: [NEEDED_PUBKEY],
    },
    ...overrides,
  };
}

/** Locate the password input regardless of label wiring. */
function keyInput(): HTMLInputElement {
  return document.querySelector(
    'input[type="password"]',
  ) as HTMLInputElement;
}

describe('PasteKeyModal', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Assert NO console sink ever received the raw private key as a whole token. */
  function expectNoConsoleLeak(): void {
    for (const spy of [errorSpy, logSpy, warnSpy, infoSpy, debugSpy]) {
      for (const call of spy.mock.calls) {
        for (const arg of call) {
          expect(String(arg)).not.toContain(PRIVATE_KEY_64);
        }
      }
    }
  }

  it('shows the format hint for a 63-char / non-hex input and does not call pasteKey', () => {
    const pasteKey = vi.fn<
      (a: AdvancedAccount, k: string) => Promise<ContextResolveForeignKeyResult>
    >();
    render(
      <PasteKeyModal
        account={makeAccount()}
        pasteKey={pasteKey}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(keyInput(), {
      target: { value: PRIVATE_KEY_64.slice(0, 63) },
    });
    fireEvent.click(screen.getByRole('button', { name: /paste|submit|confirm/i }));

    expect(screen.getByText(/64 or 128 hex chars/i)).toBeInTheDocument();
    expect(pasteKey).not.toHaveBeenCalled();
  });

  it('submits a valid-format key with the EXACT entered value', async () => {
    const pasteKey = vi.fn(
      async (
        _account: AdvancedAccount,
        _privateKey: string,
      ): Promise<ContextResolveForeignKeyResult> => ({
        ok: true,
        mode: 'send-capable',
      }),
    );
    render(
      <PasteKeyModal
        account={makeAccount()}
        pasteKey={pasteKey}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(keyInput(), { target: { value: PRIVATE_KEY_64 } });
    fireEvent.click(screen.getByRole('button', { name: /paste|submit|confirm/i }));

    await waitFor(() => {
      expect(pasteKey).toHaveBeenCalledTimes(1);
    });
    expect(pasteKey.mock.calls[0][1]).toBe(PRIVATE_KEY_64);
    expectNoConsoleLeak();
  });

  it('renders the key-mismatch message with ONLY truncated public info and NO private key in the DOM', async () => {
    const pasteKey = vi.fn(
      async (): Promise<ContextResolveForeignKeyResult> => ({
        ok: false,
        reason: 'key-mismatch',
      }),
    );
    const { container } = render(
      <PasteKeyModal
        account={makeAccount()}
        pasteKey={pasteKey}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(keyInput(), { target: { value: PRIVATE_KEY_64 } });
    fireEvent.click(screen.getByRole('button', { name: /paste|submit|confirm/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/does not match the guard/i),
      ).toBeInTheDocument();
    });
    // The whole private key must NEVER appear anywhere in the rendered DOM.
    expect(container).not.toHaveTextContent(PRIVATE_KEY_64);
    expectNoConsoleLeak();
  });

  it('shows "now signable" on a send-capable paste', async () => {
    const pasteKey = vi.fn(
      async (): Promise<ContextResolveForeignKeyResult> => ({
        ok: true,
        mode: 'send-capable',
      }),
    );
    render(
      <PasteKeyModal
        account={makeAccount()}
        pasteKey={pasteKey}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(keyInput(), { target: { value: PRIVATE_KEY_64 } });
    fireEvent.click(screen.getByRole('button', { name: /paste|submit|confirm/i }));

    await waitFor(() => {
      expect(screen.getByText(/now signable/i)).toBeInTheDocument();
    });
  });

  it('shows the remaining count on a watch-only paste with neededMore', async () => {
    const pasteKey = vi.fn(
      async (): Promise<ContextResolveForeignKeyResult> => ({
        ok: true,
        mode: 'watch-only',
        neededMore: 2,
      }),
    );
    render(
      <PasteKeyModal
        account={makeAccount()}
        pasteKey={pasteKey}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(keyInput(), { target: { value: PRIVATE_KEY_64 } });
    fireEvent.click(screen.getByRole('button', { name: /paste|submit|confirm/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/2 more key\(s\) still needed/i),
      ).toBeInTheDocument();
    });
  });

  it('renders the guard-changed message for a guard-changed outcome', async () => {
    const pasteKey = vi.fn(
      async (): Promise<ContextResolveForeignKeyResult> => ({
        ok: false,
        reason: 'guard-changed',
      }),
    );
    render(
      <PasteKeyModal
        account={makeAccount()}
        pasteKey={pasteKey}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(keyInput(), { target: { value: PRIVATE_KEY_64 } });
    fireEvent.click(screen.getByRole('button', { name: /paste|submit|confirm/i }));

    await waitFor(() => {
      expect(screen.getByText(/guard changed/i)).toBeInTheDocument();
    });
  });

  it('maps a locked outcome to an unlock-and-retry message, NOT a key-mismatch (PAT-004)', async () => {
    // PAT-004: a `locked` result must NOT render the misleading "does not match
    // the guard" copy. It surfaces a neutral unlock-and-retry outcome with an
    // unlock affordance when onRequireUnlock is wired.
    const pasteKey = vi.fn(
      async (): Promise<ContextResolveForeignKeyResult> => ({
        ok: false,
        reason: 'locked',
      }),
    );
    const onRequireUnlock = vi.fn();
    render(
      <PasteKeyModal
        account={makeAccount()}
        pasteKey={pasteKey}
        onClose={vi.fn()}
        onRequireUnlock={onRequireUnlock}
      />,
    );

    fireEvent.change(keyInput(), { target: { value: PRIVATE_KEY_64 } });
    fireEvent.click(screen.getByRole('button', { name: /paste|submit|confirm/i }));

    await waitFor(() => {
      expect(screen.getByTestId('paste-locked')).toHaveTextContent(
        /unlock and retry/i,
      );
    });
    // It is NOT the key-mismatch message.
    expect(screen.queryByText(/does not match the guard/i)).toBeNull();

    // The unlock affordance routes to unlock.
    fireEvent.click(screen.getByTestId('paste-unlock'));
    expect(onRequireUnlock).toHaveBeenCalledTimes(1);
  });

  it('clears the input on cancel: reopening shows an empty field', () => {
    const onClose = vi.fn();
    const account = makeAccount();
    const pasteKey = vi.fn<
      (a: AdvancedAccount, k: string) => Promise<ContextResolveForeignKeyResult>
    >();
    const first = render(
      <PasteKeyModal account={account} pasteKey={pasteKey} onClose={onClose} />,
    );

    fireEvent.change(keyInput(), { target: { value: PRIVATE_KEY_64 } });
    expect(keyInput().value).toBe(PRIVATE_KEY_64);

    fireEvent.click(screen.getByRole('button', { name: /cancel|close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    // Cancel clears the input in place: the ref-backed value is reset to empty.
    expect(keyInput().value).toBe('');

    // Unmount (the cleanup effect also clears), then a fresh open shows empty.
    first.unmount();
    render(
      <PasteKeyModal account={account} pasteKey={pasteKey} onClose={onClose} />,
    );
    expect(keyInput().value).toBe('');
    expectNoConsoleLeak();
  });

  it('emits no private-key whole-token to any console sink across enter -> submit -> close', async () => {
    const onClose = vi.fn();
    const pasteKey = vi.fn(
      async (): Promise<ContextResolveForeignKeyResult> => ({
        ok: false,
        reason: 'key-mismatch',
      }),
    );
    render(
      <PasteKeyModal
        account={makeAccount()}
        pasteKey={pasteKey}
        onClose={onClose}
      />,
    );

    fireEvent.change(keyInput(), { target: { value: PRIVATE_KEY_64 } });
    fireEvent.click(screen.getByRole('button', { name: /paste|submit|confirm/i }));
    await waitFor(() => {
      expect(
        screen.getByText(/does not match the guard/i),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /cancel|close/i }));

    expectNoConsoleLeak();
  });

  it('shows the format hint and which account/guard the key satisfies with truncated public info', () => {
    render(
      <PasteKeyModal
        account={makeAccount()}
        pasteKey={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // Format hint copy (64 = Ed25519/Koala; 128 = extended BIP32).
    expect(screen.getByText(/64-char/i)).toBeInTheDocument();
    expect(screen.getByText(/128-char/i)).toBeInTheDocument();
    // Persistence copy is the wallet's, not the reference's "Never stored".
    expect(screen.getByText(/stored encrypted at rest/i)).toBeInTheDocument();
    expect(screen.queryByText(/never stored/i)).not.toBeInTheDocument();
    // Still-needed public key shown TRUNCATED only.
    expect(
      screen.getByText(new RegExp(NEEDED_PUBKEY.slice(0, 16))),
    ).toBeInTheDocument();
    expect(screen.queryByText(NEEDED_PUBKEY)).not.toBeInTheDocument();
  });
});
