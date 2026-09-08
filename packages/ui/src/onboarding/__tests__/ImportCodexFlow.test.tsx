import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import { smartEncrypt } from '@stoachain/stoa-core/crypto';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { WalletProvider } from '../../context/WalletContext';
import { ImportCodexFlow } from '../ImportCodexFlow';

// Real PBKDF2/AES round-trips per seed — give the file headroom.
vi.setConfig({ testTimeout: 60_000 });

const CODEX_PW = 'codex-master-password';
const WALLET_PW = 'correct horse battery staple';

/** A codex with `seeds` seeds, sealed at the CODEX password. */
async function codexJson(seeds: number): Promise<string> {
  const kadenaWallets = [];
  for (let i = 0; i < seeds; i += 1) {
    kadenaWallets.push({
      id: `codex-seed-${i}`,
      name: `Codex Seed ${i}`,
      seedType: 'koala',
      secret: await smartEncrypt(`mnemonic number ${i} words here`, CODEX_PW, '2'),
      accounts: [
        {
          index: 0,
          publicKey: String(i).padStart(64, 'a'),
          derivationPath: "m'/44'/626'/0'",
        },
      ],
    });
  }
  return JSON.stringify({ version: '1.2', kadenaWallets, pureKeypairs: [] });
}

function renderFlow(): void {
  render(
    <WalletProvider
      storage={new InMemoryStorageAdapter()}
      keyVault={new InMemoryKeyVault()}
    >
      <ImportCodexFlow />
    </WalletProvider>,
  );
}

/** Drive the flow to the point of submitting, with the given codex + passwords. */
async function submitCodex(json: string, codexPw: string): Promise<void> {
  const file = new File([json], 'codex.json');
  await act(async () => {
    fireEvent.change(screen.getByTestId('onboard-codex-file'), {
      target: { files: [file] },
    });
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText(/codex password/i), {
      target: { value: codexPw },
    });
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId('onboard-codex-continue'));
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: WALLET_PW },
    });
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: WALLET_PW },
    });
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId('onboard-codex-submit'));
  });
}

describe('ImportCodexFlow', () => {
  it('collects the codex file and its password BEFORE asking for a wallet password', async () => {
    renderFlow();

    // A wrong codex password must be discoverable before the user invents a
    // wallet password they would otherwise have to re-enter.
    expect(screen.getByTestId('onboard-codex-file')).toBeInTheDocument();
    expect(screen.queryByLabelText(/confirm password/i)).toBeNull();
  });

  it('shows a DETERMINATE progress bar that reaches 100% of the seed count', async () => {
    renderFlow();
    await submitCodex(await codexJson(3), CODEX_PW);

    await waitFor(() => {
      const bar = screen.getByTestId('codex-import-progress');
      // Determinate, not a spinner: the max is the real item count, so the user
      // can see how much of their codex is left.
      expect(bar).toHaveAttribute('aria-valuemax', '3');
      expect(bar).toHaveAttribute('aria-valuenow', '3');
      // Each seed costs two real KDF rounds, so the import outlives waitFor's
      // 1s default — a short timeout asserts mid-flight and reads as a bug.
    }, { timeout: 30_000 });
  });

  it('surfaces a wrong codex password and drops the bar instead of leaving it stuck', async () => {
    renderFlow();
    await submitCodex(await codexJson(2), 'not-the-codex-password');

    await waitFor(() =>
      expect(screen.getByTestId('onboard-codex-error')).toHaveTextContent(
        /wrong codex password/i,
      ),
    );
    // A bar left frozen mid-import would read as a hang rather than a failure.
    expect(screen.queryByTestId('codex-import-progress')).toBeNull();
    // And the user is returned to the step that owns the failure.
    expect(screen.getByTestId('onboard-codex-file')).toBeInTheDocument();
  });
});
