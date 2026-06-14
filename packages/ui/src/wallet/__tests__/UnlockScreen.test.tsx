import {
  type BiometricUnlock,
  type BiometricUnlockResult,
} from '@stoawallet/core';
import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WalletProvider, useWallet } from '../../context/WalletContext';
import { UnlockScreen } from '../UnlockScreen';

const PASSWORD = 'correct horse battery staple';
const VAULT_KEY = 'stoawallet:vault';

function makeWrapper() {
  const storage = new InMemoryStorageAdapter();
  const keyVault = new InMemoryKeyVault();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WalletProvider storage={storage} keyVault={keyVault}>
      {children}
    </WalletProvider>
  );
  return { storage, keyVault, wrapper };
}

/**
 * Seed a real onboarded wallet through the provider so there is something to
 * unlock, then lock it. The wallet lives in the shared `storage`, so any later
 * provider over the same `storage`/`keyVault` rediscovers it on mount.
 */
async function seedLockedWallet(
  wrapper: (p: { children: ReactNode }) => ReactNode,
) {
  const { result } = renderHook(() => useWallet(), { wrapper });
  await act(async () => {
    await result.current.startCreate();
    await result.current.saveWallet(PASSWORD);
  });
  await act(async () => {
    await result.current.lock();
  });
}

function typeInto(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('UnlockScreen', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the distinct wrong-password message (NOT the corrupt message) on a bad password', async () => {
    const { storage, keyVault, wrapper } = makeWrapper();
    await seedLockedWallet(wrapper);

    render(
      <WalletProvider storage={storage} keyVault={keyVault}>
        <UnlockScreen />
      </WalletProvider>,
    );

    typeInto(/password/i, 'totally wrong');
    fireEvent.click(screen.getByRole('button', { name: /unlock/i }));

    // A wrong password must read as a password problem the user can fix by
    // retyping — never as "your stored wallet is corrupted".
    await waitFor(
      () => expect(screen.getByText(/wrong password/i)).toBeInTheDocument(),
      { timeout: 15000 },
    );
    expect(screen.queryByText(/corrupted|unreadable/i)).not.toBeInTheDocument();
  });

  it('shows the distinct corrupt message when the stored envelope is unreadable', async () => {
    const { storage, keyVault, wrapper } = makeWrapper();
    await seedLockedWallet(wrapper);

    // Corrupt the persisted envelope so decrypt cannot parse it → a corrupt
    // outcome, distinct from a wrong password.
    const raw = (await storage.get(VAULT_KEY)) as string;
    const vault = JSON.parse(raw);
    vault.wallets[0].encryptedPhrase = 'not-a-real-envelope';
    await storage.set(VAULT_KEY, JSON.stringify(vault));

    render(
      <WalletProvider storage={storage} keyVault={keyVault}>
        <UnlockScreen />
      </WalletProvider>,
    );

    typeInto(/password/i, PASSWORD);
    fireEvent.click(screen.getByRole('button', { name: /unlock/i }));

    // A corrupt envelope is a storage-integrity failure, not a typo — the user
    // must see a different message so they don't keep retyping the password.
    await waitFor(
      () => expect(screen.getByText(/corrupted|unreadable/i)).toBeInTheDocument(),
      { timeout: 15000 },
    );
    expect(screen.queryByText(/wrong password/i)).not.toBeInTheDocument();
  });

  it('hides the biometric affordance when isAvailable() resolves false', async () => {
    const { storage, keyVault, wrapper } = makeWrapper();
    await seedLockedWallet(wrapper);

    const biometric: BiometricUnlock = {
      isAvailable: () => Promise.resolve(false),
      unlock: () =>
        Promise.resolve({ ok: false, reason: 'biometric-unavailable' }),
    };

    render(
      <WalletProvider storage={storage} keyVault={keyVault}>
        <UnlockScreen biometric={biometric} />
      </WalletProvider>,
    );

    // The password field is always present; the biometric button must NOT be,
    // because the platform reported no biometric capability.
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /unlock/i })).toBeEnabled(),
    );
    expect(
      screen.queryByRole('button', { name: /biometric|fingerprint/i }),
    ).not.toBeInTheDocument();
  });

  it('shows the biometric affordance when isAvailable() resolves true and runs the unlock path on tap', async () => {
    const { storage, keyVault, wrapper } = makeWrapper();
    await seedLockedWallet(wrapper);

    const unlockSecret = vi.fn(
      (): Promise<BiometricUnlockResult> =>
        Promise.resolve({ ok: true, secret: PASSWORD }),
    );
    const biometric: BiometricUnlock = {
      isAvailable: () => Promise.resolve(true),
      unlock: unlockSecret,
    };

    render(
      <WalletProvider storage={storage} keyVault={keyVault}>
        <UnlockScreen biometric={biometric} />
      </WalletProvider>,
    );

    // The button appears only after the async capability probe resolves true.
    const bioButton = await screen.findByRole('button', {
      name: /biometric|fingerprint/i,
    });
    fireEvent.click(bioButton);

    // Tapping it must invoke the platform authenticator's unlock (the same-unlock
    // path), not silently no-op.
    await waitFor(() => expect(unlockSecret).toHaveBeenCalledTimes(1));
  });

  it('never echoes the typed password into console output', async () => {
    const { storage, keyVault, wrapper } = makeWrapper();
    await seedLockedWallet(wrapper);
    const secret = 'super-secret-passphrase-123';

    render(
      <WalletProvider storage={storage} keyVault={keyVault}>
        <UnlockScreen />
      </WalletProvider>,
    );

    typeInto(/password/i, secret);
    fireEvent.click(screen.getByRole('button', { name: /unlock/i }));
    await waitFor(
      () => expect(screen.getByText(/wrong password/i)).toBeInTheDocument(),
      { timeout: 15000 },
    );

    const logged = [errorSpy, logSpy, warnSpy]
      .flatMap((spy) => spy.mock.calls)
      .flat()
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join('\n');
    expect(logged).not.toContain(secret);
  });
});
