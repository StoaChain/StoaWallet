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
} from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WalletProvider,
  useWallet,
  type WalletContextValue,
} from '../../context/WalletContext';
import { AccountSwitcher } from '../AccountSwitcher';

const PASSWORD = 'correct horse battery staple';

/**
 * Render the switcher and a control probe under ONE provider, so the actions the
 * UI dispatches and the setup the test performs hit the SAME (unlocked) keyring
 * manager. `ctl` captures the live context; `accounts` is read lazily each
 * render from a mutable holder so the test can grow the list as it adds
 * accounts.
 */
function renderSwitcher() {
  const ctl: { current: WalletContextValue | null } = { current: null };
  const accountsHolder: { current: StoredAccount[] } = { current: [] };

  function Probe(): null {
    ctl.current = useWallet();
    return null;
  }

  function LiveSwitcher(): ReactNode {
    // Re-read the active account so the list reflects derivations as they happen.
    const { activeAccount } = useWallet();
    const merged = [...accountsHolder.current];
    if (activeAccount && !merged.some((a) => a.index === activeAccount.index)) {
      merged.push(activeAccount);
    }
    return <AccountSwitcher accounts={merged} />;
  }

  render(
    <WalletProvider
      storage={new InMemoryStorageAdapter()}
      keyVault={new InMemoryKeyVault()}
    >
      <Probe />
      <LiveSwitcher />
    </WalletProvider>,
  );

  return { ctl, accountsHolder };
}

async function onboard(ctl: { current: WalletContextValue | null }) {
  await act(async () => {
    await ctl.current!.startCreate();
    await ctl.current!.saveWallet(PASSWORD);
  });
}

/**
 * Render the switcher with NO `accounts` prop so it sources the list straight
 * from the context's `activeWalletAccounts` — the default path the apps use.
 * `storage`/`keyVault` are exposed so a test can pre-seed a LOCKED wallet.
 */
function renderContextSwitcher(
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
      <AccountSwitcher />
    </WalletProvider>,
  );

  return { ctl, storage, keyVault };
}

describe('AccountSwitcher', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists every derived k: account with its index and a truncated address', async () => {
    const { ctl, accountsHolder } = renderSwitcher();
    await onboard(ctl);
    const account0 = ctl.current!.activeAccount as StoredAccount;
    // Pin account 0 BEFORE the add so the next re-render (driven by the new
    // active account) shows both rows.
    accountsHolder.current = [account0];
    await act(async () => {
      await ctl.current!.addAccount();
    });

    await waitFor(() =>
      expect(
        screen.getAllByRole('button', { name: /^account #\d/i }),
      ).toHaveLength(2),
    );

    // Each row exposes the HD index so the user can tell accounts apart, and a
    // truncated k: address — never the full 64-char key crammed into the UI.
    const fullAddress = account0.account;
    expect(screen.queryByText(fullAddress)).not.toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`^k:${fullAddress.slice(2, 6)}.+`)),
    ).toBeInTheDocument();
  });

  it('selecting a different account calls switchAccount and moves the active selection', async () => {
    const { ctl, accountsHolder } = renderSwitcher();
    await onboard(ctl);
    const account0 = ctl.current!.activeAccount as StoredAccount;
    accountsHolder.current = [account0];
    await act(async () => {
      await ctl.current!.addAccount();
    });

    // Account 1 is active after addAccount; clicking the #0 row must move the
    // active selection to HD index 0 via switchAccount(0).
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /account #0/i }),
      ).toHaveAttribute('aria-pressed', 'false'),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /account #0/i }));
    });

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /account #0/i }),
      ).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(ctl.current!.activeAccount?.index).toBe(0);
  });

  it('the add-account action appends a new k: account via addAccount()', async () => {
    const { ctl } = renderSwitcher();
    await onboard(ctl);
    const before = ctl.current!.activeAccount as StoredAccount;
    expect(before.index).toBe(0);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add account/i }));
    });

    // After the add, the active account advances to HD index 1 — the action
    // appends a brand-new derived account, never replaces account 0.
    await waitFor(() => expect(ctl.current!.activeAccount?.index).toBe(1));
    expect(ctl.current!.activeAccount?.account).not.toBe(before.account);
  });

  it('does not log any k: address', async () => {
    const { ctl } = renderSwitcher();
    await onboard(ctl);
    const acct = ctl.current!.activeAccount as StoredAccount;

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /account #0/i }));
    });

    const logged = logSpy.mock.calls
      .flat()
      .map((arg: unknown) =>
        typeof arg === 'string' ? arg : JSON.stringify(arg),
      )
      .join('\n');
    expect(logged).not.toContain(acct.account);
  });

  it('sources the list from context (no accounts prop) and refreshes after addAccount', async () => {
    const { ctl } = renderContextSwitcher();
    await onboard(ctl);

    // One row from the freshly onboarded account 0 — read from the context's
    // activeWalletAccounts, not a threaded prop.
    await waitFor(() =>
      expect(
        screen.getAllByRole('button', { name: /^account #\d/i }),
      ).toHaveLength(1),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add account/i }));
    });

    // The new k: account (HD index 1) appears WITHOUT the caller threading any
    // accounts prop — proving the context list refreshed after addAccount.
    await waitFor(() =>
      expect(
        screen.getAllByRole('button', { name: /^account #\d/i }),
      ).toHaveLength(2),
    );
    expect(
      screen.getByRole('button', { name: /account #1/i }),
    ).toBeInTheDocument();
  });

  it('addAccount on a LOCKED wallet returns {ok:false} and surfaces a message (no unhandled rejection)', async () => {
    // Seed a real wallet, then lock it, all over the SAME storage/keyVault the
    // switcher provider will rediscover on mount.
    const storage = new InMemoryStorageAdapter();
    const keyVault = new InMemoryKeyVault();
    {
      const seed: { current: WalletContextValue | null } = { current: null };
      function SeedProbe(): null {
        seed.current = useWallet();
        return null;
      }
      const { unmount } = render(
        <WalletProvider storage={storage} keyVault={keyVault}>
          <SeedProbe />
        </WalletProvider>,
      );
      await act(async () => {
        await seed.current!.startCreate();
        await seed.current!.saveWallet(PASSWORD);
        await seed.current!.lock();
      });
      unmount();
    }

    const { ctl } = renderContextSwitcher(storage, keyVault);
    // Let the provider rediscover the stored wallet on mount.
    await waitFor(() => expect(ctl.current!.hasExistingWallet).toBe(true));

    // Calling the context action directly proves the rejection is caught and
    // mapped to a discriminated failure — never an unhandled rejection.
    let result: { ok: boolean } | undefined;
    await act(async () => {
      result = await ctl.current!.addAccount();
    });
    expect(result?.ok).toBe(false);

    // Clicking the switcher's own button surfaces the failure message in the UI.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add account/i }));
    });
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/unlock/i),
    );
  });
});
