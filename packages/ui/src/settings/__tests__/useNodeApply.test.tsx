import { InMemoryStorageAdapter } from '@stoawallet/core/testing';
import type {
  ApplyResult,
  NodePreference,
  NodeStatus,
} from '@stoawallet/core';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsProvider, type SettingsDeps } from '../SettingsContext';
import { NodeSettings } from '../NodeSettings';

const NODE1 = 'https://node1.stoachain.com';
const NODE2 = 'https://node2.stoachain.com';
const CUSTOM = 'https://my-node.example.com';

const STATUS: NodeStatus = {
  primary: NODE1,
  fallback: NODE2,
  active: NODE1,
  isOnPrimary: true,
};

/** A manually-resolvable deferred so a test can hold an apply "in flight". */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function baseDeps(
  apply: SettingsDeps['applyAndPersistNodePreference'],
): SettingsDeps {
  return {
    applyAndPersistNodePreference: apply,
    revertToDefault: vi.fn(async () => ({ ok: true }) as ApplyResult),
    getNodePreference: vi.fn(async () => ({ kind: 'default' }) as NodePreference),
    getCurrentNodeStatus: vi.fn(() => STATUS),
  };
}

function renderWith(deps: SettingsDeps) {
  const utils = render(
    <SettingsProvider storage={new InMemoryStorageAdapter()} deps={deps}>
      <NodeSettings />
    </SettingsProvider>,
  );
  return utils;
}

async function chooseCustom() {
  await waitFor(() => screen.getByRole('radio', { name: /custom/i }));
  act(() => {
    fireEvent.click(screen.getByRole('radio', { name: /custom/i }));
  });
  fireEvent.change(screen.getByLabelText(/node url/i), {
    target: { value: CUSTOM },
  });
}

describe('NodeSettings — validation state machine (RR#6)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the validating pending state and disables Apply while a probe is in flight', async () => {
    const d = deferred<ApplyResult>();
    const apply = vi.fn(() => d.promise);
    renderWith(baseDeps(apply));
    await chooseCustom();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    });

    // While validating: the button reflects the pending check + is disabled.
    const button = screen.getByRole('button', { name: /checking node/i });
    expect(button).toBeDisabled();

    // Resolve the probe → leaves the validating state.
    await act(async () => {
      d.resolve({ ok: true, url: CUSTOM });
    });
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: /checking node/i }),
      ).not.toBeInTheDocument(),
    );
  });

  it('guards against double-apply: a second Apply while one is in flight fires the applier ONCE', async () => {
    const d = deferred<ApplyResult>();
    const apply = vi.fn(() => d.promise);
    renderWith(baseDeps(apply));
    await chooseCustom();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    });
    // A second click while the first is still pending must NOT start a 2nd apply.
    await act(async () => {
      const btn = screen.getByRole('button', { name: /checking node/i });
      fireEvent.click(btn);
    });

    expect(apply).toHaveBeenCalledTimes(1);

    await act(async () => {
      d.resolve({ ok: true, url: CUSTOM });
    });
  });

  it('does NOT setState after unmount when the probe resolves post-unmount (AbortController cancel)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = deferred<ApplyResult>();
    const apply = vi.fn((_pref: NodePreference, _adapter: unknown, opts?: { signal?: AbortSignal }) => {
      // Reject if the caller aborts — mirrors a probe honoring the signal.
      return new Promise<ApplyResult>((resolve, reject) => {
        opts?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
        void d.promise.then(resolve);
      });
    });

    const { unmount } = renderWith(baseDeps(apply));
    await chooseCustom();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    });

    // Unmount mid-probe (the extension popup closes), then resolve late.
    unmount();
    await act(async () => {
      d.resolve({ ok: true, url: CUSTOM });
      await Promise.resolve();
    });

    // React logs a warning to console.error on setState-after-unmount; none here.
    const warned = errSpy.mock.calls
      .flat()
      .map((a: unknown) => (typeof a === 'string' ? a : String(a)))
      .join('\n');
    expect(warned).not.toMatch(/unmounted|update.*not mounted/i);
  });

  it('threads an AbortController signal into the applier', async () => {
    const d = deferred<ApplyResult>();
    const apply: SettingsDeps['applyAndPersistNodePreference'] = vi.fn(
      () => d.promise,
    );
    renderWith(baseDeps(apply));
    await chooseCustom();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    });

    const calls = (apply as ReturnType<typeof vi.fn>).mock.calls;
    const opts = calls.at(-1)?.[2] as { signal?: AbortSignal } | undefined;
    expect(opts?.signal).toBeInstanceOf(AbortSignal);

    await act(async () => {
      d.resolve({ ok: true, url: CUSTOM });
    });
  });
});
