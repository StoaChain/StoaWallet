import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WalletProvider } from '../../context/WalletContext';
import { WalletApp } from '../WalletApp';

/**
 * The UrStoa tab end-to-end wiring (G-001): the card's four action buttons must
 * actually OPEN their modals. The card + modals are built and unit-tested in
 * isolation; this proves WalletApp's Home composes them so REQ-20/21/22 are
 * functional end-to-end (the card buttons are NOT dead no-ops).
 *
 * The UrStoa hooks are stubbed at module level so the tab renders fully
 * off-network: the holdings hook returns populated figures (the card reaches its
 * action row) and each flow hook sits idle (each modal renders its initial UI).
 */

vi.mock('../../urstoa/useUrStoaHoldings', () => ({
  useUrStoaHoldings: () => ({
    walletBalance: '100',
    vaultBalance: '40',
    vaultEarnings: '5',
    vaultTotal: '50',
    isLoading: false,
    isRefreshing: false,
    isUnknown: false,
    error: null,
    isIdle: false,
    refresh: () => Promise.resolve(),
  }),
}));

vi.mock('../../urstoa/useStakeUnstakeUrStoa', () => ({
  useStakeUnstakeUrStoa: () => ({
    state: { status: 'idle' },
    stake: () => Promise.resolve(),
    unstake: () => Promise.resolve(),
    reset: () => undefined,
  }),
}));

vi.mock('../../urstoa/useCollectUrStoa', () => ({
  useCollectUrStoa: () => ({
    state: { status: 'idle' },
    canCollect: true,
    collect: () => Promise.resolve(),
  }),
}));

vi.mock('../../urstoa/useTransferUrStoa', () => ({
  useTransferUrStoa: () => ({
    state: { status: 'idle' },
    preview: null,
    send: () => Promise.resolve(),
    confirm: () => Promise.resolve(),
    reset: () => undefined,
  }),
}));

const PASSWORD = 'correct horse battery staple';
const MNEMONIC =
  'flat portion other shield engine fly original desert network riot shop own evidence august belt steel into embody bounce parrot naive cruel word gown';

async function seedWallet(
  storage: InMemoryStorageAdapter,
  keyVault: InMemoryKeyVault,
) {
  const { KeyringManager } = await import('@stoawallet/core');
  const manager = new KeyringManager({ storage, keyVault });
  await manager.importWallet(MNEMONIC, PASSWORD);
  await manager.lock();
}

async function renderUnlockedOnUrStoa() {
  const storage = new InMemoryStorageAdapter();
  const keyVault = new InMemoryKeyVault();
  await seedWallet(storage, keyVault);

  render(
    <WalletProvider storage={storage} keyVault={keyVault}>
      <WalletApp />
    </WalletProvider>,
  );

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
  await act(async () => {
    screen.getByRole('button', { name: /^unlock$/i }).click();
  });

  // Navigate to the UrStoa tab so the card (and its action buttons) render.
  const urstoaTab = await screen.findByRole('tab', { name: /urstoa/i });
  await act(async () => {
    urstoaTab.click();
  });
}

describe('WalletApp — UrStoa modal wiring (G-001)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('clicking Stake opens the stake/unstake modal', async () => {
    await renderUnlockedOnUrStoa();
    expect(screen.queryByTestId('stake-modal')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^stake$/i }));
    });

    expect(screen.getByTestId('stake-modal')).toBeInTheDocument();
  });

  it('clicking Unstake opens the modal on the unstake side', async () => {
    await renderUnlockedOnUrStoa();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^unstake$/i }));
    });

    // The modal opened with the unstake side pre-selected (initialKind).
    expect(screen.getByTestId('stake-modal')).toBeInTheDocument();
    expect(screen.getByTestId('stake-mode-unstake')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('clicking Collect opens the collect UI', async () => {
    await renderUnlockedOnUrStoa();
    expect(screen.queryByTestId('collect-urstoa')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^collect$/i }));
    });

    expect(screen.getByTestId('collect-urstoa')).toBeInTheDocument();
  });

  it('clicking Transfer opens the transfer modal', async () => {
    await renderUnlockedOnUrStoa();
    expect(screen.queryByTestId('urstoa-transfer-modal')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^transfer$/i }));
    });

    expect(screen.getByTestId('urstoa-transfer-modal')).toBeInTheDocument();
  });
});
