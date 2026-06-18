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

function renderApp(
  storage: InMemoryStorageAdapter,
  keyVault: InMemoryKeyVault,
  props?: { onExpand?: () => void; routeOnboardingToExpand?: boolean },
) {
  return render(
    <WalletProvider storage={storage} keyVault={keyVault}>
      <WalletApp {...props} />
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

  it('renders the HOME shell with the floating bottom nav (default Stoa) when unlocked', async () => {
    const storage = new InMemoryStorageAdapter();
    const keyVault = new InMemoryKeyVault();
    await seedWallet(storage, keyVault);

    const { container } = renderApp(storage, keyVault);

    // Unlock through the live context so `activeAccount` becomes non-null and the
    // shell flips to HOME — proving the unlocked branch shows the bottom-nav shell
    // (the Stoa tab default) rather than the unlock screen.
    const unlockInput = await screen.findByLabelText(/password/i, {
      selector: 'input',
    });
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

    // HOME presents the floating bottom nav with the Stoa + UrStoa destinations,
    // and the Stoa tab is the default body.
    expect(
      await screen.findByRole('tab', { name: /^stoa$/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /urstoa/i })).toBeInTheDocument();
    expect(screen.getByTestId('stoa-tab')).toBeInTheDocument();
    expect(container.querySelector('[role="tablist"]')).not.toBeNull();
  });
});

/**
 * The extension-popup expand seam. The MV3 action popup closes on focus-loss, so
 * showing a 24-word phrase there is dangerous. The popup passes an `onExpand`
 * callback (its `chrome.tabs.create`) + `routeOnboardingToExpand`; the shell then
 * routes the seed-showing Create/Import flows into a full browser tab instead of
 * running them inline. Mobile and the tab itself pass NEITHER prop, so the inline
 * flows run unchanged — the shell stays `chrome.*`-free.
 */
describe('WalletApp expand seam', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders the expand control only when onExpand is provided', async () => {
    const withProp = new InMemoryStorageAdapter();
    await act(async () => {
      renderApp(withProp, new InMemoryKeyVault(), { onExpand: () => {} });
    });
    // The popup passed onExpand → the open-in-tab affordance is offered, so the
    // user can escape the closeable popup before any seed is shown.
    expect(
      screen.getByRole('button', { name: /open in tab/i }),
    ).toBeInTheDocument();
  });

  it('does NOT render the expand control when onExpand is absent (mobile/tab)', async () => {
    const noProp = new InMemoryStorageAdapter();
    await act(async () => {
      renderApp(noProp, new InMemoryKeyVault());
    });
    // Mobile and the tab itself pass no callback — there is nothing to expand into,
    // and the shared shell must stay free of any extension-only affordance.
    expect(
      screen.queryByRole('button', { name: /open in tab/i }),
    ).toBeNull();
  });

  it('routes Create onboarding to onExpand instead of the inline seed flow when routing is on', async () => {
    const storage = new InMemoryStorageAdapter();
    const onExpand = vi.fn();

    await act(async () => {
      renderApp(storage, new InMemoryKeyVault(), {
        onExpand,
        routeOnboardingToExpand: true,
      });
    });

    const createButton = screen.getByRole('tab', { name: /create new wallet/i });
    await act(async () => {
      createButton.click();
    });

    // Picking Create opens the tab (the safe full-page surface) — the 24-word
    // backup grid must NOT render inside the closeable popup.
    expect(onExpand).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('heading', { name: /back up your recovery phrase/i }),
    ).toBeNull();
  });

  it('routes Import onboarding to onExpand instead of the inline phrase entry when routing is on', async () => {
    const storage = new InMemoryStorageAdapter();
    const onExpand = vi.fn();

    await act(async () => {
      renderApp(storage, new InMemoryKeyVault(), {
        onExpand,
        routeOnboardingToExpand: true,
      });
    });

    const importButton = screen.getByRole('tab', { name: /import existing/i });
    await act(async () => {
      importButton.click();
    });

    // Import also handles the 24-word phrase, so it routes to the tab too — the
    // inline "Import a wallet" phrase-entry must NOT render in the popup.
    expect(onExpand).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('heading', { name: /import a wallet/i }),
    ).toBeNull();
  });

  it('runs Create onboarding inline (no routing) when routeOnboardingToExpand is absent', async () => {
    const storage = new InMemoryStorageAdapter();

    await act(async () => {
      renderApp(storage, new InMemoryKeyVault());
    });

    // Mobile + the tab: no routing prop → onboarding runs inline. The freshly
    // generated 24-word backup grid renders on the same full-page surface, which
    // is the safe place to show it.
    expect(
      await screen.findByRole('heading', { name: /back up your recovery phrase/i }),
    ).toBeInTheDocument();
  });
});
