// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DAPP_RATELIMIT_KEY, type StorageAdapter } from '@stoawallet/core';

import { DAppPermissionStore } from '../permissionStore';
import { RequestRateLimiter } from '../rateLimiter';
import {
  createDappRouter,
  type ApprovalGateway,
  type ApprovalRequest,
  type ApprovalResult,
  type CommandSigner,
  type CommandSignResult,
  type DappTabMessenger,
} from '../dappRouter';
import type { CommandSigData, DappEvent } from '../protocol';
import { installStoaProvider, type StoaProvider } from '../inpage';
import { installContentScriptRelay, type RelayRuntime } from '../contentScript';

/**
 * PHASE-9 SECURITY-POSTURE EXIT GATE — end-to-end harness.
 *
 * This is the repeatable security gate for the injected dApp-provider surface,
 * the highest-risk part of the wallet. It assembles the REAL bridge end-to-end —
 *
 *     window.stoa (inpage provider, T9.3)
 *        -> window.postMessage transport
 *        -> content-script relay (T9.5)
 *        -> chrome.runtime transport
 *        -> dApp router (T9.6) + REAL permission store (T9.2) + REAL limiter (T9.4)
 *        -> approval gateway (T9.7)  -> background signer (Phase-7 seam)
 *
 * and stubs ONLY the platform boundaries: the `window.postMessage` transport (a
 * real browser sets `event.source`/`event.origin`; jsdom does not, so we
 * re-dispatch faithfully), `chrome.runtime` (its `sendMessage` invokes the REAL
 * router with a controllable verified `sender` — the trust authority), the
 * approval-WINDOW open (a gateway double that records the tx preview it was shown
 * and is resolved by the test), and the cryptographic signing in the Phase-7
 * background path (a signer double that hashes the EXACT cmd bytes, so a swap is
 * caught). Everything between — the bridge, router, store, limiter, nonce/token
 * correlation, freeze/snapshot, origin gating — is the REAL production code.
 *
 * Invariant coverage (acceptance criteria + binding Review Resolutions):
 *   - REJECT-BY-DEFAULT (non-negotiable)           — sign/connect without grant
 *   - NO ORIGIN SPOOFING (RR#7)                    — real sender.origin gates
 *   - NO KEY EXPOSURE                              — page-ward scan finds no secret
 *   - EXPLICIT APPROVAL + TX PREVIEW (T9.7)        — preview shown before sign
 *   - DISCONNECT/REVOKE (T9.2, RR#12)              — revoke severs + emits event
 *   - RR#1 no bait-and-switch (TOCTOU)             — previewed hash === signed hash
 *   - RR#2 approval nonce, no cross-resolve        — concurrent approvals isolated
 *   - RR#3 postMessage hardening                   — foreign source/origin dropped
 *   - NEVER logs a secret                          — console scan across the cycle
 *
 * The framing-header posture (frame-ancestors 'none' + the sensor-locking
 * Permissions-Policy) on the shipped approval surface is the build-artifact gate
 * owned by `src/__tests__/dappManifest.test.ts`; it is referenced here (and
 * re-asserted against the approval HTML source) rather than duplicating the
 * production-build pipeline.
 */

const RUNTIME_ID = 'stoawallet-extension-id';
const NETWORK_ID = 'stoachain';
const GRANTED = [{ address: 'k:pub-a', publicKey: 'pub-a' }];

/**
 * A deterministic content-addressed hash over the EXACT cmd bytes. Faithful to
 * the Phase-7 signer's property that matters for RR#1: the hash is a pure
 * function of the cmd string, so a one-byte swap between preview and sign yields
 * a different hash. (The real signer uses blake2b-256; the cryptographic
 * algorithm is irrelevant to the no-bait-and-switch proof — byte-binding is.)
 */
function cmdHash(cmd: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < cmd.length; i += 1) {
    h ^= cmd.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `h:${h.toString(16).padStart(8, '0')}:len${cmd.length}`;
}

/** A public test signing command — no secret material, eckoWALLET shape. */
function publicCmd(label: string): CommandSigData {
  return {
    cmd: JSON.stringify({
      payload: { exec: { code: `(coin.transfer "alice" "bob" 1.0) ;; ${label}`, data: {} } },
      signers: [{ pubKey: 'pub-a', clist: [{ name: 'coin.TRANSFER', args: ['alice', 'bob', 1.0] }] }],
      meta: { chainId: '0', sender: 'alice' },
      nonce: label,
    }),
    sigs: [{ pubKey: 'pub-a', sig: null }],
  };
}

function memAdapter(): StorageAdapter & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      store.set(key, typeof value === 'string' ? value : new TextDecoder().decode(value));
    },
    async remove(key) {
      store.delete(key);
    },
  };
}

/**
 * The approval-window-open boundary double (T9.7 seam). It records EVERY intent
 * it was asked to render — so the test can assert the tx preview was shown before
 * any signing — and lets the test resolve each pending approval by its nonce.
 */
function makeApprovalGateway(): ApprovalGateway & {
  opened: ApprovalRequest[];
  resolveByNonce(nonce: string, result: Omit<ApprovalResult, 'nonce'>): void;
  resolveLast(result: Omit<ApprovalResult, 'nonce'>): void;
} {
  const opened: ApprovalRequest[] = [];
  const resolvers = new Map<string, (r: ApprovalResult) => void>();
  return {
    opened,
    open(request) {
      opened.push(request);
      return new Promise<ApprovalResult>((resolve) => resolvers.set(request.nonce, resolve));
    },
    resolveByNonce(nonce, result) {
      const fn = resolvers.get(nonce);
      if (fn) {
        resolvers.delete(nonce);
        fn({ ...result, nonce });
      }
    },
    resolveLast(result) {
      const last = opened[opened.length - 1];
      this.resolveByNonce(last.nonce, result);
    },
  };
}

/**
 * The Phase-7 background signing boundary double. It records the FROZEN cmds it
 * was handed and the token it saw, and produces a signed public artifact whose
 * outcome.hash is `cmdHash(cmd)` — a pure function of the exact cmd bytes. No
 * key material is ever read, returned, or named.
 */
function makeSigner(): CommandSigner & {
  calls: { cmds: readonly CommandSigData[]; token: string }[];
  locked: boolean;
} {
  const calls: { cmds: readonly CommandSigData[]; token: string }[] = [];
  return {
    calls,
    locked: false,
    async sign(cmds, token): Promise<CommandSignResult> {
      calls.push({ cmds, token });
      if (this.locked) return { ok: false, reason: 'locked' };
      return {
        ok: true,
        responses: cmds.map((c) => ({
          commandSigData: {
            cmd: c.cmd,
            sigs: c.sigs.map((s) => ({ pubKey: s.pubKey, sig: `sig:${cmdHash(c.cmd)}` })),
          },
          outcome: { result: 'success' as const, hash: cmdHash(c.cmd) },
        })),
      };
    },
  };
}

function makeMessenger(): DappTabMessenger & { sent: { tabId: number; message: DappEvent }[] } {
  const sent: { tabId: number; message: DappEvent }[] = [];
  return {
    sent,
    sendToTab(tabId, message) {
      sent.push({ tabId, message });
    },
  };
}

async function waitFor(predicate: () => boolean, label = 'condition'): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`waitFor timed out: ${label}`);
}

/**
 * Assemble the FULL real bridge across one jsdom `window`, exposing the page-world
 * `window.stoa` provider and routing every hop through the real relay + router.
 *
 * `sender` controls the VERIFIED runtime sender the background sees — the single
 * trust authority. The test mutates it to simulate a different real origin (the
 * origin-spoof case) independent of whatever the page claims in its payload.
 */
async function buildBridge(opts: {
  origin: string;
  tabId?: number;
}): Promise<{
  stoa: StoaProvider;
  router: ReturnType<typeof createDappRouter>;
  store: DAppPermissionStore;
  approvals: ReturnType<typeof makeApprovalGateway>;
  signer: ReturnType<typeof makeSigner>;
  messenger: ReturnType<typeof makeMessenger>;
  adapter: ReturnType<typeof memAdapter>;
  pageMessages: unknown[];
  sender: chrome.runtime.MessageSender;
  setSenderOrigin(origin: string): void;
  teardown(): void;
}> {
  const adapter = memAdapter();
  const store = await DAppPermissionStore.load(adapter);
  const limiter = new RequestRateLimiter();
  const approvals = makeApprovalGateway();
  const signer = makeSigner();
  const messenger = makeMessenger();

  const router = createDappRouter({
    store,
    limiter,
    adapter,
    approvals,
    signer,
    messenger,
    runtimeId: RUNTIME_ID,
    networkId: NETWORK_ID,
    grantedAccounts: GRANTED,
    approvalTimeoutMs: 200,
  });

  // The verified sender the background trusts. Tests mutate `.origin` to drive
  // the origin-spoof case; the page payload never feeds this.
  const sender: { current: chrome.runtime.MessageSender } = {
    current: {
      id: RUNTIME_ID,
      origin: opts.origin,
      url: `${opts.origin}/page`,
      tab: { id: opts.tabId ?? 7, url: `${opts.origin}/page` } as chrome.tabs.Tab,
    } as chrome.runtime.MessageSender,
  };

  // --- platform boundary: window.postMessage transport ----------------------
  // A real browser stamps event.source (the posting window) and event.origin;
  // jsdom does not. We intercept postMessage and re-dispatch a faithful
  // MessageEvent so the inpage provider's and relay's RR#3 source/origin checks
  // see exactly what a real browser would. The bridge logic stays REAL.
  const pageOrigin = window.location.origin;
  const postSpy = vi
    .spyOn(window, 'postMessage')
    .mockImplementation((message: unknown, targetOrigin?: unknown) => {
      // RR#3 production guarantee asserted at the transport: page-ward sends use
      // an explicit same-origin targetOrigin, NEVER "*".
      expect(targetOrigin).toBe(pageOrigin);
      window.dispatchEvent(
        new MessageEvent('message', { data: message, origin: pageOrigin, source: window }),
      );
      return undefined as never;
    });

  // --- platform boundary: chrome.runtime transport --------------------------
  // The relay's only hop to the background. sendMessage invokes the REAL router
  // with the verified sender; background-pushed events are delivered to the
  // relay's onMessage listeners.
  const bgListeners = new Set<(message: unknown) => void>();
  const runtime: RelayRuntime = {
    sendMessage: (message) => router.handle(message as never, sender.current),
    onMessage: {
      addListener: (cb) => bgListeners.add(cb),
      removeListener: (cb) => bgListeners.delete(cb),
    },
  };
  // The messenger seam pushes events to a tab; route them onto the relay's
  // runtime channel so the page-world provider receives them end-to-end. In a
  // real browser the background's chrome.tabs.sendMessage event and the
  // chrome.runtime.sendMessage response settle on SEPARATE turns; the router
  // emits the disconnect event synchronously while still inside handle(), before
  // its own response has resolved the request promise. Deferring the event to a
  // microtask preserves that real-browser turn separation (the bridge logic
  // stays real — only the cross-turn transport timing is modeled).
  const realMessenger = messenger.sendToTab.bind(messenger);
  messenger.sendToTab = (tabId, message) => {
    realMessenger(tabId, message);
    queueMicrotask(() => {
      for (const cb of bgListeners) {
        cb({
          channel: 'stoa-wallet/dapp',
          direction: 'to-page',
          kind: 'event',
          event: message.event,
          data: 'accounts' in message ? message.accounts : undefined,
        });
      }
    });
  };

  // Record every message that crosses INTO the page world (the secret-scan target).
  const pageMessages: unknown[] = [];
  function recordPageInbound(event: MessageEvent): void {
    if (event.source === window && event.origin === pageOrigin) pageMessages.push(event.data);
  }
  window.addEventListener('message', recordPageInbound);

  const { provider } = installStoaProvider(window);
  const teardownRelay = installContentScriptRelay(window, runtime);

  return {
    stoa: provider,
    router,
    store,
    approvals,
    signer,
    messenger,
    adapter,
    pageMessages,
    sender: sender.current,
    setSenderOrigin(origin) {
      sender.current = { ...sender.current, origin };
    },
    teardown() {
      window.removeEventListener('message', recordPageInbound);
      teardownRelay();
      postSpy.mockRestore();
    },
  };
}

/** Narrow an eckoWALLET-style provider result to its `{status, reason?}` shape. */
function asResult(value: unknown): { status?: string; reason?: string } & Record<string, unknown> {
  return (value ?? {}) as { status?: string; reason?: string } & Record<string, unknown>;
}

describe('Phase-9 dApp security posture — end-to-end gate', () => {
  let bridge: Awaited<ReturnType<typeof buildBridge>>;

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    bridge?.teardown();
    vi.restoreAllMocks();
  });

  it('REJECT-BY-DEFAULT: a malicious page that calls kda_requestSign without a prior connection is rejected origin-not-allowed and NEVER signs', async () => {
    bridge = await buildBridge({ origin: 'https://evil.test' });

    const result = asResult(
      await bridge.stoa.request({
        method: 'kda_requestSign',
        data: { networkId: NETWORK_ID, signingCmd: { cmd: publicCmd('m').cmd, sigs: [] } },
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.reason).toBe('origin-not-allowed');
    // No approval window was ever opened and the signer was never invoked.
    expect(bridge.approvals.opened).toHaveLength(0);
    expect(bridge.signer.calls).toHaveLength(0);
  });

  it('REJECT-BY-DEFAULT: a kda_connect with no explicit approve (reject/dismiss) yields user-rejected and grants no allow', async () => {
    bridge = await buildBridge({ origin: 'https://evil.test' });

    const p = bridge.stoa.request({ method: 'kda_connect', networkId: NETWORK_ID });
    await waitFor(() => bridge.approvals.opened.length === 1, 'connect prompt');
    bridge.approvals.resolveLast({ approved: false });
    const result = asResult(await p);

    expect(result.status).toBe('fail');
    expect(result.reason).toBe('user-rejected');
    expect(await bridge.store.isAllowed('https://evil.test')).toBe(false);
  });

  it('NO ORIGIN SPOOFING: a page whose payload claims another origin does not gain that origin\'s grant — the REAL sender.origin governs', async () => {
    bridge = await buildBridge({ origin: 'https://evil.test' });
    // good.test is the only granted origin.
    await bridge.store.allow('https://good.test', GRANTED, 7);

    // The page smuggles origin:"https://good.test" into BOTH the envelope-level
    // and inner payload; the verified sender is still evil.test.
    const result = asResult(
      await bridge.stoa.request({
        method: 'kda_requestSign',
        origin: 'https://good.test',
        data: {
          networkId: NETWORK_ID,
          origin: 'https://good.test',
          signingCmd: { cmd: publicCmd('s').cmd, sigs: [] },
        },
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.reason).toBe('origin-not-allowed');
    expect(bridge.signer.calls).toHaveLength(0);
    // The spoofed grant for good.test is untouched and was NOT honored for evil.
    expect(await bridge.store.isAllowed('https://good.test')).toBe(true);
  });

  it('EXPLICIT APPROVAL + TX PREVIEW + NO BAIT-AND-SWITCH (RR#1): the previewed cmd is shown before signing and its hash equals the signed hash', async () => {
    bridge = await buildBridge({ origin: 'https://good.test' });
    await bridge.store.allow('https://good.test', GRANTED, 7);
    const cmd = publicCmd('preview-bind');

    const p = bridge.stoa.request({
      method: 'kda_requestQuickSign',
      data: { networkId: NETWORK_ID, commandSigDatas: [cmd] },
    });

    // The approval surface was shown WITH the tx preview BEFORE any sign call.
    await waitFor(() => bridge.approvals.opened.length === 1, 'sign prompt');
    const shown = bridge.approvals.opened[0];
    expect(shown.kind).toBe('sign');
    expect(bridge.signer.calls).toHaveLength(0); // preview precedes signing
    const previewedCmd = shown.kind === 'sign' ? shown.commandSigDatas[0].cmd : '';
    expect(previewedCmd).toBe(cmd.cmd);

    bridge.approvals.resolveLast({ approved: true, approvalToken: 'tok' });
    const result = asResult(await p);

    expect(result.status).toBe('success');
    // The signer was handed the EXACT bytes that were previewed (TOCTOU-proof):
    // the same cmd reaches preview and signer, and the signed hash binds those bytes.
    expect(bridge.signer.calls).toHaveLength(1);
    const signedCmd = bridge.signer.calls[0].cmds[0].cmd;
    expect(signedCmd).toBe(previewedCmd);
    const responses = result.responses as { outcome: { hash: string } }[];
    expect(responses[0].outcome.hash).toBe(cmdHash(previewedCmd));
  });

  it('EXPLICIT APPROVAL: a sign with the approval REJECTED does not sign and returns user-rejected', async () => {
    bridge = await buildBridge({ origin: 'https://good.test' });
    await bridge.store.allow('https://good.test', GRANTED, 7);

    const p = bridge.stoa.request({
      method: 'kda_requestQuickSign',
      data: { networkId: NETWORK_ID, commandSigDatas: [publicCmd('reject')] },
    });
    await waitFor(() => bridge.approvals.opened.length === 1, 'reject sign prompt');
    bridge.approvals.resolveLast({ approved: false });
    const result = asResult(await p);

    expect(result.status).toBe('fail');
    expect(result.reason).toBe('user-rejected');
    expect(bridge.signer.calls).toHaveLength(0);
  });

  it('NO KEY EXPOSURE: across an approved connect -> approved sign, no message crossing to the page carries a mnemonic/privateKey/secretKey', async () => {
    bridge = await buildBridge({ origin: 'https://good.test' });

    const pc = bridge.stoa.request({ method: 'kda_connect', networkId: NETWORK_ID });
    await waitFor(() => bridge.approvals.opened.length === 1, 'connect prompt');
    bridge.approvals.resolveLast({ approved: true, accounts: ['k:pub-a'] });
    const connectResult = asResult(await pc);
    expect(connectResult.status).toBe('success');

    const ps = bridge.stoa.request({
      method: 'kda_requestQuickSign',
      data: { networkId: NETWORK_ID, commandSigDatas: [publicCmd('expose')] },
    });
    await waitFor(() => bridge.approvals.opened.length === 2, 'sign prompt');
    bridge.approvals.resolveLast({ approved: true, approvalToken: 'tok' });
    const signResult = asResult(await ps);
    expect(signResult.status).toBe('success');

    // Scan EVERY message that crossed into the page world.
    expect(bridge.pageMessages.length).toBeGreaterThan(0);
    const flat = JSON.stringify(bridge.pageMessages);
    expect(flat).not.toContain('mnemonic');
    expect(flat).not.toContain('privateKey');
    expect(flat).not.toContain('secretKey');
    // The public signed artifact DID cross (a filled sig), proving real signing.
    expect(flat).toContain('sig:');
  });

  it('DISCONNECT/REVOKE (RR#12): after connect, a disconnect severs access and the page receives a disconnect event; re-requests are rejected again', async () => {
    bridge = await buildBridge({ origin: 'https://good.test', tabId: 21 });

    // Connect (approved).
    const pc = bridge.stoa.request({ method: 'kda_connect', networkId: NETWORK_ID });
    await waitFor(() => bridge.approvals.opened.length === 1, 'connect prompt');
    bridge.approvals.resolveLast({ approved: true, accounts: ['k:pub-a'] });
    await pc;
    expect(await bridge.store.isAllowed('https://good.test')).toBe(true);

    // The page subscribes to disconnect, then disconnects. The disconnect event
    // the wallet pushes also cancels in-flight page requests (RR#14 in inpage.ts),
    // so the kda_disconnect call itself may settle EITHER as the success response
    // OR be rejected by the very disconnect event it triggered — both are correct
    // provider behavior. The security-relevant outcomes are: the page RECEIVED the
    // disconnect event, access was SEVERED, and re-requests are rejected again.
    let gotDisconnect = false;
    bridge.stoa.on('disconnect', () => {
      gotDisconnect = true;
    });
    await bridge.stoa.request({ method: 'kda_disconnect' }).then(
      () => undefined,
      () => undefined,
    );
    await waitFor(() => gotDisconnect, 'page disconnect event');
    expect(await bridge.store.isAllowed('https://good.test')).toBe(false);

    // A subsequent sign from the now-revoked origin is rejected by default again.
    const reReq = asResult(
      await bridge.stoa.request({
        method: 'kda_requestQuickSign',
        data: { networkId: NETWORK_ID, commandSigDatas: [publicCmd('after-revoke')] },
      }),
    );
    expect(reReq.status).toBe('fail');
    expect(reReq.reason).toBe('origin-not-allowed');
  });

  it('RR#2 nonce isolation: two concurrent connect approvals never cross-resolve — APPROVE for A does not grant B', async () => {
    bridge = await buildBridge({ origin: 'https://a.test', tabId: 1 });

    const pA = bridge.stoa.request({ method: 'kda_connect', networkId: NETWORK_ID });
    // Switch the verified sender to B for the second request (a distinct origin).
    bridge.setSenderOrigin('https://b.test');
    const pB = bridge.stoa.request({ method: 'kda_connect', networkId: NETWORK_ID });

    await waitFor(() => bridge.approvals.opened.length === 2, 'two prompts');
    const nonceA = bridge.approvals.opened[0].nonce;
    const nonceB = bridge.approvals.opened[1].nonce;
    expect(nonceA).not.toBe(nonceB);

    // Approve ONLY A.
    bridge.approvals.resolveByNonce(nonceA, { approved: true, accounts: ['k:pub-a'] });
    const resA = asResult(await pA);
    expect(resA.status).toBe('success');
    expect(await bridge.store.isAllowed('https://a.test')).toBe(true);
    // B was never granted by A's approval.
    expect(await bridge.store.isAllowed('https://b.test')).toBe(false);

    bridge.approvals.resolveByNonce(nonceB, { approved: false });
    const resB = asResult(await pB);
    expect(resB.status).toBe('fail');
    expect(await bridge.store.isAllowed('https://b.test')).toBe(false);
  });

  it('RR#3 postMessage hardening: a forged response from a FOREIGN source / WRONG origin is dropped — only the same-origin same-window reply resolves the request', async () => {
    bridge = await buildBridge({ origin: 'https://good.test' });
    await bridge.store.allow('https://good.test', GRANTED, 7);

    const p = bridge.stoa.request({ method: 'kda_getNetwork' }, { timeoutMs: 300 });

    // Inject a hostile forged response claiming the same channel + a hijack
    // payload, BUT from a different window source and a different origin — the two
    // RR#3 boundary checks (event.source === window AND event.origin === origin).
    // It must be dropped before the payload is even inspected.
    for (const bad of [
      { origin: 'https://attacker.test', source: {} as Window },
      { origin: window.location.origin, source: {} as Window },
      { origin: 'https://attacker.test', source: window },
    ]) {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            channel: 'stoa-wallet/dapp',
            direction: 'to-page',
            kind: 'response',
            id: 'forged-id',
            result: { status: 'success', networkId: 'attacker-net', hijacked: true },
          },
          origin: bad.origin,
          source: bad.source,
        }),
      );
    }

    // Only the legitimate same-origin same-window reply (replayed by the relay)
    // resolves the pending request; the forged ones never did.
    const result = asResult(await p);
    expect(result.status).toBe('success');
    expect(result.networkId).toBe(NETWORK_ID);
    expect(result.networkId).not.toBe('attacker-net');
    expect(result.hijacked).toBeUndefined();
  });

  it('NEVER logs a secret: no console.* call during connect -> sign contains key-shaped material', async () => {
    bridge = await buildBridge({ origin: 'https://good.test' });
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );

    const pc = bridge.stoa.request({ method: 'kda_connect', networkId: NETWORK_ID });
    await waitFor(() => bridge.approvals.opened.length === 1, 'connect prompt');
    bridge.approvals.resolveLast({ approved: true, accounts: ['k:pub-a'] });
    await pc;

    const ps = bridge.stoa.request({
      method: 'kda_requestQuickSign',
      data: { networkId: NETWORK_ID, commandSigDatas: [publicCmd('log')] },
    });
    await waitFor(() => bridge.approvals.opened.length === 2, 'sign prompt');
    bridge.approvals.resolveLast({ approved: true, approvalToken: 'tok' });
    await ps;

    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        const joined = call.map((a) => String(a)).join(' ');
        expect(joined).not.toContain('privateKey');
        expect(joined).not.toContain('secretKey');
        expect(joined.toLowerCase()).not.toContain('mnemonic');
      }
    }
  });

  it('RR#9 limiter persists across the bridge: the rate-limit state is written under DAPP_RATELIMIT_KEY after an accounted request', async () => {
    bridge = await buildBridge({ origin: 'https://good.test' });

    const p = bridge.stoa.request({ method: 'kda_connect', networkId: NETWORK_ID });
    await waitFor(() => bridge.approvals.opened.length === 1, 'connect prompt');
    bridge.approvals.resolveLast({ approved: false });
    await p;

    // The connect was accounted and the limiter state survived to storage, so an
    // MV3 SW respawn cannot reset a hostile origin's spam budget.
    expect(bridge.adapter.store.has(DAPP_RATELIMIT_KEY)).toBe(true);
  });
});

/**
 * FRAMING POSTURE — the clickjacking gate on the approval surface.
 *
 * The shipped-artifact assertion (these headers present in the BUILT
 * `dist/.../approval.html`) is owned by `src/__tests__/dappManifest.test.ts`,
 * which production-builds the extension and reads the emitted HTML. This gate
 * re-asserts the SAME non-negotiable headers against the approval HTML source so
 * a regression that strips `frame-ancestors 'none'` or loosens the sensor
 * Permissions-Policy fails the Phase-9 security gate directly, without waiting on
 * the full production build.
 */
describe('Phase-9 framing posture — approval surface headers', () => {
  const APPROVAL_HTML = path.resolve(
    fileURLToPath(import.meta.url),
    '..',
    '..',
    '..',
    'approval',
    'approval.html',
  );

  function metaContent(html: string, httpEquiv: string): string | undefined {
    const tag = html.match(new RegExp(`<meta\\s+http-equiv="${httpEquiv}"[^>]*?>`, 'is'))?.[0];
    return tag?.match(/content="([^"]*)"/is)?.[1];
  }

  it('approval surface sets frame-ancestors none so no page can iframe the signing prompt', () => {
    const csp = metaContent(readFileSync(APPROVAL_HTML, 'utf8'), 'Content-Security-Policy');
    expect(csp, 'approval HTML must carry a CSP meta tag').toBeDefined();
    expect(csp).toMatch(/frame-ancestors\s+'none'/);
  });

  it('approval surface locks down powerful sensors via Permissions-Policy', () => {
    const pp = metaContent(readFileSync(APPROVAL_HTML, 'utf8'), 'Permissions-Policy');
    expect(pp, 'approval HTML must carry a Permissions-Policy meta tag').toBeDefined();
    for (const sensor of ['camera', 'microphone', 'geolocation', 'usb']) {
      expect(pp, `${sensor} must be denied`).toContain(`${sensor}=()`);
    }
  });
});
