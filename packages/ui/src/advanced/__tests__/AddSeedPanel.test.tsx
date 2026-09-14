import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { WalletProvider, type RemoteVault } from '../../context/WalletContext';
import { AddSeedPanel } from '../AddSeedPanel';

vi.mock('@stoawallet/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stoawallet/core')>();
  const wordsFor = (t: string): number => (t === 'koala' ? 24 : 12);
  return {
    ...actual,
    // Real generation and derivation are covered by core's own tests; the
    // panel's job is the flow, so these stand-ins are deterministic and instant.
    generateMnemonicFor: vi.fn(async (t: string) =>
      Array.from({ length: wordsFor(t) }, (_, i) => `word${i + 1}`).join(' '),
    ),
    previewSeedPublicKey: vi.fn(async (m: string, t: string) =>
      m.trim().split(/\s+/).filter(Boolean).length === wordsFor(t) ? 'f'.repeat(64) : null,
    ),
  };
});

type AddSeedInput = { phrase: string; seedType: string; name: string };
type AddSeedReply = { ok: true; walletId: string } | { ok: false; reason: string };

function makeVault(
  reply: AddSeedReply = { ok: true, walletId: 'wallet-9' },
): { vault: RemoteVault; calls: AddSeedInput[] } {
  const calls: AddSeedInput[] = [];
  const vault = {
    async unlock() { return { ok: true as const }; },
    async lock() {},
    async isUnlocked() { return true; },
    async getActiveAccount() { return null; },
    async listAccounts() { return []; },
    async addAccount() { return { ok: true as const }; },
    async setActiveAccount() { return { ok: true as const }; },
    async signTx() { return { ok: true as const, signed: {} }; },
    async signMessage() { return { ok: true as const, signature: '00', publicKey: '00' }; },
    async urstoaExecute() { return { ok: true as const, requestKey: 'rk' }; },
    async getSession() { return { unlocked: true, expiresAt: 9_999_999_999_999, autoLockMinutes: 5 }; },
    async setAutoLock(m: number) { return m; },
    async listWallets() { return []; },
    async listPureKeypairs() { return []; },
    async setActiveWallet() { return { ok: true as const }; },
    async addAccountAtIndex() { return { ok: true as const }; },
    async removeAccount() { return { ok: true as const }; },
    async renameWallet() { return { ok: true as const }; },
    async importCodex() {
      return { ok: true as const, summary: { seedsImported: 0, accountsImported: 0, keysImported: 0, skipped: 0 } };
    },
    async exportCodex() { return { ok: true as const, json: '{}' }; },
    async removeWallet() { return { ok: true as const }; },
    async removePureKeypair() { return { ok: true as const }; },
    async addSeed(input: AddSeedInput) {
      calls.push(input);
      return reply;
    },
    async addPureKeypair() { return { ok: true as const, id: 'k', publicKey: 'a'.repeat(64) }; },
  } as unknown as RemoteVault;
  return { vault, calls };
}

function renderPanel(vault: RemoteVault) {
  const onDone = vi.fn();
  const onCancel = vi.fn();
  render(
    <WalletProvider
      storage={new InMemoryStorageAdapter()}
      keyVault={new InMemoryKeyVault()}
      remoteVault={vault}
    >
      <AddSeedPanel onDone={onDone} onCancel={onCancel} />
    </WalletProvider>,
  );
  return { onDone, onCancel };
}

const wordCount = (): number =>
  within(screen.getByTestId('add-seed-words')).getAllByRole('listitem').length;

describe('AddSeedPanel', () => {
  it('generates a 24-word Koala phrase by default', async () => {
    renderPanel(makeVault().vault);

    await waitFor(() => expect(wordCount()).toBe(24));
  });

  it('regenerates a 12-word phrase when Chainweaver is chosen', async () => {
    renderPanel(makeVault().vault);
    await waitFor(() => expect(wordCount()).toBe(24));

    await act(async () => {
      fireEvent.click(screen.getByTestId('add-seed-type-chainweaver'));
    });

    await waitFor(() => expect(wordCount()).toBe(12));
  });

  it('in restore mode, states exactly how many words the chosen type needs', async () => {
    renderPanel(makeVault().vault);
    await act(async () => {
      fireEvent.click(screen.getByTestId('add-seed-mode-restore'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('add-seed-type-chainweaver'));
    });

    await act(async () => {
      fireEvent.change(screen.getByTestId('add-seed-phrase'), {
        target: { value: Array.from({ length: 11 }, (_, i) => `w${i}`).join(' ') },
      });
    });

    // Codex's own wording — a user pasting a 24-word phrase into a 12-word type
    // needs to know why it is not accepted, not just see a disabled button.
    expect(screen.getByTestId('add-seed-error')).toHaveTextContent(
      'This seed type needs exactly 12 words (have 11).',
    );
  });

  it('will not add until the phrase previews a Key #0 AND the seed has a name', async () => {
    renderPanel(makeVault().vault);
    await waitFor(() => expect(screen.getByTestId('add-seed-preview')).toHaveTextContent('f'.repeat(16)));

    expect(screen.getByTestId('add-seed-submit')).toBeDisabled();

    await act(async () => {
      fireEvent.change(screen.getByTestId('add-seed-name'), { target: { value: 'Savings' } });
    });
    expect(screen.getByTestId('add-seed-submit')).not.toBeDisabled();
  });

  it('adds the seed with its phrase, type and trimmed name, then reports the new seed', async () => {
    const { vault, calls } = makeVault({ ok: true, walletId: 'wallet-9' });
    const { onDone } = renderPanel(vault);
    await act(async () => {
      fireEvent.click(screen.getByTestId('add-seed-type-eckowallet'));
    });
    await waitFor(() => expect(wordCount()).toBe(12));
    await waitFor(() => expect(screen.getByTestId('add-seed-preview')).toHaveTextContent('f'.repeat(16)));
    await act(async () => {
      fireEvent.change(screen.getByTestId('add-seed-name'), { target: { value: '  Legacy  ' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('add-seed-submit'));
    });

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      phrase: Array.from({ length: 12 }, (_, i) => `word${i + 1}`).join(' '),
      seedType: 'eckowallet',
      name: 'Legacy',
    });
    expect(onDone).toHaveBeenCalledWith('wallet-9');
  });

  it('surfaces a seed that is already in the wallet instead of closing', async () => {
    const { vault } = makeVault({ ok: false, reason: 'duplicate-seed' });
    const { onDone } = renderPanel(vault);
    await waitFor(() => expect(screen.getByTestId('add-seed-preview')).toHaveTextContent('f'.repeat(16)));
    await act(async () => {
      fireEvent.change(screen.getByTestId('add-seed-name'), { target: { value: 'Again' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('add-seed-submit'));
    });

    await waitFor(() =>
      expect(screen.getByTestId('add-seed-error')).toHaveTextContent(/already in this wallet/i),
    );
    expect(onDone).not.toHaveBeenCalled();
  });
});
