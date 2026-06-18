import { describe, expect, it, vi } from 'vitest';

import { buildCrossChainStep0 } from '../buildStep0';

/**
 * `buildCrossChainStep0` is the PURE build wrapper for step 0 of a cross-chain
 * transfer. It validates inputs, resolves the receiver guard on the TARGET
 * chain (the ONE network read, injected here), and delegates the actual
 * coin.C_TransferAcross build to the real SDK `buildCTransferAcross`. It does
 * NOT sign and does NOT submit — the returned `tx` is unsigned.
 *
 * The read boundary (`getBalanceOnChain` + `fetchGuard`) is stubbed so these
 * tests stay offline; the SDK builder runs for real so we assert on the actual
 * built command shape, not on a mock's echo.
 */

const SENDER_PUB = 'a'.repeat(64);
const RECEIVER_PUB = 'b'.repeat(64);
const GAS_PUB = 'f'.repeat(64);
const SENDER = `k:${SENDER_PUB}`;
const RECEIVER = `k:${RECEIVER_PUB}`;

/** Receiver absent on target → auto keys-all from the receiver pubkey. */
const absentReceiver = {
  getBalanceOnChain: vi.fn(async () => ({ balance: '0.0', exists: false })),
  fetchGuard: vi.fn(async () => ({ ok: false as const })),
};

/** Receiver present + guard read succeeds → use the FETCHED guard. */
function presentReceiver(guard: { keys: string[]; pred: string }) {
  return {
    getBalanceOnChain: vi.fn(async () => ({ balance: '10.0', exists: true })),
    fetchGuard: vi.fn(async () => ({ ok: true as const, guard })),
  };
}

/** Receiver present but the guard read FAILS — must REFUSE, never fabricate. */
const presentButGuardUnavailable = {
  getBalanceOnChain: vi.fn(async () => ({ balance: '10.0', exists: true })),
  fetchGuard: vi.fn(async () => ({ ok: false as const })),
};

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    sender: SENDER,
    receiver: RECEIVER,
    amount: '5.0',
    sourceChain: '0',
    targetChain: '5',
    senderPublicKey: SENDER_PUB,
    gasStationPublicKey: GAS_PUB,
    ...overrides,
  };
}

describe('buildCrossChainStep0 — gas split (RR#3)', () => {
  it('chain 0 builds a gas-station tx with 2 signer pubs [sender, gasStation]', async () => {
    const res = await buildCrossChainStep0(baseInput({ sourceChain: '0' }), absentReceiver);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Chain 0 routes gas through the Ouronet Gas Station (DALOS.GAS_PAYER),
    // so the gas-station pubkey is a co-signer alongside the sender.
    expect(res.gasMode).toBe('gas-station');
    expect(res.signerPubs).toEqual([SENDER_PUB, GAS_PUB]);
    // The real SDK builder embeds BOTH pubkeys as signers on chain 0.
    const cmd = JSON.parse(res.tx.cmd);
    const pubs = cmd.signers.map((s: { pubKey: string }) => s.pubKey);
    expect(pubs).toContain(SENDER_PUB);
    expect(pubs).toContain(GAS_PUB);
  });

  it('chain 5 builds an xchain-gas tx with exactly 1 signer pub [sender]', async () => {
    const res = await buildCrossChainStep0(
      baseInput({ sourceChain: '5', targetChain: '7', gasStationPublicKey: undefined }),
      absentReceiver,
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Non-zero source chains pay gas via the unsigned kadena-xchain-gas account,
    // so the sender is the ONLY signer — the gas-station pub must not appear.
    expect(res.gasMode).toBe('xchain-gas');
    expect(res.signerPubs).toEqual([SENDER_PUB]);
    const cmd = JSON.parse(res.tx.cmd);
    const pubs = cmd.signers.map((s: { pubKey: string }) => s.pubKey);
    expect(pubs).toEqual([SENDER_PUB]);
  });

  it('chain 0 with no gas-station pub refuses with no-gas-station-key', async () => {
    const res = await buildCrossChainStep0(
      baseInput({ sourceChain: '0', gasStationPublicKey: undefined }),
      absentReceiver,
    );
    // Without the gas-station signer, a chain-0 build would produce an
    // unsignable DALOS.GAS_PAYER cap — refuse before building.
    expect(res).toEqual({ ok: false, reason: 'no-gas-station-key' });
  });

  it('chain 0 with an empty-string gas-station pub also refuses', async () => {
    const res = await buildCrossChainStep0(
      baseInput({ sourceChain: '0', gasStationPublicKey: '' }),
      absentReceiver,
    );
    expect(res).toEqual({ ok: false, reason: 'no-gas-station-key' });
  });
});

describe('buildCrossChainStep0 — source/target guard (RR#5)', () => {
  it('refuses when source equals target', async () => {
    const res = await buildCrossChainStep0(
      baseInput({ sourceChain: '5', targetChain: '5' }),
      absentReceiver,
    );
    expect(res).toEqual({ ok: false, reason: 'same-source-target' });
  });
});

describe('buildCrossChainStep0 — receiver validation (Phase-4 pattern)', () => {
  it('refuses a non-k: receiver', async () => {
    const res = await buildCrossChainStep0(
      baseInput({ receiver: `c:${'b'.repeat(64)}` }),
      absentReceiver,
    );
    expect(res).toEqual({ ok: false, reason: 'invalid-recipient' });
  });

  it('refuses a k: receiver with a short (non-64) hex body', async () => {
    const res = await buildCrossChainStep0(
      baseInput({ receiver: `k:${'b'.repeat(63)}` }),
      absentReceiver,
    );
    expect(res).toEqual({ ok: false, reason: 'invalid-recipient' });
  });

  it('refuses a k: receiver with a non-hex body', async () => {
    const res = await buildCrossChainStep0(
      baseInput({ receiver: `k:${'g'.repeat(64)}` }),
      absentReceiver,
    );
    expect(res).toEqual({ ok: false, reason: 'invalid-recipient' });
  });

  it('ALLOWS a self-send (receiver === sender) — your own account on a different chain', async () => {
    // Moving your own funds across chains is the canonical cross-chain transfer;
    // since source ≠ target is already enforced, receiver === sender is valid.
    const res = await buildCrossChainStep0(
      baseInput({ receiver: SENDER }),
      absentReceiver,
    );
    expect(res.ok).toBe(true);
  });
});

describe('buildCrossChainStep0 — amount validation (Phase-4 pattern)', () => {
  it.each(['0', '0.0', 'NaN', '', '   ', '-1', '5.0000000000001'])(
    'refuses an invalid amount %j with invalid-amount',
    async (amount) => {
      const res = await buildCrossChainStep0(baseInput({ amount }), absentReceiver);
      expect(res).toEqual({ ok: false, reason: 'invalid-amount' });
    },
  );

  it('normalizes "5" to "5.0" and passes the SAME string into the build', async () => {
    const res = await buildCrossChainStep0(
      baseInput({ amount: '5', sourceChain: '5', targetChain: '7', gasStationPublicKey: undefined }),
      absentReceiver,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // formatStoaAmount turns "5" into "5.0"; that exact string must reach the
    // built pact code — not a Number().toFixed(12) float-drifted "5.000000000000".
    const cmd = JSON.parse(res.tx.cmd);
    expect(cmd.payload.exec.code).toContain('5.0');
    expect(cmd.payload.exec.code).not.toContain('5.000000000000');
  });
});

describe('buildCrossChainStep0 — receiver-guard resolution (RR#4)', () => {
  it('auto-generates a keys-all guard from the RECEIVER pubkey when absent on target', async () => {
    const deps = {
      getBalanceOnChain: vi.fn(async () => ({ balance: '0.0', exists: false })),
      fetchGuard: vi.fn(async () => ({ ok: false as const })),
    };
    const res = await buildCrossChainStep0(baseInput(), deps);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // For a brand-new account we own the guard definition: keys-all over the
    // receiver's own pubkey (after the confirmed k: prefix).
    expect(res.receiverGuard).toEqual({ keys: [RECEIVER_PUB], pred: 'keys-all' });
    // No guard read should even be attempted for an absent account.
    expect(deps.fetchGuard).not.toHaveBeenCalled();
  });

  it('uses the FETCHED on-chain guard when the receiver exists and the read succeeds', async () => {
    const onChainGuard = { keys: [RECEIVER_PUB, 'c'.repeat(64)], pred: 'keys-any' };
    const deps = presentReceiver(onChainGuard);
    const res = await buildCrossChainStep0(baseInput(), deps);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // An existing account already has an authoritative guard on chain — honor
    // it verbatim (a multisig keys-any here), never overwrite with keys-all.
    expect(res.receiverGuard).toEqual(onChainGuard);
    expect(deps.fetchGuard).toHaveBeenCalledWith(RECEIVER, '5');
  });

  it('REFUSES with guard-unavailable when the receiver exists but the guard read fails', async () => {
    const res = await buildCrossChainStep0(baseInput(), presentButGuardUnavailable);
    // The RR#4 critical distinction: fabricating a keys-all guard for an
    // EXISTING account would lock or misdirect funds. A failed read on an
    // existing account is retryable, not a license to invent a guard.
    expect(res).toEqual({ ok: false, reason: 'guard-unavailable' });
  });
});
