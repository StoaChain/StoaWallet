import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WalletProvider, type RemoteVault } from '../../context/WalletContext';
import { ExportWalletPanel } from '../ExportWalletPanel';

const EXPORT_PW = 'a file password';

/** A RemoteVault stub whose exportCodex is controllable per test. */
function makeVault(
  exportImpl: RemoteVault['exportCodex'],
): RemoteVault & { exportCalls: string[] } {
  const v = {
    exportCalls: [] as string[],
    async unlock() {
      return { ok: true as const };
    },
    async lock() {},
    async isUnlocked() {
      return true;
    },
    async getActiveAccount() {
      return null;
    },
    async listAccounts() {
      return [];
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
    async signMessage() {
      return { ok: true as const, signature: '00', publicKey: '00' };
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
      return [];
    },
    async listPureKeypairs() {
      return [];
    },
    async setActiveWallet() {
      return { ok: true as const };
    },
    async addAccountAtIndex() {
      return { ok: true as const };
    },
    async removeAccount() {
      return { ok: true as const };
    },
    async renameWallet() {
      return { ok: true as const };
    },
    async importCodex() {
      return { ok: true as const, summary: { seedsImported: 0, accountsImported: 0, keysImported: 0, skipped: 0 } };
    },
    exportCodex: (async (pw: string, onProgress?: (d: number, t: number) => void) => {
      v.exportCalls.push(pw);
      return exportImpl(pw, onProgress);
    }) as RemoteVault['exportCodex'],
  };
  return v as RemoteVault & { exportCalls: string[] };
}

function renderPanel(vault: RemoteVault): void {
  render(
    <WalletProvider
      storage={new InMemoryStorageAdapter()}
      keyVault={new InMemoryKeyVault()}
      remoteVault={vault}
    >
      <ExportWalletPanel />
    </WalletProvider>,
  );
}

async function fillPasswords(a: string, b: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByLabelText(/^export password$/i), {
      target: { value: a },
    });
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText(/confirm export password/i), {
      target: { value: b },
    });
  });
}

afterEach(() => vi.restoreAllMocks());

describe('ExportWalletPanel', () => {
  it('refuses to export until both export passwords match', async () => {
    renderPanel(makeVault(async () => ({ ok: true, json: '{}' })));

    // Empty: nothing to seal the file with.
    expect(screen.getByTestId('export-submit')).toBeDisabled();

    await fillPasswords(EXPORT_PW, 'something else');
    // A typo here produces a backup the user cannot open — worse than none.
    expect(screen.getByTestId('export-submit')).toBeDisabled();

    await fillPasswords(EXPORT_PW, EXPORT_PW);
    expect(screen.getByTestId('export-submit')).not.toBeDisabled();
  });

  it('names the file the Ouronet way and forwards the EXPORT password', async () => {
    const clicked: string[] = [];
    // jsdom has no download plumbing; capture the synthetic anchor click.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.download);
    });
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:x');
    globalThis.URL.revokeObjectURL = vi.fn();

    const vault = makeVault(async () => ({ ok: true, json: '{"version":"1.2"}' }));
    renderPanel(vault);
    await fillPasswords(EXPORT_PW, EXPORT_PW);
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-submit'));
    });

    await waitFor(() => expect(clicked).toHaveLength(1));
    // Mirrors Ouronet's OuronetCodex_<ISO>.json convention, with ':' and '.'
    // replaced by '-' so the name is filesystem-safe on every OS.
    expect(clicked[0]).toMatch(
      /^StoaWallet_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/,
    );
    // The FILE password must reach the vault, not the wallet password.
    expect(vault.exportCalls).toEqual([EXPORT_PW]);
  });

  it('surfaces a locked wallet and produces NO download', async () => {
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.download);
    });

    renderPanel(makeVault(async () => ({ ok: false, reason: 'locked' })));
    await fillPasswords(EXPORT_PW, EXPORT_PW);
    await act(async () => {
      fireEvent.click(screen.getByTestId('export-submit'));
    });

    await waitFor(() =>
      expect(screen.getByTestId('export-error')).toHaveTextContent(/unlock/i),
    );
    // A failed export must not leave a truncated or empty file on disk.
    expect(clicked).toHaveLength(0);
  });
});
