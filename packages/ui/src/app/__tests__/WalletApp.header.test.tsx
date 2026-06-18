import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import { render, screen, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WalletProvider } from '../../context/WalletContext';
import { WalletApp } from '../WalletApp';

/**
 * The restructured top bar (MultiversX-style): LEFT carries the selected seed
 * name + the network designator + a color-coded seed-type chip; RIGHT carries a
 * row of icon buttons — side-panel (prop-gated), settings (navigates), expand
 * (prop-gated), and lock. The active account moves INTO the balance card (the
 * StoaTab), so the header no longer renders the account row. Account add/switch
 * stays out (a later Advanced increment).
 */

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

async function renderUnlocked(props?: {
  onExpand?: () => void;
  onOpenSidePanel?: () => void;
}) {
  const storage = new InMemoryStorageAdapter();
  const keyVault = new InMemoryKeyVault();
  await seedWallet(storage, keyVault);

  render(
    <WalletProvider storage={storage} keyVault={keyVault}>
      <WalletApp {...props} />
    </WalletProvider>,
  );

  const input = (await screen.findByLabelText(/password/i, {
    selector: 'input',
  })) as HTMLInputElement;
  await act(async () => {
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
  await screen.findByRole('tab', { name: /^stoa$/i });
}

describe('WalletApp header', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows the StoaWallet title and the Lock control', async () => {
    await renderUnlocked();
    expect(screen.getByText(/stoawallet/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^lock$/i }),
    ).toBeInTheDocument();
  });

  it('no longer mounts the AccountSwitcher add-account control in the header', async () => {
    await renderUnlocked();
    expect(
      screen.queryByRole('button', { name: /add account/i }),
    ).toBeNull();
  });

  it('shows the active seed name in the top bar', async () => {
    await renderUnlocked();
    // The default onboarded seed name is shown on the LEFT of the top bar so the
    // user knows which seed is active (a single, un-renamable seed today).
    const bar = await screen.findByTestId('header-seed');
    expect(bar.textContent).toMatch(/\S/);
  });

  it('shows the network designator sourced from the SDK network id (never a hardcoded literal)', async () => {
    await renderUnlocked();
    const { KADENA_NETWORK } = await import('@stoachain/stoa-core/constants');
    // The network is presented beside the seed; the network id must come from the
    // SDK constant, so the rendered text contains that exact id ("stoa").
    const net = await screen.findByTestId('header-network');
    expect(net.textContent?.toLowerCase()).toContain(
      KADENA_NETWORK.toLowerCase(),
    );
  });

  it('renders a color-coded Koala seed-type chip for the default seed', async () => {
    await renderUnlocked();
    // The default 24-word seed is a koala seed → the pink "Koala" chip per the
    // OuronetUI SEED_TYPE_CONFIG. The chip carries the koala color so it is
    // visually distinct from chainweaver/eckowallet/pure chips.
    const chip = await screen.findByTestId('header-seed-type-chip');
    expect(chip.textContent).toMatch(/koala/i);
    expect(chip).toHaveStyle({ color: '#ec4899' });
  });

  it('renders the four header icon buttons: side-panel (gated), settings, expand (gated), lock', async () => {
    await renderUnlocked({ onExpand: () => {}, onOpenSidePanel: () => {} });
    expect(
      screen.getByRole('button', { name: /side panel/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /settings/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /open in tab/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^lock$/i }),
    ).toBeInTheDocument();
  });

  it('navigates to the Settings destination when the header settings icon is clicked', async () => {
    await renderUnlocked();
    // The settings icon owns nav state in the shell: clicking it switches the
    // active destination to settings, so the real NodeSettings surface renders.
    await act(async () => {
      screen.getByRole('button', { name: /settings/i }).click();
    });
    expect(
      await screen.findByRole('heading', { name: /node/i }),
    ).toBeInTheDocument();
  });

  it('renders the side-panel button only when onOpenSidePanel is provided', async () => {
    await renderUnlocked();
    // Mobile + the tab pass no side-panel callback → the button must not render
    // (mirrors the expand prop-gating, keeping packages/ui chrome-free).
    expect(
      screen.queryByRole('button', { name: /side panel/i }),
    ).toBeNull();
  });

  it('calls onOpenSidePanel when the side-panel button is clicked', async () => {
    const onOpenSidePanel = vi.fn();
    await renderUnlocked({ onOpenSidePanel });
    await act(async () => {
      screen.getByRole('button', { name: /side panel/i }).click();
    });
    expect(onOpenSidePanel).toHaveBeenCalledTimes(1);
  });

  it('renders the Expand control only when onExpand is provided', async () => {
    await renderUnlocked({ onExpand: () => {} });
    expect(
      screen.getByRole('button', { name: /open in tab/i }),
    ).toBeInTheDocument();
  });

  it('does not render the Expand control when onExpand is absent', async () => {
    await renderUnlocked();
    expect(
      screen.queryByRole('button', { name: /open in tab/i }),
    ).toBeNull();
  });
});
