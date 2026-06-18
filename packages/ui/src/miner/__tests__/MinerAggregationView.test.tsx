import { STOA_CHAINS } from '@stoawallet/core';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ChainEntry,
  UseMinerAggregationResult,
} from '../useMinerAggregation';

/**
 * The view composes `useMinerAggregation` and renders its per-chain state machine.
 * The hook itself is exercised by its own suite (T11.3); here it is STUBBED so the
 * view's rendering of the target selector, the funded-source cards, the gasless
 * disclosure, the per-chain staged progress, the PENDING→recovery routing, and the
 * three-way aggregate breakdown can be asserted in isolation — with no key material,
 * no network, and no real sweep.
 */
const hookSpy = vi.fn<() => UseMinerAggregationResult>();

vi.mock('../useMinerAggregation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../useMinerAggregation')>();
  return {
    ...actual,
    useMinerAggregation: () => hookSpy(),
  };
});

// Imported AFTER the mock factory is registered so the view binds the stub.
const { MinerAggregationView } = await import('../MinerAggregationView');

/** Build a stub hook result, overriding only the fields a test cares about. */
function stubHook(
  over: Partial<UseMinerAggregationResult> = {},
): UseMinerAggregationResult {
  return {
    targetChain: '0',
    setTargetChain: vi.fn(),
    sources: [],
    setAmount: vi.fn(),
    aggregate: vi.fn(async () => undefined),
    reAggregateSource: vi.fn(async () => undefined),
    isExecuting: false,
    locked: false,
    ...over,
  };
}

/** A funded idle source card with sane defaults. */
function source(over: Partial<ChainEntry> = {}): ChainEntry {
  const amount = over.amount ?? '10.000000000000';
  return {
    chainId: '1',
    progress: 'idle',
    amount,
    max: over.max ?? amount,
    ...over,
  };
}

/** Open the advanced per-chain detail view (the cards are hidden in the simple view). */
function openDetails(): void {
  fireEvent.click(screen.getByTestId('miner-toggle-details'));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('MinerAggregationView', () => {
  it('renders a target-chain selector with exactly 10 options from STOA_CHAINS', () => {
    hookSpy.mockReturnValue(stubHook());
    render(<MinerAggregationView />);

    const select = screen.getByTestId('miner-target');
    const options = within(select).getAllByRole('option');
    // The 10 braided chains come from core's canonical array, never a hardcoded list.
    expect(options).toHaveLength(STOA_CHAINS.length);
    expect(STOA_CHAINS.length).toBe(10);
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual([
      ...STOA_CHAINS,
    ]);
  });

  it('changing the target calls the hook setter, never the target as a source', () => {
    const setTargetChain = vi.fn();
    hookSpy.mockReturnValue(
      stubHook({
        targetChain: '0',
        setTargetChain,
        // The hook already excludes the target from `sources`; the view renders
        // exactly what it is given.
        sources: [source({ chainId: '1' }), source({ chainId: '2' })],
      }),
    );
    render(<MinerAggregationView />);

    fireEvent.change(screen.getByTestId('miner-target'), {
      target: { value: '3' },
    });
    expect(setTargetChain).toHaveBeenCalledWith('3');

    // The per-chain cards live in the advanced detail view.
    openDetails();
    // The target (chain 0) is not rendered as a swept source card.
    expect(screen.queryByTestId('miner-source-0')).toBeNull();
    expect(screen.getByTestId('miner-source-1')).toBeInTheDocument();
    expect(screen.getByTestId('miner-source-2')).toBeInTheDocument();
  });

  it('renders one card per funded source showing chain id and pre-scanned balance', () => {
    hookSpy.mockReturnValue(
      stubHook({
        sources: [
          source({ chainId: '1', amount: '12.500000000000' }),
          source({ chainId: '4', amount: '0.000000000001' }),
        ],
      }),
    );
    render(<MinerAggregationView />);
    openDetails();

    const card1 = screen.getByTestId('miner-source-1');
    expect(within(card1).getByText(/Chain 1/)).toBeInTheDocument();
    // The pre-scanned full balance flows to the amount input intact (12 decimals).
    expect(within(card1).getByTestId('miner-amount-1')).toHaveValue(
      '12.500000000000',
    );

    const card4 = screen.getByTestId('miner-source-4');
    // 12-decimal precision is preserved end-to-end, never Number()'d/rounded.
    expect(within(card4).getByTestId('miner-amount-4')).toHaveValue(
      '0.000000000001',
    );
  });

  it('MAX sets a source amount to its full pre-scanned balance via the hook', () => {
    const setAmount = vi.fn();
    hookSpy.mockReturnValue(
      stubHook({
        setAmount,
        sources: [source({ chainId: '1', amount: '9.250000000000' })],
      }),
    );
    render(<MinerAggregationView />);
    openDetails();

    fireEvent.click(
      within(screen.getByTestId('miner-source-1')).getByTestId('miner-max-1'),
    );
    expect(setAmount).toHaveBeenCalledWith('1', '9.250000000000');
  });

  it('lowering a source amount forwards the raw string to the hook (no rounding)', () => {
    const setAmount = vi.fn();
    hookSpy.mockReturnValue(
      stubHook({ setAmount, sources: [source({ chainId: '1' })] }),
    );
    render(<MinerAggregationView />);
    openDetails();

    fireEvent.change(screen.getByTestId('miner-amount-1'), {
      target: { value: '1.234567890123' },
    });
    expect(setAmount).toHaveBeenCalledWith('1', '1.234567890123');
  });

  it('SIMPLE view by default: a summary of the total + chain count + target, no per-chain cards', () => {
    hookSpy.mockReturnValue(
      stubHook({
        targetChain: '0',
        sources: [
          source({ chainId: '1', amount: '10.000000000000' }),
          source({ chainId: '2', amount: '5.000000000000' }),
        ],
      }),
    );
    render(<MinerAggregationView />);

    const summary = screen.getByTestId('miner-summary');
    expect(summary).toHaveTextContent('15.000000000000'); // total across 2 chains
    expect(summary).toHaveTextContent(/into Chain 0/);
    expect(screen.getByTestId('miner-source-count')).toHaveTextContent('2');
    // The per-chain cards are hidden until the advanced view is opened.
    expect(screen.queryByTestId('miner-source-1')).toBeNull();
    openDetails();
    expect(screen.getByTestId('miner-source-1')).toBeInTheDocument();
  });

  it('disables Aggregate (and flags the input) when a custom amount exceeds its chain balance', () => {
    hookSpy.mockReturnValue(
      stubHook({
        sources: [
          // amount lowered/raised ABOVE the max (full balance) → invalid.
          source({ chainId: '1', amount: '99.000000000000', max: '10.000000000000' }),
        ],
      }),
    );
    render(<MinerAggregationView />);
    openDetails();

    expect(screen.getByTestId('miner-exceed-1')).toBeInTheDocument();
    expect(screen.getByTestId('miner-aggregate')).toBeDisabled();
  });

  it('shows a gasless disclosure naming both gas paths and no per-source gas input', () => {
    hookSpy.mockReturnValue(
      stubHook({ sources: [source({ chainId: '0' }), source({ chainId: '5' })] }),
    );
    render(<MinerAggregationView />);

    const disclosure = screen.getByTestId('miner-gasless');
    // Matches the Phase-4/5 gasless messaging: chain-0 via the Ouronet Gas Station,
    // chains 1-9 via kadena-xchain-gas. No per-source gas field anywhere.
    expect(disclosure).toHaveTextContent(/gasless/i);
    expect(disclosure).toHaveTextContent(/Gas Station/i);
    expect(disclosure).toHaveTextContent(/kadena-xchain-gas/i);
    expect(screen.queryByTestId('miner-gas-input')).toBeNull();
  });

  it('disables "Aggregate STOA" while executing and when there are no funded sources', () => {
    hookSpy.mockReturnValue(stubHook({ sources: [] }));
    const { rerender } = render(<MinerAggregationView />);
    // No funded sources → nothing to sweep → the action is disabled.
    expect(screen.getByTestId('miner-aggregate')).toBeDisabled();

    hookSpy.mockReturnValue(
      stubHook({ sources: [source({ chainId: '1' })], isExecuting: true }),
    );
    rerender(<MinerAggregationView />);
    // A sweep is already in flight → disabled even with funded sources.
    expect(screen.getByTestId('miner-aggregate')).toBeDisabled();
  });

  it('enables "Aggregate STOA" with funded sources and runs the hook sweep', () => {
    const aggregate = vi.fn(async () => undefined);
    hookSpy.mockReturnValue(
      stubHook({ aggregate, sources: [source({ chainId: '1' })] }),
    );
    render(<MinerAggregationView />);

    const button = screen.getByTestId('miner-aggregate');
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(aggregate).toHaveBeenCalledTimes(1);
  });

  it('renders the live n/30 SPV counter for a waiting-spv source (not a frozen spinner)', () => {
    hookSpy.mockReturnValue(
      stubHook({
        isExecuting: true,
        sources: [
          source({
            chainId: '1',
            progress: 'waiting-spv',
            requestKey: 'rk-1',
            spvAttempt: 7,
            spvMaxAttempts: 30,
          }),
        ],
      }),
    );
    render(<MinerAggregationView />);

    const card = screen.getByTestId('miner-source-1');
    // The attempt counter is read from the hook's spvAttempt/spvMaxAttempts, so it
    // advances with each poll rather than freezing.
    expect(within(card).getByTestId('miner-progress-1')).toHaveTextContent(
      '7/30',
    );
  });

  it('renders a two-source mix (one done, one error) with each card distinct', () => {
    hookSpy.mockReturnValue(
      stubHook({
        sources: [
          source({
            chainId: '1',
            progress: 'done',
            continuationKey: 'ck-1',
          }),
          source({
            chainId: '2',
            progress: 'error',
            error: 'submit-failed',
          }),
        ],
      }),
    );
    render(<MinerAggregationView />);

    // One chain's terminal state shows on THAT card while the other keeps its own —
    // allSettled isolation, not a single shared banner.
    const done = screen.getByTestId('miner-progress-1');
    expect(done).toHaveTextContent(/done/i);
    const errored = screen.getByTestId('miner-progress-2');
    expect(errored).toHaveTextContent(/error|failed/i);
    expect(done).not.toHaveTextContent(/error|failed/i);
  });

  it('renders a network-lost source as PENDING with its request key and a Continue-tab route, never a resubmit/done control', () => {
    const onRouteToRecovery = vi.fn();
    hookSpy.mockReturnValue(
      stubHook({
        targetChain: '0',
        sources: [
          source({
            chainId: '3',
            progress: 'network-lost',
            requestKey: 'rk-pending-3',
            recoveryRoute: {
              requestKey: 'rk-pending-3',
              sourceChain: '3',
              targetChain: '0',
            },
          }),
        ],
      }),
    );
    render(<MinerAggregationView onRouteToRecovery={onRouteToRecovery} />);

    const card = screen.getByTestId('miner-source-3');
    // PENDING (not done): the burn MAY have committed, so the request key is shown
    // for recovery and there is NO success/done surface for this chain.
    expect(within(card).getByTestId('miner-pending-3')).toBeInTheDocument();
    expect(within(card).getByText('rk-pending-3')).toBeInTheDocument();
    // A PENDING chain is NEVER rendered as done — the done/progress surface for
    // this chain is absent, and the card text never claims completion.
    expect(within(card).queryByTestId('miner-progress-3')).toBeNull();
    expect(card).not.toHaveTextContent(/\bdone\b/i);

    // The Continue-tab affordance routes to recovery with the burn's identity
    // prefilled — it NEVER re-aggregates / re-sends Step-0 for this chain.
    fireEvent.click(within(card).getByTestId('miner-continue-3'));
    expect(onRouteToRecovery).toHaveBeenCalledWith({
      requestKey: 'rk-pending-3',
      sourceChain: '3',
      targetChain: '0',
    });
    // There is no per-chain re-aggregate / re-send-Step-0 control.
    expect(within(card).queryByTestId('miner-resubmit-3')).toBeNull();
  });

  it('renders the three-way aggregate breakdown (aggregated / pending / failed), not a single X-of-Y', () => {
    hookSpy.mockReturnValue(
      stubHook({
        targetChain: '0',
        sources: [
          source({ chainId: '1', amount: '10.000000000000', progress: 'done' }),
          source({ chainId: '2', amount: '5.000000000000', progress: 'done' }),
          source({
            chainId: '3',
            amount: '2.000000000000',
            progress: 'network-lost',
            requestKey: 'rk-3',
            recoveryRoute: { requestKey: 'rk-3', sourceChain: '3', targetChain: '0' },
          }),
          source({ chainId: '4', amount: '1.000000000000', progress: 'error' }),
        ],
      }),
    );
    render(<MinerAggregationView />);

    const result = screen.getByTestId('miner-result');
    // RR#5: aggregated (2 done = 15 STOA), pending-unknown (1), failed (1) — a
    // three-way breakdown, never collapsed into one "X of Y" number.
    expect(result).toHaveTextContent(/aggregated/i);
    expect(result).toHaveTextContent('15.000000000000');
    expect(result).toHaveTextContent(/pending/i);
    expect(result).toHaveTextContent(/failed/i);
    expect(within(result).getByTestId('miner-result-aggregated')).toHaveTextContent(
      '2',
    );
    expect(within(result).getByTestId('miner-result-pending')).toHaveTextContent(
      '1',
    );
    expect(within(result).getByTestId('miner-result-failed')).toHaveTextContent(
      '1',
    );
  });

  it('renders guard-unavailable as a DISTINCT retryable row (re-aggregate this source), NOT a Continue-tab/requestKey control', () => {
    const onRouteToRecovery = vi.fn();
    const reAggregateSource = vi.fn(async () => undefined);
    hookSpy.mockReturnValue(
      stubHook({
        targetChain: '0',
        reAggregateSource,
        sources: [
          source({
            chainId: '3',
            // A pre-burn transient read failure: nothing landed, NO requestKey.
            progress: 'guard-unavailable',
          }),
        ],
      }),
    );
    render(<MinerAggregationView onRouteToRecovery={onRouteToRecovery} />);

    const card = screen.getByTestId('miner-source-3');
    // A distinct guard-unavailable surface — the target keyset was temporarily
    // unreadable; the message tells the user to retry, not to use the Continue tab.
    const row = within(card).getByTestId('miner-guard-unavailable-3');
    expect(row).toHaveTextContent(/unreadable|retry/i);
    // No Continue-tab / requestKey affordance (nothing landed → nothing to continue).
    expect(within(card).queryByTestId('miner-continue-3')).toBeNull();
    expect(within(card).queryByTestId('miner-pending-3')).toBeNull();
    expect(card).not.toHaveTextContent(/Continue tab/i);

    // The retry affordance re-aggregates ONLY this source (safe — no burn landed).
    fireEvent.click(within(card).getByTestId('miner-retry-3'));
    expect(reAggregateSource).toHaveBeenCalledWith('3');
    // It never routes to the Phase-5 recovery view.
    expect(onRouteToRecovery).not.toHaveBeenCalled();
  });

  it('SG-003: the aggregated line shows the count over the total INTENDED denominator (alongside the three-way breakdown)', () => {
    hookSpy.mockReturnValue(
      stubHook({
        targetChain: '0',
        sources: [
          source({ chainId: '1', amount: '10.000000000000', progress: 'done' }),
          source({ chainId: '2', amount: '5.000000000000', progress: 'done' }),
          source({
            chainId: '3',
            amount: '2.000000000000',
            progress: 'network-lost',
            requestKey: 'rk-3',
            recoveryRoute: { requestKey: 'rk-3', sourceChain: '3', targetChain: '0' },
          }),
          source({ chainId: '4', amount: '1.000000000000', progress: 'error' }),
        ],
      }),
    );
    render(<MinerAggregationView />);

    const result = screen.getByTestId('miner-result');
    // 2 aggregated OF 4 intended — the denominator is surfaced so the user sees the
    // whole sweep size, alongside the RR#5 three-way breakdown (kept intact).
    expect(within(result).getByTestId('miner-result-intended')).toHaveTextContent('4');
    expect(within(result).getByTestId('miner-result-aggregated')).toHaveTextContent('2');
    expect(within(result).getByTestId('miner-result-pending')).toHaveTextContent('1');
    expect(within(result).getByTestId('miner-result-failed')).toHaveTextContent('1');
  });

  it('routes a locked sweep outcome to unlock rather than a generic error', () => {
    const onRequireUnlock = vi.fn();
    hookSpy.mockReturnValue(
      stubHook({ locked: true, sources: [source({ chainId: '1' })] }),
    );
    render(<MinerAggregationView onRequireUnlock={onRequireUnlock} />);

    fireEvent.click(screen.getByTestId('miner-unlock'));
    expect(onRequireUnlock).toHaveBeenCalledTimes(1);
  });
});
