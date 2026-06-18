import { describe, expect, it, vi } from 'vitest';

import { awaitSendConfirmation, type ConfirmSendDeps } from '../confirmSend';

const REQ = 'requestKey-abc123';
const CHAIN = '0';

function deps(listen: ConfirmSendDeps['listen']): ConfirmSendDeps {
  return { listen };
}

describe('awaitSendConfirmation', () => {
  it('maps a mined success to a definitive confirmed result', async () => {
    const listen = vi.fn(async () => ({ status: 'success' as const }));
    const result = await awaitSendConfirmation(REQ, CHAIN, deps(listen));

    expect(listen).toHaveBeenCalledWith(REQ, CHAIN);
    expect(result).toEqual({ ok: true, status: 'confirmed' });
  });

  it('maps a mined failure to failed, carrying the on-chain reason', async () => {
    const listen = vi.fn(async () => ({
      status: 'failure' as const,
      detail: 'Insufficient funds in sender account',
    }));
    const result = await awaitSendConfirmation(REQ, CHAIN, deps(listen));

    expect(result).toEqual({
      ok: true,
      status: 'failed',
      detail: 'Insufficient funds in sender account',
    });
  });

  it('gives a failed result a default detail when the outcome carries none', async () => {
    const listen = vi.fn(async () => ({ status: 'failure' as const }));
    const result = await awaitSendConfirmation(REQ, CHAIN, deps(listen));
    expect(result).toEqual({ ok: true, status: 'failed', detail: 'On-chain failure' });
  });

  it('maps a TRANSPORT timeout to the ambiguous timeout state (never a hard failure)', async () => {
    // A network/timeout throw means the submit may be on chain — the caller shows
    // the explorer and must NOT resubmit. This is `timeout`, not `failed`.
    const listen = vi.fn(async () => {
      throw new Error('fetch failed: network timeout');
    });
    const result = await awaitSendConfirmation(REQ, CHAIN, deps(listen));
    expect(result).toEqual({ ok: false, reason: 'timeout' });
  });

  it('maps a TIMEOUT-coded error to the timeout state', async () => {
    const err = Object.assign(new Error('deadline'), { code: 'TIMEOUT' });
    const listen = vi.fn(async () => {
      throw err;
    });
    const result = await awaitSendConfirmation(REQ, CHAIN, deps(listen));
    expect(result).toEqual({ ok: false, reason: 'timeout' });
  });

  it('maps a NON-transient throw to listen-failed (distinct from timeout)', async () => {
    const listen = vi.fn(async () => {
      throw new Error('unexpected parser error');
    });
    const result = await awaitSendConfirmation(REQ, CHAIN, deps(listen));
    expect(result).toEqual({ ok: false, reason: 'listen-failed' });
  });

  it('never throws across the boundary on any listen rejection', async () => {
    const listen = vi.fn(async () => {
      throw 'a bare string rejection';
    });
    await expect(
      awaitSendConfirmation(REQ, CHAIN, deps(listen)),
    ).resolves.toEqual({ ok: false, reason: 'listen-failed' });
  });
});
