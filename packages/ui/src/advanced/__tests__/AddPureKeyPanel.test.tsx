import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import { generatePureKeypair } from '@stoawallet/core';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { WalletProvider, type RemoteVault } from '../../context/WalletContext';
import { AddPureKeyPanel } from '../AddPureKeyPanel';

type AddKeyInput = { privateKey: string; publicKey: string; label?: string };

function makeVault(): { vault: RemoteVault; calls: AddKeyInput[] } {
  const calls: AddKeyInput[] = [];
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
    async addSeed() { return { ok: true as const, walletId: 'w' }; },
    async addPureKeypair(input: AddKeyInput) {
      calls.push(input);
      return { ok: true as const, id: 'key-1', publicKey: input.publicKey };
    },
  } as unknown as RemoteVault;
  return { vault, calls };
}

function renderPanel(vault: RemoteVault) {
  const onDone = vi.fn();
  render(
    <WalletProvider
      storage={new InMemoryStorageAdapter()}
      keyVault={new InMemoryKeyVault()}
      remoteVault={vault}
    >
      <AddPureKeyPanel onDone={onDone} />
    </WalletProvider>,
  );
  return { onDone };
}

async function importMode(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('pure-key-mode-import'));
  });
}

async function typeKeys(publicKey: string, privateKey: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByTestId('pure-key-import-public'), { target: { value: publicKey } });
  });
  await act(async () => {
    fireEvent.change(screen.getByTestId('pure-key-import-private'), { target: { value: privateKey } });
  });
}

describe('AddPureKeyPanel — generate', () => {
  it('generates a keypair and shows BOTH halves so the private key can be saved', async () => {
    renderPanel(makeVault().vault);

    await act(async () => {
      fireEvent.click(screen.getByTestId('pure-key-generate'));
    });

    expect(screen.getByTestId('pure-key-generated-public').textContent).toMatch(/^[0-9a-f]{64}$/);
    // Shown in full: a generated key that is never displayed cannot be backed
    // up outside the wallet.
    expect(screen.getByTestId('pure-key-generated-private').textContent).toMatch(/^[0-9a-f]{64}$/);
  });

  it('saves exactly the pair on screen, with its label', async () => {
    const { vault, calls } = makeVault();
    const { onDone } = renderPanel(vault);
    await act(async () => {
      fireEvent.click(screen.getByTestId('pure-key-generate'));
    });
    const shownPublic = screen.getByTestId('pure-key-generated-public').textContent;
    const shownPrivate = screen.getByTestId('pure-key-generated-private').textContent;
    await act(async () => {
      fireEvent.change(screen.getByTestId('pure-key-label'), { target: { value: 'Hot key' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('pure-key-save'));
    });

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ privateKey: shownPrivate, publicKey: shownPublic, label: 'Hot key' });
    expect(onDone).toHaveBeenCalledWith(shownPublic);
  });
});

describe('AddPureKeyPanel — import', () => {
  it('flags a private key that derives a DIFFERENT public key, and blocks adding it', async () => {
    renderPanel(makeVault().vault);
    await importMode();
    const a = generatePureKeypair();
    const b = generatePureKeypair();

    await typeKeys(b.publicKey, a.privateKey);

    expect(screen.getByTestId('pure-key-import-status')).toHaveTextContent(/^Mismatch/);
    expect(screen.getByTestId('pure-key-import-submit')).toBeDisabled();
  });

  it('accepts a matching pair and adds it without a label when none was given', async () => {
    const { vault, calls } = makeVault();
    renderPanel(vault);
    await importMode();
    const kp = generatePureKeypair();

    await typeKeys(kp.publicKey, kp.privateKey);
    expect(screen.getByTestId('pure-key-import-status')).toHaveTextContent(/^Keys match/);

    await act(async () => {
      fireEvent.click(screen.getByTestId('pure-key-import-submit'));
    });

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ privateKey: kp.privateKey, publicKey: kp.publicKey });
  });

  it('explains a malformed private key instead of just refusing it', async () => {
    renderPanel(makeVault().vault);
    await importMode();

    await typeKeys('a'.repeat(64), 'not-hex');

    expect(screen.getByTestId('pure-key-import-status')).toHaveTextContent(
      'Private key must be 64 hex (Ed25519) or 128 (Chainweaver extended key).',
    );
    expect(screen.getByTestId('pure-key-import-submit')).toBeDisabled();
  });
});
