import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  WalletProvider,
  type RemoteVault,
  type RemoteWalletSummary,
} from '../../context/WalletContext';
import { AdvancedTab } from '../AdvancedTab';

const PURE_PUB = 'd'.repeat(64);

function seed(id: string, name: string, pub: string, isActive: boolean): RemoteWalletSummary {
  return {
    id,
    name,
    seedType: 'koala',
    isActive,
    activeAccountIndex: 0,
    accounts: [{ index: 0, publicKey: pub, account: `k:${pub}`, derivationPath: 'p0' }],
  };
}

const SEED_A = seed('wallet-1', 'Seed A', 'a'.repeat(64), true);
const SEED_B = seed('wallet-2', 'Seed B', 'b'.repeat(64), false);

interface Recorded {
  readonly removedWallets: string[];
  readonly removedKeys: string[];
}

/** A RemoteVault stub that records the two removal calls. */
function makeVault(seeds: readonly RemoteWalletSummary[], rec: Recorded): RemoteVault {
  return {
    async unlock() {
      return { ok: true as const };
    },
    async lock() {},
    async isUnlocked() {
      return true;
    },
    async getActiveAccount() {
      return seeds[0].accounts[0];
    },
    async listAccounts() {
      return seeds[0].accounts;
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
      return seeds;
    },
    async listPureKeypairs() {
      return [{ id: 'pk-1', label: 'Cold key', publicKey: PURE_PUB, account: `k:${PURE_PUB}` }];
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
      return {
        ok: true as const,
        summary: { seedsImported: 0, accountsImported: 0, keysImported: 0, skipped: 0 },
      };
    },
    async exportCodex() {
      return { ok: true as const, json: '{}' };
    },
    async removeWallet(id: string) {
      rec.removedWallets.push(id);
      return { ok: true as const };
    },
    async removePureKeypair(id: string) {
      rec.removedKeys.push(id);
      return { ok: true as const };
    },
  } as unknown as RemoteVault;
}

/** Render the tab and switch to the multi-seed view, where removal lives. */
async function renderAdvanced(
  seeds: readonly RemoteWalletSummary[],
  rec: Recorded = { removedWallets: [], removedKeys: [] },
): Promise<Recorded> {
  render(
    <WalletProvider
      storage={new InMemoryStorageAdapter()}
      keyVault={new InMemoryKeyVault()}
      remoteVault={makeVault(seeds, rec)}
    >
      <AdvancedTab />
    </WalletProvider>,
  );
  await waitFor(() => screen.getByTestId('seed-wallet-1'));
  await act(async () => {
    fireEvent.click(screen.getByTestId('advanced-mode-toggle'));
  });
  return rec;
}

describe('AdvancedTab — removing seeds', () => {
  it('offers Remove on every seed while more than one exists', async () => {
    await renderAdvanced([SEED_A, SEED_B]);

    expect(screen.getByTestId('remove-seed-wallet-1')).toBeInTheDocument();
    expect(screen.getByTestId('remove-seed-wallet-2')).toBeInTheDocument();
  });

  it('hides Remove when only ONE seed remains — the last seed cannot go', async () => {
    await renderAdvanced([SEED_A]);

    // Hidden rather than disabled: there is nothing the user can do to make it
    // available except add another seed, so a dead control is just noise.
    expect(screen.queryByTestId('remove-seed-wallet-1')).toBeNull();
  });

  it('asks for confirmation before destroying a seed', async () => {
    const rec = await renderAdvanced([SEED_A, SEED_B]);

    await act(async () => {
      fireEvent.click(screen.getByTestId('remove-seed-wallet-2'));
    });
    // One stray click must not wipe a seed the user may not have backed up.
    expect(rec.removedWallets).toEqual([]);

    await act(async () => {
      fireEvent.click(screen.getByTestId('remove-seed-confirm-wallet-2'));
    });
    await waitFor(() => expect(rec.removedWallets).toEqual(['wallet-2']));
  });

  it('cancelling the confirmation removes nothing', async () => {
    const rec = await renderAdvanced([SEED_A, SEED_B]);

    await act(async () => {
      fireEvent.click(screen.getByTestId('remove-seed-wallet-2'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('remove-seed-cancel-wallet-2'));
    });

    expect(rec.removedWallets).toEqual([]);
    expect(screen.getByTestId('remove-seed-wallet-2')).toBeInTheDocument();
  });
});

describe('AdvancedTab — removing pure keys', () => {
  it('removes a pure key only after confirmation', async () => {
    const rec = await renderAdvanced([SEED_A, SEED_B]);

    await act(async () => {
      fireEvent.click(screen.getByTestId(`remove-pure-key-${PURE_PUB}`));
    });
    expect(rec.removedKeys).toEqual([]);

    await act(async () => {
      fireEvent.click(screen.getByTestId(`remove-pure-key-confirm-${PURE_PUB}`));
    });
    await waitFor(() => expect(rec.removedKeys).toEqual(['pk-1']));
  });

  it('offers Remove on a pure key even when it is the only one', async () => {
    await renderAdvanced([SEED_A]);

    // Unlike seeds, a wallet with no pure keys is perfectly valid.
    expect(screen.getByTestId(`remove-pure-key-${PURE_PUB}`)).toBeInTheDocument();
  });
});
