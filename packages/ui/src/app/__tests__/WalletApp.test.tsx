import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import { render, screen, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WalletProvider } from '../../context/WalletContext';
import { WalletApp } from '../WalletApp';

/**
 * The composed root shell BOTH apps mount. It is a pure function of the
 * `useWallet()` context state, so the three top-level branches are driven by
 * seeding the injected storage (no router lib, no navigation mocks):
 *   - no wallet stored        → onboarding (create/import).
 *   - wallet stored, locked   → the UnlockScreen.
 *   - unlocked                → the tabbed HOME (balances default + tab bar).
 *
 * The unlock/balances screens are real Phase-2/3 components — rendering them
 * proves WalletApp composes the shared UI rather than re-implementing it.
 */

const PASSWORD = 'correct horse battery staple';

async function seedWallet(storage: InMemoryStorageAdapter, keyVault: InMemoryKeyVault) {
  // Seal a real wallet so `hasExistingWallet` flips true on mount; lock it so
  // the locked branch renders without holding an unlocked session.
  const { KeyringManager } = await import('@stoawallet/core');
  const manager = new KeyringManager({ storage, keyVault });
  await manager.importWallet(
    'flat portion other shield engine fly original desert network riot shop own evidence august belt steel into embody bounce parrot naive cruel word gown',
    PASSWORD,
  );
  await manager.lock();
}

function renderApp(storage: InMemoryStorageAdapter, keyVault: InMemoryKeyVault) {
  return render(
    <WalletProvider storage={storage} keyVault={keyVault}>
      <WalletApp />
    </WalletProvider>,
  );
}

describe('WalletApp', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders onboarding when no wallet exists', async () => {
    const storage = new InMemoryStorageAdapter();
    const keyVault = new InMemoryKeyVault();

    await act(async () => {
      renderApp(storage, keyVault);
    });

    // With nothing stored, the user must onboard — the create/import mode toggle
    // is shown, NOT the unlock screen (there is nothing to unlock).
    expect(screen.queryByRole('heading', { name: /unlock wallet/i })).toBeNull();
    expect(
      screen.getByRole('tab', { name: /create new wallet/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: /import existing/i }),
    ).toBeInTheDocument();
  });

  it('renders the UnlockScreen when a wallet exists but is locked', async () => {
    const storage = new InMemoryStorageAdapter();
    const keyVault = new InMemoryKeyVault();
    await seedWallet(storage, keyVault);

    await act(async () => {
      renderApp(storage, keyVault);
    });

    // A stored-but-locked wallet routes to unlock — the canonical Phase-2 screen
    // (a real shared component) is what WalletApp composes here.
    expect(
      await screen.findByRole('heading', { name: /unlock wallet/i }),
    ).toBeInTheDocument();
  });

  it('renders the tabbed HOME with the balances tab when unlocked', async () => {
    const storage = new InMemoryStorageAdapter();
    const keyVault = new InMemoryKeyVault();
    await seedWallet(storage, keyVault);

    const { container } = renderApp(storage, keyVault);

    // Unlock through the live context so `activeAccount` becomes non-null and the
    // shell flips to HOME — proving the unlocked branch shows the tab bar (with a
    // Send/Receive/Cross-chain tab) rather than the unlock screen.
    const unlockInput = await screen.findByLabelText(/password/i);
    await act(async () => {
      const input = unlockInput as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(input, PASSWORD);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const unlockButton = screen.getByRole('button', { name: /^unlock$/i });
    await act(async () => {
      unlockButton.click();
    });

    // HOME presents the tab navigation; the Send and Receive tabs are present.
    expect(await screen.findByRole('tab', { name: /send/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /receive/i })).toBeInTheDocument();
    expect(container.querySelector('[role="tablist"]')).not.toBeNull();
  });
});
