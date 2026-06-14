import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import type { AdvancedAccount } from '@stoawallet/core';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WalletProvider } from '../../context/WalletContext';
import { AddAdvancedAccount } from '../AddAdvancedAccount';
import {
  type ContextAddAdvancedResult,
  type ContextResolveForeignKeyResult,
  type UseAdvancedAccountsOptions,
} from '../useAdvancedAccounts';

/** A 64-char hex key the inline paste modal accepts past its format gate. */
const PASTE_KEY = '4'.repeat(64);

const ADDRESS =
  'k:2222222222222222222222222222222222222222222222222222222222222222';

function makeAccount(
  overrides: Partial<AdvancedAccount> = {},
): AdvancedAccount {
  return {
    id: 'adv-1',
    address: ADDRESS,
    type: 'k-account',
    mode: 'watch-only',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderView(props: {
  hookOptions: UseAdvancedAccountsOptions;
  onPasteKey?: (account: AdvancedAccount) => void;
  onRequireUnlock?: () => void;
}): void {
  const storage = new InMemoryStorageAdapter();
  const keyVault = new InMemoryKeyVault();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <WalletProvider storage={storage} keyVault={keyVault}>
      {children}
    </WalletProvider>
  );
  render(
    <Wrapper>
      <AddAdvancedAccount
        hookOptions={props.hookOptions}
        onPasteKey={props.onPasteKey}
        onRequireUnlock={props.onRequireUnlock}
      />
    </Wrapper>,
  );
}

/** Type the address into the input and click Add. */
function submitAddress(address: string = ADDRESS): void {
  fireEvent.change(screen.getByTestId('advanced-address'), {
    target: { value: address },
  });
  fireEvent.click(screen.getByTestId('advanced-submit'));
}

describe('AddAdvancedAccount', () => {
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

  it('submitting an address calls addAccount with the address + default chain and shows staged progress', async () => {
    const account = makeAccount({ mode: 'send-capable' });
    const added: ContextAddAdvancedResult = {
      ok: true,
      mode: 'send-capable',
      account,
    };
    // Block the op so the in-flight stage is observable before it resolves.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const addOp = vi.fn(async (): Promise<ContextAddAdvancedResult> => {
      await gate;
      return added;
    });
    const listOp = vi.fn(async () => [account]);

    renderView({
      hookOptions: { addAdvancedAccount: addOp, listAdvancedAccounts: listOp },
    });

    submitAddress();

    // The staged-progress affordance shows rather than a frozen/blank state.
    expect(await screen.findByTestId('advanced-adding')).toBeInTheDocument();
    expect(addOp).toHaveBeenCalledWith(ADDRESS, '0');

    release();
    await waitFor(() =>
      expect(screen.getByTestId('advanced-added')).toBeInTheDocument(),
    );
  });

  it('a send-capable outcome renders a signable affordance and badges the list row send-capable', async () => {
    const account = makeAccount({ mode: 'send-capable' });
    const added: ContextAddAdvancedResult = {
      ok: true,
      mode: 'send-capable',
      account,
    };
    const addOp = vi.fn(async () => added);
    const listOp = vi.fn(async () => [account]);

    renderView({
      hookOptions: { addAdvancedAccount: addOp, listAdvancedAccounts: listOp },
    });

    submitAddress();

    // The terminal affordance must clearly state the account is signable.
    const result = await screen.findByTestId('advanced-added');
    expect(result).toHaveTextContent(/signable/i);

    // The list row carries a send-capable badge.
    const row = await screen.findByTestId(`advanced-row-${account.id}`);
    expect(within(row).getByTestId('advanced-badge')).toHaveTextContent(
      /send-capable/i,
    );
    // A send-capable row offers a send action.
    expect(within(row).queryByTestId('advanced-row-send')).toBeInTheDocument();
  });

  it('a watch-only outcome labels watch-only, reports neededMore, exposes the paste entry point, and the row has NO send action', async () => {
    const account = makeAccount({ mode: 'watch-only' });
    const added: ContextAddAdvancedResult = {
      ok: true,
      mode: 'watch-only',
      account,
      neededMore: 2,
      predicateRecognized: true,
    };
    const addOp = vi.fn(async () => added);
    const listOp = vi.fn(async () => [account]);
    const onPasteKey = vi.fn();

    renderView({
      hookOptions: { addAdvancedAccount: addOp, listAdvancedAccounts: listOp },
      onPasteKey,
    });

    submitAddress();

    const result = await screen.findByTestId('advanced-added');
    // Clearly labelled watch-only with the disabled-sending framing.
    expect(result).toHaveTextContent(/watch-only/i);
    expect(result).toHaveTextContent(/balances visible, sending disabled/i);
    // The exact count of additional keys needed to sign is reported.
    expect(result).toHaveTextContent(/2 more key/i);

    // The paste entry point invokes onPasteKey with the watch-only account.
    fireEvent.click(screen.getByTestId('advanced-paste-key'));
    expect(onPasteKey).toHaveBeenCalledWith(account);

    // The watch-only row NEVER renders a send action (gated on mode structurally).
    const row = await screen.findByTestId(`advanced-row-${account.id}`);
    expect(within(row).queryByTestId('advanced-row-send')).toBeNull();
    expect(within(row).getByTestId('advanced-badge')).toHaveTextContent(
      /watch-only/i,
    );
  });

  it('a not-key-guarded warning renders a distinct warning and adds nothing send-capable', async () => {
    const failure: ContextAddAdvancedResult = {
      ok: false,
      reason: 'not-key-guarded',
    };
    const addOp = vi.fn(async () => failure);
    const listOp = vi.fn(async () => []);

    renderView({
      hookOptions: { addAdvancedAccount: addOp, listAdvancedAccounts: listOp },
    });

    submitAddress();

    const warning = await screen.findByTestId('advanced-warning');
    expect(warning).toHaveTextContent(/only key-based guards are supportable/i);
    expect(warning).toHaveTextContent(/cannot be added as signable/i);
    // It is NOT a generic error and NOT a send-capable add.
    expect(screen.queryByTestId('advanced-error')).toBeNull();
    expect(screen.queryByTestId('advanced-added')).toBeNull();
  });

  it('an unrecognized-predicate warning renders its own distinct warning', async () => {
    const account = makeAccount({ mode: 'watch-only' });
    const added: ContextAddAdvancedResult = {
      ok: true,
      mode: 'watch-only',
      account,
      neededMore: 0,
      predicateRecognized: false,
    };
    const addOp = vi.fn(async () => added);
    const listOp = vi.fn(async () => [account]);

    renderView({
      hookOptions: { addAdvancedAccount: addOp, listAdvancedAccounts: listOp },
    });

    submitAddress();

    const warning = await screen.findByTestId('advanced-warning');
    expect(warning).toHaveTextContent(/predicate/i);
    // Distinct from the not-key-guarded copy.
    expect(warning).not.toHaveTextContent(/only key-based guards/i);
    expect(screen.queryByTestId('advanced-added')).toBeNull();
  });

  it('a locked error routes to unlock via onRequireUnlock', async () => {
    const failure: ContextAddAdvancedResult = {
      ok: false,
      reason: 'locked',
    };
    const addOp = vi.fn(async () => failure);
    const listOp = vi.fn(async () => []);
    const onRequireUnlock = vi.fn();

    renderView({
      hookOptions: { addAdvancedAccount: addOp, listAdvancedAccounts: listOp },
      onRequireUnlock,
    });

    submitAddress();

    fireEvent.click(await screen.findByTestId('advanced-unlock'));
    expect(onRequireUnlock).toHaveBeenCalledTimes(1);
  });

  it('paste through the SAME hook instance flips the row to send-capable and shows a Send affordance (PAT-001)', async () => {
    // PAT-001: the inline PasteKeyModal must share the SINGLE useAdvancedAccounts
    // instance so a successful watch-only -> send-capable promotion re-reads the
    // shared list and the rendered row flips. (No external onPasteKey → inline.)
    const watchOnly = makeAccount({ id: 'adv-wo', mode: 'watch-only' });
    // Same logical account, re-read send-capable after the paste (same id).
    const promoted = makeAccount({ id: 'adv-wo', mode: 'send-capable' });

    const added: ContextAddAdvancedResult = {
      ok: true,
      mode: 'watch-only',
      account: watchOnly,
      neededMore: 1,
      predicateRecognized: true,
    };
    const addOp = vi.fn(async () => added);

    // The shared list reads watch-only until a successful paste, then send-capable.
    let promotedNow = false;
    const listOp = vi.fn(async () => [promotedNow ? promoted : watchOnly]);

    const resolveOp = vi.fn(
      async (): Promise<ContextResolveForeignKeyResult> => {
        promotedNow = true; // the paste satisfied the guard → row will flip
        return { ok: true, mode: 'send-capable' };
      },
    );

    // No onPasteKey → the default inline modal flow drives the shared hook.
    renderView({
      hookOptions: {
        addAdvancedAccount: addOp,
        listAdvancedAccounts: listOp,
        resolveForeignKey: resolveOp,
      },
    });

    submitAddress();

    // Row starts watch-only with NO send affordance.
    const rowBefore = await screen.findByTestId(`advanced-row-${watchOnly.id}`);
    expect(within(rowBefore).getByTestId('advanced-badge')).toHaveTextContent(
      /watch-only/i,
    );
    expect(within(rowBefore).queryByTestId('advanced-row-send')).toBeNull();

    // Open the INLINE paste modal (shared hook), enter a key, submit.
    fireEvent.click(screen.getByTestId('advanced-paste-key'));
    const input = await screen.findByLabelText('Private key');
    fireEvent.change(input, { target: { value: PASTE_KEY } });
    fireEvent.click(screen.getByRole('button', { name: /paste key/i }));

    // The resolve op ran with the watch-only account + the entered key.
    await waitFor(() =>
      expect(resolveOp).toHaveBeenCalledWith(watchOnly, PASTE_KEY),
    );

    // The shared list re-read flips the row to send-capable WITH a Send affordance.
    await waitFor(() => {
      const row = screen.getByTestId(`advanced-row-${promoted.id}`);
      expect(within(row).getByTestId('advanced-badge')).toHaveTextContent(
        /send-capable/i,
      );
      expect(within(row).getByTestId('advanced-row-send')).toBeInTheDocument();
    });
  });

  it('emits no console output (no key/address telemetry)', async () => {
    const account = makeAccount({ mode: 'send-capable' });
    const addOp = vi.fn(
      async (): Promise<ContextAddAdvancedResult> => ({
        ok: true,
        mode: 'send-capable',
        account,
      }),
    );
    const listOp = vi.fn(async () => [account]);

    renderView({
      hookOptions: { addAdvancedAccount: addOp, listAdvancedAccounts: listOp },
    });
    submitAddress();
    await screen.findByTestId('advanced-added');

    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
