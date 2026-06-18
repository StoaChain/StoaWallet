import { KeyringManager } from '@stoawallet/core';
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

import { WalletProvider, useWallet } from '../../context/WalletContext';
import { CreateWalletFlow } from '../CreateWalletFlow';

const PASSWORD = 'correct horse battery staple';

/**
 * Render the flow inside a provider, then prime the create flow by calling
 * `startCreate` so the 24-word phrase is generated into context. A tiny seam
 * component captures the live context value for assertions about state the UI
 * drives (the backup flag, the cleared phrase).
 */
function setup() {
  const storage = new InMemoryStorageAdapter();
  const keyVault = new InMemoryKeyVault();
  const ctxRef: { current: ReturnType<typeof useWallet> | null } = {
    current: null,
  };

  function Seam() {
    ctxRef.current = useWallet();
    return null;
  }

  const onComplete = vi.fn();

  const utils = render(
    <WalletProvider storage={storage} keyVault={keyVault}>
      <Seam />
      <CreateWalletFlow onComplete={onComplete} />
    </WalletProvider>,
  );

  return { storage, keyVault, ctxRef, onComplete, ...utils };
}

async function startCreate(ctxRef: {
  current: ReturnType<typeof useWallet> | null;
}) {
  await act(async () => {
    await ctxRef.current!.startCreate();
  });
}

function click(el: HTMLElement) {
  return act(async () => {
    fireEvent.click(el);
  });
}

function typeInto(el: HTMLElement, value: string) {
  return act(async () => {
    fireEvent.change(el, { target: { value } });
  });
}

describe('CreateWalletFlow', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders all 24 generated words in a numbered grid', async () => {
    const { ctxRef } = setup();
    await startCreate(ctxRef);

    const words = ctxRef.current!.words;
    expect(words).toHaveLength(24);

    // Every generated word is shown, each paired with its 1-based position, so
    // the user can transcribe the phrase in order during backup.
    const grid = screen.getByTestId('phrase-grid');
    const cells = within(grid).getAllByTestId('phrase-word');
    expect(cells).toHaveLength(24);

    words.forEach((word, i) => {
      const cell = cells[i]!;
      expect(cell).toHaveTextContent(String(i + 1));
      expect(cell).toHaveTextContent(word);
    });
  });

  it('says "24 words" in the backup copy and never "12 words"', async () => {
    const { ctxRef } = setup();
    await startCreate(ctxRef);

    // The OuronetUI reference hardcodes "12 words"; this flow must instruct the
    // user about the real 24-word phrase length.
    expect(screen.getByText(/24 words/i)).toBeInTheDocument();
    expect(screen.queryByText(/12 words/i)).not.toBeInTheDocument();
  });

  it('copy-to-clipboard writes the full phrase to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText },
    });

    const { ctxRef } = setup();
    await startCreate(ctxRef);
    const phrase = ctxRef.current!.words.join(' ');

    await click(screen.getByRole('button', { name: /copy/i }));

    // The clipboard receives the exact space-joined 24-word phrase — what the
    // user expects to paste into their password manager.
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(phrase));

    vi.unstubAllGlobals();
  });

  it('gates the continue action on the confirm checkbox', async () => {
    const { ctxRef } = setup();
    await startCreate(ctxRef);

    const continueBtn = screen.getByRole('button', { name: /saved my phrase/i });

    // Disabled until the user attests they backed up the phrase — prevents
    // advancing to password before the seed is safe.
    expect(continueBtn).toBeDisabled();
    expect(ctxRef.current!.hasConfirmedBackup).toBe(false);

    await click(screen.getByRole('checkbox'));

    // Checking the box drives the context flag and unlocks progression.
    await waitFor(() =>
      expect(ctxRef.current!.hasConfirmedBackup).toBe(true),
    );
    expect(continueBtn).toBeEnabled();
  });

  it('regenerates a fresh phrase and forces re-confirmation when "Generate new phrase" is clicked', async () => {
    const { ctxRef } = setup();
    await startCreate(ctxRef);

    const firstPhrase = ctxRef.current!.words.join(' ');

    // The user attests they backed up the (about-to-be-replaced) phrase.
    await click(screen.getByRole('checkbox'));
    await waitFor(() => expect(ctxRef.current!.hasConfirmedBackup).toBe(true));

    await click(screen.getByRole('button', { name: /generate new phrase/i }));

    // Re-rolling produces a genuinely different 24-word phrase and resets the
    // backup attestation, so the user cannot advance on a stale confirmation of
    // a phrase that no longer exists.
    await waitFor(() => {
      expect(ctxRef.current!.words).toHaveLength(24);
      expect(ctxRef.current!.words.join(' ')).not.toBe(firstPhrase);
    });
    expect(ctxRef.current!.hasConfirmedBackup).toBe(false);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('on confirm advances to the password step and saveWallet completes the flow', async () => {
    const { ctxRef, onComplete } = setup();
    await startCreate(ctxRef);

    await click(screen.getByRole('checkbox'));
    await click(screen.getByRole('button', { name: /saved my phrase/i }));

    // Password step: matching password + confirmation seals the wallet.
    await typeInto(screen.getByLabelText(/^password$/i), PASSWORD);
    await typeInto(screen.getByLabelText(/confirm password/i), PASSWORD);
    await click(screen.getByRole('button', { name: /create wallet/i }));

    // A real wallet was persisted and the flow signalled completion; the context
    // scrubbed the in-memory phrase on success.
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1), {
      timeout: 15000,
    });
    expect(ctxRef.current!.words).toEqual([]);
    expect(ctxRef.current!.activeAccount?.account).toMatch(
      /^k:[0-9a-f]{64}$/,
    );
  });

  it('blocks submission when the confirmation password does not match', async () => {
    const { ctxRef, onComplete, storage } = setup();
    await startCreate(ctxRef);

    await click(screen.getByRole('checkbox'));
    await click(screen.getByRole('button', { name: /saved my phrase/i }));

    await typeInto(screen.getByLabelText(/^password$/i), PASSWORD);
    await typeInto(
      screen.getByLabelText(/confirm password/i),
      'different-password',
    );
    await click(screen.getByRole('button', { name: /create wallet/i }));

    // Mismatch surfaces an error and never touches persistence or completes.
    expect(
      await screen.findByText(/passwords do not match/i),
    ).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
    expect(await storage.get('stoawallet:vault')).toBeNull();
  });

  it('surfaces the distinct failure reason when saveWallet returns ok:false', async () => {
    // Force a genuine save failure at the keyring boundary so the context
    // returns its discriminated `{ ok: false, reason: 'unknown' }`, proving the
    // UI renders the reason rather than completing.
    vi.spyOn(KeyringManager.prototype, 'importWallet').mockRejectedValue(
      new Error('boom'),
    );

    const { ctxRef, onComplete } = setup();
    await startCreate(ctxRef);

    await click(screen.getByRole('checkbox'));
    await click(screen.getByRole('button', { name: /saved my phrase/i }));
    await typeInto(screen.getByLabelText(/^password$/i), PASSWORD);
    await typeInto(screen.getByLabelText(/confirm password/i), PASSWORD);
    await click(screen.getByRole('button', { name: /create wallet/i }));

    // The save failure is surfaced as a visible alert instead of completing the
    // flow — the user sees that wallet creation failed rather than a silent stall.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/went wrong|failed|error/i);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('never logs the plaintext phrase across the create→save journey', async () => {
    const { ctxRef } = setup();
    await startCreate(ctxRef);
    const phrase = ctxRef.current!.words.join(' ');

    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });

    await click(screen.getByRole('button', { name: /copy/i }));
    await click(screen.getByRole('checkbox'));
    await click(screen.getByRole('button', { name: /saved my phrase/i }));
    await typeInto(screen.getByLabelText(/^password$/i), PASSWORD);
    await typeInto(screen.getByLabelText(/confirm password/i), PASSWORD);
    await click(screen.getByRole('button', { name: /create wallet/i }));

    await waitFor(() => expect(ctxRef.current!.words).toEqual([]), {
      timeout: 15000,
    });

    const allLogged = [errorSpy, logSpy, warnSpy]
      .flatMap((spy) => spy.mock.calls)
      .flat()
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join('\n');

    expect(allLogged).not.toContain(phrase);
  });
});
