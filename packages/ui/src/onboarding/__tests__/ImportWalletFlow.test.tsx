import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WalletProvider } from '../../context/WalletContext';
import { ImportWalletFlow } from '../ImportWalletFlow';

/**
 * A known-good 24-word koala (BIP39) recovery phrase with a valid checksum,
 * reused from the core keyring vectors. NEVER logged.
 */
const KNOWN_GOOD =
  'flat portion other shield engine fly original desert network riot shop own evidence august belt steel into embody bounce parrot naive cruel word gown';

const WORD_COUNT_MESSAGE = 'A 24-word seed phrase is required.';
const INVALID_WORDS_MESSAGE = 'Invalid seed phrase. Please check your words.';

function renderFlow() {
  const storage = new InMemoryStorageAdapter();
  const keyVault = new InMemoryKeyVault();
  const onImported = vi.fn();
  render(
    <WalletProvider storage={storage} keyVault={keyVault}>
      <ImportWalletFlow onImported={onImported} />
    </WalletProvider>,
  );
  return { storage, keyVault, onImported };
}

function phraseInput(): HTMLTextAreaElement {
  return screen.getByLabelText(/seed phrase/i) as HTMLTextAreaElement;
}

describe('ImportWalletFlow', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders one numbered chip per word when a 24-word phrase is pasted', () => {
    renderFlow();

    fireEvent.change(phraseInput(), { target: { value: KNOWN_GOOD } });

    // Each pasted word becomes a removable, numbered chip; a 24-word paste must
    // surface exactly 24 so the user can audit the parse before importing.
    const chips = screen.getAllByTestId('seed-word-chip');
    expect(chips).toHaveLength(24);
    const words = KNOWN_GOOD.split(' ');
    expect(chips[0]).toHaveTextContent(`1${words[0]}`);
    expect(chips[23]).toHaveTextContent(`24${words[23]}`);
  });

  it('rejects a 12-word phrase with the word-count message and never calls importWallet', async () => {
    const { storage, onImported } = renderFlow();
    const twelve = KNOWN_GOOD.split(' ').slice(0, 12).join(' ');

    fireEvent.change(phraseInput(), { target: { value: twelve } });

    // Submitting the phrase form with the wrong count must surface the DISTINCT
    // word-count message and block any persistence — a 12-word phrase is the
    // unsupported case this flow drops.
    const form = screen.getByTestId('phrase-form');
    await act(async () => {
      fireEvent.submit(form);
    });

    expect(screen.getByRole('alert')).toHaveTextContent(WORD_COUNT_MESSAGE);
    expect(screen.queryByText(INVALID_WORDS_MESSAGE)).toBeNull();
    // No password step appeared and no wallet was written.
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    expect(onImported).not.toHaveBeenCalled();
    expect(await storage.get('stoawallet:vault')).toBeNull();
  });

  it('rejects a 24-word phrase with a bad word using the invalid-words message', async () => {
    const { storage, onImported } = renderFlow();
    // A real-count phrase whose first token is not a BIP39 word → invalid-words,
    // distinct from the wrong-count rejection.
    const badWords = KNOWN_GOOD.split(' ');
    badWords[0] = 'zzzz';
    const badPhrase = badWords.join(' ');

    fireEvent.change(phraseInput(), { target: { value: badPhrase } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('phrase-form'));
    });

    // The phrase has 24 words so it advances to the password step; the import is
    // what rejects it, with the invalid-words message rather than word-count.
    const password = (await screen.findByLabelText(
      /^password$/i,
    )) as HTMLInputElement;
    fireEvent.change(password, { target: { value: 'pw-correct-horse' } });
    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: 'pw-correct-horse' },
    });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('password-form'));
    });

    await waitFor(
      () => {
        expect(screen.getByRole('alert')).toHaveTextContent(
          INVALID_WORDS_MESSAGE,
        );
      },
      { timeout: 15000 },
    );
    expect(screen.queryByText(WORD_COUNT_MESSAGE)).toBeNull();
    expect(onImported).not.toHaveBeenCalled();
    expect(await storage.get('stoawallet:vault')).toBeNull();
  });

  it('imports a valid 24-word phrase: advances to password, calls importWallet, persists', async () => {
    const { storage, onImported } = renderFlow();

    fireEvent.change(phraseInput(), { target: { value: KNOWN_GOOD } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('phrase-form'));
    });

    const password = (await screen.findByLabelText(
      /^password$/i,
    )) as HTMLInputElement;
    fireEvent.change(password, { target: { value: 'pw-correct-horse' } });
    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: 'pw-correct-horse' },
    });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('password-form'));
    });

    // A valid phrase + password seals the vault and fires the completion
    // callback exactly once; the persisted vault proves importWallet ran.
    await waitFor(
      () => {
        expect(onImported).toHaveBeenCalledTimes(1);
      },
      { timeout: 15000 },
    );
    expect(await storage.get('stoawallet:vault')).not.toBeNull();
  });

  it('renders both a password and a confirm-password field on the password step', async () => {
    renderFlow();

    fireEvent.change(phraseInput(), { target: { value: KNOWN_GOOD } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('phrase-form'));
    });

    // The import flow now retypes the password (mirroring create) so a typo in
    // the encryption password cannot silently lock the user out of their wallet.
    expect(await screen.findByLabelText(/^password$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
  });

  it('blocks the import when the two password entries do not match', async () => {
    const { storage, onImported } = renderFlow();

    fireEvent.change(phraseInput(), { target: { value: KNOWN_GOOD } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('phrase-form'));
    });

    fireEvent.change(await screen.findByLabelText(/^password$/i), {
      target: { value: 'pw-correct-horse' },
    });
    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: 'different-password' },
    });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('password-form'));
    });

    // A mismatch is caught locally before any work: the user sees the mismatch
    // message and importWallet is never invoked, so nothing is persisted.
    expect(
      await screen.findByText(/passwords do not match/i),
    ).toBeInTheDocument();
    expect(onImported).not.toHaveBeenCalled();
    expect(await storage.get('stoawallet:vault')).toBeNull();
  });

  it('disables Import wallet until both password entries are non-empty and matching', async () => {
    renderFlow();

    fireEvent.change(phraseInput(), { target: { value: KNOWN_GOOD } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('phrase-form'));
    });

    const submit = await screen.findByRole('button', {
      name: /import wallet/i,
    });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: 'pw-correct-horse' },
    });
    // Confirm still empty → the submit stays blocked rather than sealing under a
    // password the user only typed once.
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: 'pw-correct-horse' },
    });
    expect(submit).toBeEnabled();
  });

  it('disables the phrase Continue control until exactly 24 words are present', () => {
    renderFlow();

    const submit = screen.getByRole('button', { name: /continue/i });
    expect(submit).toBeDisabled();

    fireEvent.change(phraseInput(), {
      target: { value: KNOWN_GOOD.split(' ').slice(0, 23).join(' ') },
    });
    expect(submit).toBeDisabled();

    fireEvent.change(phraseInput(), { target: { value: KNOWN_GOOD } });
    expect(submit).toBeEnabled();
  });
});
