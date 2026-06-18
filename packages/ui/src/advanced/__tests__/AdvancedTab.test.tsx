import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  WalletProvider,
  type RemoteVault,
  type RemoteWalletSummary,
} from '../../context/WalletContext';
import { AdvancedTab } from '../AdvancedTab';

const SEED_A: RemoteWalletSummary = {
  id: 'wallet-1',
  name: 'Koala A',
  seedType: 'koala',
  isActive: true,
  activeAccountIndex: 0,
  accounts: [
    { index: 0, publicKey: 'a'.repeat(64), account: `k:${'a'.repeat(64)}`, derivationPath: 'p0' },
    { index: 1, publicKey: 'c'.repeat(64), account: `k:${'c'.repeat(64)}`, derivationPath: 'p1' },
  ],
};
const SEED_B: RemoteWalletSummary = {
  id: 'wallet-2',
  name: 'Chainweaver B',
  seedType: 'chainweaver',
  isActive: false,
  activeAccountIndex: 0,
  accounts: [
    { index: 0, publicKey: 'b'.repeat(64), account: `k:${'b'.repeat(64)}`, derivationPath: 'p0' },
  ],
};

/** A RemoteVault stub driving the Advanced tab; records mutating calls. */
function makeVault(over: Partial<RemoteVault> = {}): RemoteVault & {
  importCalls: Array<{ json: string; pw: string }>;
  removeCalls: Array<{ walletId: string; index: number }>;
  renameCalls: Array<{ walletId: string; name: string }>;
} {
  const v = {
    importCalls: [] as Array<{ json: string; pw: string }>,
    removeCalls: [] as Array<{ walletId: string; index: number }>,
    renameCalls: [] as Array<{ walletId: string; name: string }>,
    async unlock() {
      return { ok: true as const };
    },
    async lock() {},
    async isUnlocked() {
      return true;
    },
    async getActiveAccount() {
      return SEED_A.accounts[0];
    },
    async listAccounts() {
      return SEED_A.accounts;
    },
    async addAccount() {
      return { ok: true as const };
    },
    async setActiveAccount() {
      return { ok: true as const };
    },
    async signTx() {
      return { ok: true as const, signed: {} };
    },
    async urstoaExecute() {
      return { ok: true as const, requestKey: 'rk' };
    },
    async getSession() {
      return { unlocked: true, expiresAt: 9_999_999_999_999, autoLockMinutes: 5 };
    },
    async setAutoLock(m: number) {
      return m;
    },
    async listWallets() {
      return [SEED_A, SEED_B];
    },
    async listPureKeypairs() {
      return [
        { id: 'pk-1', label: 'Cold key', publicKey: 'd'.repeat(64), account: `k:${'d'.repeat(64)}` },
      ];
    },
    async setActiveWallet() {
      return { ok: true as const };
    },
    async addAccountAtIndex() {
      return { ok: true as const };
    },
    async removeAccount(walletId: string, index: number) {
      v.removeCalls.push({ walletId, index });
      return { ok: true as const };
    },
    async renameWallet(walletId: string, name: string) {
      v.renameCalls.push({ walletId, name });
      return { ok: true as const };
    },
    async importCodex(json: string, pw: string) {
      v.importCalls.push({ json, pw });
      return {
        ok: true as const,
        summary: { seedsImported: 1, accountsImported: 2, keysImported: 1, skipped: 0 },
      };
    },
    ...over,
  };
  return v;
}

function renderTab(vault: RemoteVault): void {
  const storage = new InMemoryStorageAdapter();
  const keyVault = new InMemoryKeyVault();
  render(
    <WalletProvider storage={storage} keyVault={keyVault} remoteVault={vault}>
      <AdvancedTab />
    </WalletProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('AdvancedTab', () => {
  it('STANDARD view by default: shows only the active seed, not the others', async () => {
    renderTab(makeVault());
    await waitFor(() =>
      expect(screen.getByTestId('seed-wallet-1')).toBeInTheDocument(),
    );
    // The non-active seed is hidden until advanced mode is on.
    expect(screen.queryByTestId('seed-wallet-2')).toBeNull();
    expect(screen.queryByTestId('import-codex-panel')).toBeNull();
  });

  it('offers a remove button for non-#0 accounts but never for account #0', async () => {
    const vault = makeVault();
    renderTab(vault);
    await waitFor(() => screen.getByTestId('seed-wallet-1'));
    // #0 is the seed anchor — it has no remove control.
    expect(screen.queryByTestId('remove-account-wallet-1-0')).toBeNull();
    // #1 can be removed; clicking forwards (walletId, index) to the host.
    const remove = screen.getByTestId('remove-account-wallet-1-1');
    await act(async () => {
      fireEvent.click(remove);
    });
    await waitFor(() => expect(vault.removeCalls).toHaveLength(1));
    expect(vault.removeCalls[0]).toEqual({ walletId: 'wallet-1', index: 1 });
  });

  it('renames a seed: opens the editor, sends the trimmed new name', async () => {
    const vault = makeVault();
    renderTab(vault);
    await waitFor(() => screen.getByTestId('seed-wallet-1'));
    // The name shows; an edit affordance is present.
    expect(screen.getByTestId('seed-name-wallet-1')).toHaveTextContent('Koala A');
    await act(async () => {
      fireEvent.click(screen.getByTestId('rename-wallet-1'));
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('rename-input-wallet-1'), {
        target: { value: '  My Main Seed  ' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('rename-save-wallet-1'));
    });
    await waitFor(() => expect(vault.renameCalls).toHaveLength(1));
    expect(vault.renameCalls[0]).toEqual({ walletId: 'wallet-1', name: 'My Main Seed' });
  });

  it('ADVANCED mode reveals all seeds + the codex import panel', async () => {
    renderTab(makeVault());
    await waitFor(() => screen.getByTestId('seed-wallet-1'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('advanced-mode-toggle'));
    });
    expect(screen.getByTestId('seed-wallet-1')).toBeInTheDocument();
    expect(screen.getByTestId('seed-wallet-2')).toBeInTheDocument();
    // The chainweaver seed shows its type chip + a "Use this seed" switch.
    expect(screen.getByTestId('seed-wallet-2')).toHaveTextContent(/Chainweaver/);
    expect(screen.getByTestId('use-seed-wallet-2')).toBeInTheDocument();
    expect(screen.getByTestId('import-codex-panel')).toBeInTheDocument();
  });

  it('shows imported pure keys in the Pure Keys section (advanced mode only)', async () => {
    renderTab(makeVault());
    await waitFor(() => screen.getByTestId('seed-wallet-1'));
    // Hidden in standard mode.
    expect(screen.queryByTestId('pure-keys-panel')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId('advanced-mode-toggle'));
    });
    expect(screen.getByTestId('pure-keys-panel')).toBeInTheDocument();
    const row = screen.getByTestId(`pure-key-${'d'.repeat(64)}`);
    expect(row).toHaveTextContent('Cold key');
  });

  it('lets the user reveal the codex password to verify what they typed', async () => {
    renderTab(makeVault());
    await waitFor(() => screen.getByTestId('seed-wallet-1'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('advanced-mode-toggle'));
    });
    const field = screen.getByLabelText(/codex password/i) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(field, { target: { value: 'my-secret' } });
    });
    // Masked by default; the reveal toggle flips it to readable text and back.
    expect(field).toHaveAttribute('type', 'password');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /show password/i }));
    });
    expect(field).toHaveAttribute('type', 'text');
    expect(field).toHaveValue('my-secret');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /hide password/i }));
    });
    expect(field).toHaveAttribute('type', 'password');
  });

  it('imports a Codex: reads the file, sends json + password, shows the summary', async () => {
    const vault = makeVault();
    renderTab(vault);
    await waitFor(() => screen.getByTestId('seed-wallet-1'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('advanced-mode-toggle'));
    });

    const file = new File(['{"version":"1.2"}'], 'OuronetCodex.json', {
      type: 'application/json',
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('codex-file'), {
        target: { files: [file] },
      });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/codex password/i), {
        target: { value: 'codex-pw' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('codex-import-submit'));
    });

    await waitFor(() => expect(vault.importCalls).toHaveLength(1));
    expect(vault.importCalls[0]).toEqual({
      json: '{"version":"1.2"}',
      pw: 'codex-pw',
    });
    await waitFor(() =>
      expect(screen.getByTestId('advanced-notice')).toHaveTextContent(
        /Imported 1 seed/i,
      ),
    );
  });

  it('surfaces a wrong-codex-password import error', async () => {
    const vault = makeVault({
      async importCodex() {
        return { ok: false as const, reason: 'wrong-codex-password' };
      },
    });
    renderTab(vault);
    await waitFor(() => screen.getByTestId('seed-wallet-1'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('advanced-mode-toggle'));
    });
    const file = new File(['{}'], 'c.json');
    await act(async () => {
      fireEvent.change(screen.getByTestId('codex-file'), { target: { files: [file] } });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/codex password/i), {
        target: { value: 'bad' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('codex-import-submit'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('import-error')).toHaveTextContent(/Wrong codex password/i),
    );
  });
});
