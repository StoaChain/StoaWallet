import { InMemoryStorageAdapter } from '@stoawallet/core/testing';
import type {
  ApplyResult,
  NodePreference,
  NodeStatus,
} from '@stoawallet/core';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsProvider, type SettingsDeps } from '../SettingsContext';
import { NodeSettings } from '../NodeSettings';

const NODE1 = 'https://node1.stoachain.com';
const NODE2 = 'https://node2.stoachain.com';
const CUSTOM = 'https://my-node.example.com';

/**
 * Build a controllable deps double: a stub applier whose result the test sets,
 * a revert stub, a preference reader, and a status reader that flips to whatever
 * the last successful apply selected — so the "active node display follows a
 * successful apply / is retained on failure" assertions exercise real wiring.
 */
function makeDeps(
  overrides: Partial<SettingsDeps> = {},
): {
  deps: SettingsDeps;
  setNextApply: (r: ApplyResult) => void;
  applyCalls: NodePreference[];
  revertCalls: number;
  status: { current: NodeStatus };
} {
  let nextApply: ApplyResult = { ok: true, url: CUSTOM };
  const applyCalls: NodePreference[] = [];
  const counters = { revertCalls: 0 };
  const status: { current: NodeStatus } = {
    current: { primary: NODE1, fallback: NODE2, active: NODE1, isOnPrimary: true },
  };

  const deps: SettingsDeps = {
    applyAndPersistNodePreference: vi.fn(async (pref: NodePreference) => {
      applyCalls.push(pref);
      if (nextApply.ok) {
        // Mirror the SDK: a successful apply moves the active host to the
        // selected node so the display reflects what took effect.
        if (pref.kind === 'custom') {
          status.current = {
            primary: pref.customUrl,
            fallback: NODE2,
            active: pref.customUrl,
            isOnPrimary: true,
          };
        } else if (pref.kind === 'node2') {
          status.current = {
            primary: NODE2,
            fallback: NODE1,
            active: NODE2,
            isOnPrimary: true,
          };
        } else {
          status.current = {
            primary: NODE1,
            fallback: NODE2,
            active: NODE1,
            isOnPrimary: true,
          };
        }
      }
      return nextApply;
    }),
    revertToDefault: vi.fn(async () => {
      counters.revertCalls += 1;
      status.current = {
        primary: NODE1,
        fallback: NODE2,
        active: NODE1,
        isOnPrimary: true,
      };
      return { ok: true } as ApplyResult;
    }),
    getNodePreference: vi.fn(async () => ({ kind: 'default' }) as NodePreference),
    getCurrentNodeStatus: vi.fn(() => status.current),
    ...overrides,
  };

  return {
    deps,
    setNextApply: (r: ApplyResult) => {
      nextApply = r;
    },
    applyCalls,
    get revertCalls() {
      return counters.revertCalls;
    },
    status,
  };
}

function renderNodeSettings(deps: SettingsDeps) {
  const storage = new InMemoryStorageAdapter();
  render(
    <SettingsProvider storage={storage} deps={deps}>
      <NodeSettings />
    </SettingsProvider>,
  );
  return { storage };
}

/** Select a node option by its radio label. */
function selectOption(name: RegExp) {
  fireEvent.click(screen.getByRole('radio', { name }));
}

describe('NodeSettings', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offers EXACTLY three node options and reveals the URL input ONLY for Custom', async () => {
    const { deps } = makeDeps();
    renderNodeSettings(deps);

    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /default/i })).toBeInTheDocument(),
    );

    // Exactly three selectable node options — never a fourth/empty option.
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('radio', { name: /default/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /node2/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /custom/i })).toBeInTheDocument();

    // The URL input is hidden until Custom is chosen — Default/Node2 take no URL.
    expect(screen.queryByLabelText(/node url/i)).not.toBeInTheDocument();

    act(() => selectOption(/custom/i));
    expect(screen.getByLabelText(/node url/i)).toBeInTheDocument();
  });

  it('selecting Custom reveals the trust warning (sees queries, false data, no failover, cannot steal)', async () => {
    const { deps } = makeDeps();
    renderNodeSettings(deps);
    await waitFor(() => screen.getByRole('radio', { name: /default/i }));

    expect(screen.queryByTestId('node-trust-warning')).not.toBeInTheDocument();

    act(() => selectOption(/custom/i));

    const warning = screen.getByTestId('node-trust-warning');
    // Substance MANDATED by spec: visibility of queries, false data, no steal.
    expect(warning).toHaveTextContent(/see/i);
    expect(warning).toHaveTextContent(/false|wrong balances|withhold|delay/i);
    expect(warning).toHaveTextContent(/cannot steal|can't steal|locally|approve/i);
    // RR#4/RR#5: a custom node has NO node1/node2 failover.
    expect(warning).toHaveTextContent(/failover|fall back|falls back/i);
  });

  it('does NOT show the trust warning for Default or Node2', async () => {
    const { deps } = makeDeps();
    renderNodeSettings(deps);
    await waitFor(() => screen.getByRole('radio', { name: /default/i }));

    expect(screen.queryByTestId('node-trust-warning')).not.toBeInTheDocument();
    act(() => selectOption(/node2/i));
    expect(screen.queryByTestId('node-trust-warning')).not.toBeInTheDocument();
    act(() => selectOption(/default/i));
    expect(screen.queryByTestId('node-trust-warning')).not.toBeInTheDocument();
  });

  it('applying a node calls the injected applier with the selected preference', async () => {
    const ctl = makeDeps();
    renderNodeSettings(ctl.deps);
    await waitFor(() => screen.getByRole('radio', { name: /node2/i }));

    act(() => selectOption(/node2/i));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    });

    await waitFor(() =>
      expect(ctl.deps.applyAndPersistNodePreference).toHaveBeenCalled(),
    );
    const lastCall = (ctl.deps.applyAndPersistNodePreference as ReturnType<typeof vi.fn>)
      .mock.calls.at(-1);
    expect(lastCall?.[0]).toEqual({ kind: 'node2' });
  });

  it('displays the current active node and updates it after a successful custom apply', async () => {
    const ctl = makeDeps();
    renderNodeSettings(ctl.deps);

    // Initially shows the default active host.
    await waitFor(() =>
      expect(screen.getByTestId('active-node')).toHaveTextContent(NODE1),
    );

    ctl.setNextApply({ ok: true, url: CUSTOM });
    act(() => selectOption(/custom/i));
    fireEvent.change(screen.getByLabelText(/node url/i), {
      target: { value: CUSTOM },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    });

    // The display follows the applied node — the user sees what they connected to.
    await waitFor(() =>
      expect(screen.getByTestId('active-node')).toHaveTextContent(CUSTOM),
    );
  });

  it('surfaces a DISTINCT wrong-network message and RETAINS the prior active node on a rejected apply', async () => {
    const ctl = makeDeps();
    renderNodeSettings(ctl.deps);
    await waitFor(() =>
      expect(screen.getByTestId('active-node')).toHaveTextContent(NODE1),
    );

    ctl.setNextApply({ ok: false, reason: 'wrong-network' });
    act(() => selectOption(/custom/i));
    fireEvent.change(screen.getByLabelText(/node url/i), {
      target: { value: CUSTOM },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    });

    await waitFor(() =>
      expect(screen.getByTestId('node-feedback')).toHaveTextContent(
        /not a stoachain.*node|stoa.*node/i,
      ),
    );
    // The active-node display is UNCHANGED — the broken URL never becomes active.
    expect(screen.getByTestId('active-node')).toHaveTextContent(NODE1);
    expect(screen.getByTestId('active-node')).not.toHaveTextContent(CUSTOM);
  });

  it('maps each discriminated reason to its OWN distinct message', async () => {
    const cases: Array<{ reason: ApplyResult; match: RegExp }> = [
      { reason: { ok: false, reason: 'malformed-url' }, match: /valid url/i },
      { reason: { ok: false, reason: 'insecure-scheme' }, match: /https/i },
      { reason: { ok: false, reason: 'unreachable' }, match: /could not reach|reach that node/i },
      { reason: { ok: false, reason: 'wrong-network' }, match: /stoa/i },
    ];

    for (const c of cases) {
      const ctl = makeDeps();
      const { storage } = renderNodeSettings(ctl.deps);
      await waitFor(() => screen.getByRole('radio', { name: /custom/i }));

      ctl.setNextApply(c.reason);
      act(() => selectOption(/custom/i));
      fireEvent.change(screen.getByLabelText(/node url/i), {
        target: { value: CUSTOM },
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /apply/i }));
      });

      await waitFor(() =>
        expect(screen.getByTestId('node-feedback')).toHaveTextContent(c.match),
      );

      // Isolate each case in its own render tree.
      void storage;
      screen.getByTestId('node-feedback').remove();
      document.body.innerHTML = '';
    }
  });

  it('"Revert to default" calls revertToDefault and restores the default active node', async () => {
    const ctl = makeDeps();
    // Start as if a custom node is active.
    ctl.status.current = {
      primary: CUSTOM,
      fallback: NODE2,
      active: CUSTOM,
      isOnPrimary: true,
    };
    renderNodeSettings(ctl.deps);
    await waitFor(() =>
      expect(screen.getByTestId('active-node')).toHaveTextContent(CUSTOM),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /revert to default/i }));
    });

    expect(ctl.deps.revertToDefault).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByTestId('active-node')).toHaveTextContent(NODE1),
    );
  });

  it('NEVER logs the custom URL across an apply cycle', async () => {
    const logSpy = vi.spyOn(console, 'log');
    const errSpy = vi.spyOn(console, 'error');
    const warnSpy = vi.spyOn(console, 'warn');

    const ctl = makeDeps();
    renderNodeSettings(ctl.deps);
    await waitFor(() => screen.getByRole('radio', { name: /custom/i }));

    ctl.setNextApply({ ok: false, reason: 'unreachable' });
    act(() => selectOption(/custom/i));
    fireEvent.change(screen.getByLabelText(/node url/i), {
      target: { value: CUSTOM },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    });

    const logged = [
      ...logSpy.mock.calls,
      ...errSpy.mock.calls,
      ...warnSpy.mock.calls,
    ]
      .flat()
      .map((a: unknown) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join('\n');
    expect(logged).not.toContain(CUSTOM);
  });

  it('shows a one-time reset notice when the loaded preference was recoveredFromCorrupt', async () => {
    const ctl = makeDeps({
      getNodePreference: vi.fn(
        async () =>
          ({ kind: 'default', recoveredFromCorrupt: true }) as NodePreference,
      ),
    });
    renderNodeSettings(ctl.deps);

    await waitFor(() =>
      expect(screen.getByTestId('reset-notice')).toHaveTextContent(
        /reset to default/i,
      ),
    );

    // Dismissable / one-time: dismissing removes it.
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByTestId('reset-notice')).not.toBeInTheDocument();
  });

  it('renders ONLY the node section — no address-book / theme / biometric settings (YAGNI)', async () => {
    const { deps } = makeDeps();
    renderNodeSettings(deps);
    await waitFor(() => screen.getByRole('radio', { name: /default/i }));

    expect(screen.queryByText(/address book/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/theme/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/biometric/i)).not.toBeInTheDocument();
    // Exactly one settings section is present.
    expect(screen.getAllByRole('region')).toHaveLength(1);
  });
});
