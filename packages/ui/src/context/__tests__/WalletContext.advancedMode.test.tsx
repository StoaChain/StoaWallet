import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import { ADVANCED_MODE_KEY, VAULT_KEY, serializeVault } from '@stoawallet/core';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { type ReactNode } from 'react';

import { WalletProvider, useWallet } from '../WalletContext';

/**
 * Context-level coverage for the Advanced-mode surface. `AdvancedTab.test.tsx`
 * exercises the rendered toggle; these pin the provider contract the tab cannot
 * reach — the no-wallet default and the degrade path — so a regression in the
 * wiring is caught even if the tab's markup changes.
 */

/** Renders the three Advanced-mode context fields as text, plus a setter hook. */
function Probe(): ReactNode {
  const { advancedMode, activeWalletOrigin, setAdvancedMode } = useWallet();
  return (
    <div>
      <span data-testid="advanced">{String(advancedMode)}</span>
      <span data-testid="origin">{activeWalletOrigin}</span>
      <button data-testid="enable" onClick={() => void setAdvancedMode(true)}>
        enable
      </button>
    </div>
  );
}

function renderProbe(storage: InMemoryStorageAdapter): void {
  render(
    <WalletProvider storage={storage} keyVault={new InMemoryKeyVault()}>
      <Probe />
    </WalletProvider>,
  );
}

function storedVault(origin: 'seed' | 'codex'): string {
  return serializeVault({
    activeWalletId: 'wallet-1',
    wallets: [
      {
        id: 'wallet-1',
        name: 'Koala A',
        encryptedPhrase: 'ENC::phrase' as never,
        accounts: [
          {
            index: 0,
            publicKey: 'a'.repeat(64),
            account: `k:${'a'.repeat(64)}`,
            derivationPath: 'p0',
          },
        ],
        activeAccountIndex: 0,
        seedType: 'koala',
        origin,
        createdAt: '2026-06-14T00:00:00.000Z',
      },
    ],
  });
}

describe('WalletContext — advanced mode', () => {
  it('reports origin "seed" when NO wallet is stored, so onboarding never renders a disabled toggle', async () => {
    renderProbe(new InMemoryStorageAdapter());
    await waitFor(() =>
      expect(screen.getByTestId('origin')).toHaveTextContent('seed'),
    );
    expect(screen.getByTestId('advanced')).toHaveTextContent('false');
  });

  it('surfaces the stored wallet origin, which is what forces advanced mode on', async () => {
    const storage = new InMemoryStorageAdapter();
    await storage.set(VAULT_KEY, storedVault('codex'));
    renderProbe(storage);
    await waitFor(() =>
      expect(screen.getByTestId('origin')).toHaveTextContent('codex'),
    );
  });

  it('persists the preference so a fresh provider reads it back', async () => {
    const storage = new InMemoryStorageAdapter();
    renderProbe(storage);
    await waitFor(() =>
      expect(screen.getByTestId('advanced')).toHaveTextContent('false'),
    );
    await act(async () => {
      screen.getByTestId('enable').click();
    });
    await waitFor(() =>
      expect(screen.getByTestId('advanced')).toHaveTextContent('true'),
    );

    cleanup();
    renderProbe(storage);
    await waitFor(() =>
      expect(screen.getByTestId('advanced')).toHaveTextContent('true'),
    );
  });

  it('degrades a corrupt preference blob to OFF instead of failing to mount the wallet', async () => {
    const storage = new InMemoryStorageAdapter();
    await storage.set(ADVANCED_MODE_KEY, 'not json');
    renderProbe(storage);
    // The provider still mounts and reports a usable value — a tampered blob
    // must never wedge the wallet shut.
    await waitFor(() =>
      expect(screen.getByTestId('advanced')).toHaveTextContent('false'),
    );
    expect(screen.getByTestId('origin')).toHaveTextContent('seed');
  });
});
