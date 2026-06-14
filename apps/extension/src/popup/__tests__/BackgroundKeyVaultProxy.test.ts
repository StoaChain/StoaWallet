import { describe, expect, it, vi } from 'vitest';

import type { Request, Response, WireCommand } from '../../messaging/protocol';
import { BackgroundKeyVaultProxy } from '../BackgroundKeyVaultProxy';

/**
 * The popup-side delegation client. Every keyring op is proven to cross the
 * T7.2 wire to the background and NOTHING secret is ever held locally:
 *   - unlock/lock/isUnlocked/signTx each emit the matching protocol Request.
 *   - the discriminated `{ok:false, reason}` failures map back to the SAME
 *     outcomes the Phase-2 unlock UI already branches on (wrap-not-fork proof).
 *   - signTx returns ONLY the signed transaction, never a key.
 *   - the proxy holds NO mnemonic/key/password field (no-key proof).
 *
 * `chrome.runtime.sendMessage` is the ONLY external boundary doubled — the fake
 * background answers each request with a scripted Response.
 */

type SendMessageFake = (message: Request) => Promise<Response>;

/** Install a fake `chrome.runtime.sendMessage` that records requests + scripts replies. */
function installChrome(reply: SendMessageFake): { sent: Request[]; sendMessage: ReturnType<typeof vi.fn> } {
  const sent: Request[] = [];
  const sendMessage = vi.fn(async (message: Request) => {
    sent.push(message);
    return reply(message);
  });
  (globalThis as unknown as { chrome?: unknown }).chrome = {
    runtime: { id: 'stoawallet-test', sendMessage },
  };
  return { sent, sendMessage };
}

const SIGNED: WireCommand = { cmd: '{"payload":"x"}', hash: 'h', sigs: [{ pubKey: 'p', sig: 'deadbeef' }] };

describe('BackgroundKeyVaultProxy', () => {
  it('unlock sends an unlock Request carrying the walletId + password to the background', async () => {
    const { sent } = installChrome(async () => ({ ok: true }));
    const proxy = new BackgroundKeyVaultProxy();

    const result = await proxy.unlock('wallet-1', 'hunter2');

    // The op crosses the wire as the protocol's `unlock` request (walletId +
    // transient password), and the success collapses to `{ok:true}`.
    expect(sent).toEqual([{ type: 'unlock', walletId: 'wallet-1', password: 'hunter2' }]);
    expect(result).toEqual({ ok: true });
  });

  it('maps the background wrong-password failure to the Phase-2 wrong-password outcome', async () => {
    installChrome(async () => ({ ok: false, reason: 'wrong-password' }));
    const proxy = new BackgroundKeyVaultProxy();

    const result = await proxy.unlock('wallet-1', 'nope');

    // The wire `wrong-password` reason is surfaced VERBATIM so the existing
    // UnlockScreen renders "Wrong password" with no fork in the UI.
    expect(result).toEqual({ ok: false, reason: 'wrong-password' });
  });

  it('maps a locked signTx failure to the Phase-2 locked outcome so the UI re-unlocks', async () => {
    installChrome(async () => ({ ok: false, reason: 'locked' }));
    const proxy = new BackgroundKeyVaultProxy();

    const result = await proxy.signTx({ kind: 'active' }, { cmd: 'c', hash: 'h' });

    expect(result).toEqual({ ok: false, reason: 'locked' });
  });

  it('isUnlocked sends the query and returns the background boolean', async () => {
    const { sent } = installChrome(async () => ({ ok: true, unlocked: true }));
    const proxy = new BackgroundKeyVaultProxy();

    const unlocked = await proxy.isUnlocked();

    expect(sent).toEqual([{ type: 'isUnlocked' }]);
    expect(unlocked).toBe(true);
  });

  it('lock sends the lock Request', async () => {
    const { sent } = installChrome(async () => ({ ok: true }));
    const proxy = new BackgroundKeyVaultProxy();

    await proxy.lock();

    expect(sent).toEqual([{ type: 'lock' }]);
  });

  it('signTx delegates a signTx Request and returns ONLY the signed transaction, never a key', async () => {
    const { sent } = installChrome(async () => ({ ok: true, signed: SIGNED }));
    const proxy = new BackgroundKeyVaultProxy();

    const unsigned: WireCommand = { cmd: '{"payload":"x"}', hash: 'h' };
    const result = await proxy.signTx({ kind: 'active' }, unsigned);

    // The popup sends the SignerSpec (WHAT to sign with), never a key; the reply
    // carries the signed public tx only.
    expect(sent).toEqual([
      { type: 'signTx', tx: unsigned, accountIndex: 0, signerSpec: { kind: 'active' } },
    ]);
    expect(result).toEqual({ ok: true, signed: SIGNED });
    // The returned object exposes no secret-bearing field.
    if (result.ok) {
      expect(result.signed).not.toHaveProperty('privateKey');
      expect(result.signed).not.toHaveProperty('secretKey');
      expect(result.signed).not.toHaveProperty('mnemonic');
    }
  });

  it('holds NO local mnemonic / privateKey / secretKey / password field (no-key proof)', async () => {
    installChrome(async () => ({ ok: true, unlocked: true }));
    const proxy = new BackgroundKeyVaultProxy();
    await proxy.unlock('wallet-1', 'hunter2');
    await proxy.isUnlocked();

    // After a full unlock round-trip the proxy retains no secret material — only
    // the wire delegation surface lives here; the key stays in the worker.
    const ownKeys = Object.keys(proxy as unknown as Record<string, unknown>);
    for (const forbidden of ['mnemonic', 'privateKey', 'secretKey', 'password', 'unlockedKey']) {
      expect(ownKeys).not.toContain(forbidden);
    }
    const values = JSON.stringify(proxy);
    expect(values).not.toContain('hunter2');
  });

  it('urstoaExecute sends an urstoaOp Request with PUBLIC params only and returns the discriminated result', async () => {
    const { sent } = installChrome(async () => ({ ok: true, requestKey: 'rk-stake' }));
    const proxy = new BackgroundKeyVaultProxy();

    const result = await proxy.urstoaExecute({
      op: 'stake',
      params: { paymentKeyAddress: 'k:abc', amount: '5.0' },
    });

    // The op crosses as the protocol's `urstoaOp` request carrying only public
    // params — the keypair is resolved entirely in the worker (XP-12).
    expect(sent).toEqual([
      { type: 'urstoaOp', op: 'stake', params: { paymentKeyAddress: 'k:abc', amount: '5.0' } },
    ]);
    expect(result).toEqual({ ok: true, requestKey: 'rk-stake' });
    // No key material is present in the outbound wire message.
    expect(JSON.stringify(sent).toLowerCase()).not.toMatch(/privatekey|secretkey|mnemonic|paymentkeypair|gasstationkey/);
  });

  it('urstoaExecute surfaces a discriminated background failure verbatim', async () => {
    installChrome(async () => ({ ok: false, reason: 'gas-payer-rejected', detail: 'no sponsor' }));
    const proxy = new BackgroundKeyVaultProxy();

    const result = await proxy.urstoaExecute({
      op: 'transfer',
      params: { senderAddress: 'k:a', receiverAddress: 'k:b', amount: '1.0' },
    });

    expect(result).toEqual({ ok: false, reason: 'gas-payer-rejected', detail: 'no sponsor' });
  });
});
