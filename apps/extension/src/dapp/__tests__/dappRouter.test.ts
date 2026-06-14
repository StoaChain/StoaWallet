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
  type DappRouter,
  type DappTabMessenger,
} from '../dappRouter';
import {
  makeConnectRequest,
  makeCheckStatusRequest,
  makeQuickSignRequest,
  makeDisconnectRequest,
  type CommandSigData,
  type DappRequest,
} from '../protocol';

/**
 * Trust-boundary tests for the dApp request router.
 *
 * The store + limiter are REAL (over an in-memory adapter); only the EXTERNAL
 * seams are doubles: the chrome.runtime sender, the approval window-open
 * gateway (T9.7), the background command-signer (XP-4), and the
 * chrome.tabs.sendMessage event messenger. This pins the router's gating /
 * approval / no-bait-and-switch / XP-3 / event-routing contracts independent of
 * the (separately-tested) UI and signing internals.
 */

const RUNTIME_ID = 'stoawallet-extension-id';

/** A simple in-memory StorageAdapter double. */
function memAdapter(): StorageAdapter & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string | Uint8Array) {
      store.set(key, typeof value === 'string' ? value : new TextDecoder().decode(value));
    },
    async remove(key: string) {
      store.delete(key);
    },
  };
}

/** A trusted page sender: this extension's id + a real web origin. */
function pageSender(
  origin: string,
  tabId = 7,
  tabUrl = `${origin}/page`,
): chrome.runtime.MessageSender {
  return {
    id: RUNTIME_ID,
    origin,
    url: `${origin}/page`,
    tab: { id: tabId, url: tabUrl } as chrome.tabs.Tab,
  } as chrome.runtime.MessageSender;
}

/**
 * A controllable approval gateway double: records the intents it was asked to
 * open and lets the test resolve/reject/close each pending approval by nonce.
 */
function makeApprovalGateway(): ApprovalGateway & {
  opened: ApprovalRequest[];
  resolveLast(result: Omit<ApprovalResult, 'nonce'>): void;
  resolveByNonce(nonce: string, result: Omit<ApprovalResult, 'nonce'>): void;
  pendingNonces(): string[];
} {
  const opened: ApprovalRequest[] = [];
  const resolvers = new Map<string, (r: ApprovalResult) => void>();

  return {
    opened,
    open(request: ApprovalRequest): Promise<ApprovalResult> {
      opened.push(request);
      return new Promise<ApprovalResult>((resolve) => {
        resolvers.set(request.nonce, resolve);
      });
    },
    resolveLast(result) {
      const last = opened[opened.length - 1];
      const fn = resolvers.get(last.nonce);
      if (fn) {
        resolvers.delete(last.nonce);
        fn({ ...result, nonce: last.nonce });
      }
    },
    resolveByNonce(nonce, result) {
      const fn = resolvers.get(nonce);
      if (fn) {
        resolvers.delete(nonce);
        fn({ ...result, nonce });
      }
    },
    pendingNonces() {
      return [...resolvers.keys()];
    },
  };
}

const CMD_A: CommandSigData = {
  cmd: JSON.stringify({ payload: { exec: { code: '(a)' } }, nonce: 'A' }),
  sigs: [{ pubKey: 'pub-a', sig: null }],
};
const CMD_B: CommandSigData = {
  cmd: JSON.stringify({ payload: { exec: { code: '(b)' } }, nonce: 'B' }),
  sigs: [{ pubKey: 'pub-b', sig: null }],
};

/** A signer double that fills each requested sig and reports the token it saw. */
function makeSigner(): CommandSigner & {
  calls: { cmds: readonly CommandSigData[]; token: string }[];
  locked: boolean;
} {
  const calls: { cmds: readonly CommandSigData[]; token: string }[] = [];
  return {
    calls,
    locked: false,
    async sign(cmds, token) {
      calls.push({ cmds, token });
      if (this.locked) {
        return { ok: false, reason: 'locked' };
      }
      return {
        ok: true,
        responses: cmds.map((c) => ({
          commandSigData: {
            cmd: c.cmd,
            sigs: c.sigs.map((s) => ({ pubKey: s.pubKey, sig: `sig(${c.cmd})` })),
          },
          outcome: { result: 'success' as const, hash: `hash(${c.cmd})` },
        })),
      };
    },
  };
}

/** Flush microtasks until `predicate` holds (condition-based, not a fixed count). */
async function waitFor(predicate: () => boolean, label = 'condition'): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function makeMessenger(): DappTabMessenger & {
  sent: { tabId: number; message: unknown }[];
} {
  const sent: { tabId: number; message: unknown }[] = [];
  return {
    sent,
    sendToTab(tabId, message) {
      sent.push({ tabId, message });
    },
  };
}

interface Harness {
  router: DappRouter;
  store: DAppPermissionStore;
  limiter: RequestRateLimiter;
  adapter: ReturnType<typeof memAdapter>;
  approvals: ReturnType<typeof makeApprovalGateway>;
  signer: ReturnType<typeof makeSigner>;
  messenger: ReturnType<typeof makeMessenger>;
}

async function boot(opts: { now?: () => number } = {}): Promise<Harness> {
  const adapter = memAdapter();
  const store = await DAppPermissionStore.load(adapter);
  const limiter = new RequestRateLimiter(opts.now ? { now: opts.now } : {});
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
    networkId: 'stoachain',
    grantedAccounts: [{ address: 'k:pub-a', publicKey: 'pub-a' }],
    approvalTimeoutMs: 50,
  });

  return { router, store, limiter, adapter, approvals, signer, messenger };
}

describe('dappRouter — trust boundary', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('(a) rejects a foreign sender (sender.id !== runtime.id) WITHOUT signing or prompting', async () => {
    const { router, approvals, signer } = await boot();
    const foreign = { id: 'evil-ext', origin: 'https://app.test' } as chrome.runtime.MessageSender;

    const res = await router.handle(makeQuickSignRequest('1', 'stoachain', [CMD_A]), foreign);

    expect(res).toEqual({ id: '1', method: 'kda_requestQuickSign', status: 'fail', reason: 'invalid-request' });
    expect(approvals.opened).toHaveLength(0);
    expect(signer.calls).toHaveLength(0);
  });

  it('(a2) rejects a sender with NO origin (un-grantable) without signing', async () => {
    const { router, signer } = await boot();
    const noOrigin = { id: RUNTIME_ID } as chrome.runtime.MessageSender;

    const res = await router.handle(makeConnectRequest('1', 'stoachain'), noOrigin);

    expect(res.status).toBe('fail');
    if (res.status === 'fail') expect(res.reason).toBe('invalid-request');
    expect(signer.calls).toHaveLength(0);
  });

  it('(b) a sign from an UNCONNECTED origin is origin-not-allowed and never invokes the signer or an approval', async () => {
    const { router, signer, approvals } = await boot();

    const res = await router.handle(
      makeQuickSignRequest('9', 'stoachain', [CMD_A]),
      pageSender('https://unconnected.test'),
    );

    expect(res).toEqual({ id: '9', method: 'kda_requestQuickSign', status: 'fail', reason: 'origin-not-allowed' });
    expect(signer.calls).toHaveLength(0);
    expect(approvals.opened).toHaveLength(0);
  });

  it('(c) a payload-spoofed origin is gated by the REAL sender.origin, not the page claim', async () => {
    const { router, store, signer } = await boot();
    // Connect (and approve) ONLY good.test.
    await store.allow('https://good.test', undefined, 7);

    // The page claims good.test in its payload, but the verified sender.origin is evil.test.
    const spoofed = { ...makeQuickSignRequest('3', 'stoachain', [CMD_A]), origin: 'https://good.test' } as DappRequest;
    const res = await router.handle(spoofed, pageSender('https://evil.test'));

    expect(res.status).toBe('fail');
    if (res.status === 'fail') expect(res.reason).toBe('origin-not-allowed');
    expect(signer.calls).toHaveLength(0);
  });

  it('(c2) an iframe whose sender.origin differs from sender.tab.url is gated on sender.origin', async () => {
    const { router, store, signer, approvals } = await boot();
    // Grant the IFRAME origin, not the top-frame origin.
    await store.allow('https://widget.test', undefined, 7);

    // sender.tab.url is the TOP frame (top.test); sender.origin is the iframe (widget.test).
    const sender = pageSender('https://widget.test', 7, 'https://top.test/host');
    const p = router.handle(makeQuickSignRequest('4', 'stoachain', [CMD_A]), sender);
    // It reached approval (origin allowed) → approve and assert it signed.
    await waitFor(() => approvals.opened.length === 1, 'iframe sign window');
    approvals.resolveLast({ approved: true, approvalToken: 'tok' });
    const res = await p;

    expect(res.status).toBe('success');
    expect(signer.calls).toHaveLength(1);
  });

  it('(d) kda_connect routes to approval; on APPROVE it allows the origin and returns the granted accounts', async () => {
    const { router, store, approvals } = await boot();

    const p = router.handle(makeConnectRequest('c1', 'stoachain'), pageSender('https://app.test', 12));
    await waitFor(() => approvals.opened.length === 1, 'connect window');
    expect(approvals.opened).toHaveLength(1);
    expect(approvals.opened[0].kind).toBe('connect');
    approvals.resolveLast({ approved: true, accounts: ['k:pub-a'] });
    const res = await p;

    expect(res).toMatchObject({ id: 'c1', method: 'kda_connect', status: 'success', accounts: ['k:pub-a'] });
    expect(await store.isAllowed('https://app.test')).toBe(true);
    expect(await store.tabIdsForOrigin('https://app.test')).toContain(12);
  });

  it('(d2) a kda_connect REJECT (or window close) returns user-rejected and does NOT allow the origin', async () => {
    const { router, store, approvals } = await boot();

    const p = router.handle(makeConnectRequest('c2', 'stoachain'), pageSender('https://app.test'));
    await waitFor(() => approvals.opened.length === 1, 'connect reject window');
    approvals.resolveLast({ approved: false });
    const res = await p;

    expect(res).toMatchObject({ id: 'c2', method: 'kda_connect', status: 'fail', reason: 'user-rejected' });
    expect(await store.isAllowed('https://app.test')).toBe(false);
  });

  it('(d3) a connect approval that never resolves times out as user-rejected', async () => {
    const { router, store } = await boot();
    // approvalTimeoutMs is 50ms; never resolve the gateway.
    const res = await router.handle(makeConnectRequest('c3', 'stoachain'), pageSender('https://slow.test'));

    expect(res).toMatchObject({ status: 'fail', reason: 'user-rejected' });
    expect(await store.isAllowed('https://slow.test')).toBe(false);
  });

  it('(e) an over-cap origin is rate-limited WITHOUT opening an approval window', async () => {
    const { router, store, approvals } = await boot();
    await store.allow('https://busy.test', undefined, 7);

    // Drive 10 connects through (the cap), resolving each as reject so they complete.
    for (let i = 0; i < 10; i += 1) {
      const target = approvals.opened.length + 1;
      const p = router.handle(makeConnectRequest(`b${i}`, 'stoachain'), pageSender('https://busy.test'));
      await waitFor(() => approvals.opened.length === target, `busy window ${i}`);
      approvals.resolveLast({ approved: false });
      await p;
    }
    const before = approvals.opened.length;

    const res = await router.handle(makeConnectRequest('b10', 'stoachain'), pageSender('https://busy.test'));

    expect(res).toMatchObject({ status: 'fail', reason: 'rate-limited' });
    expect(approvals.opened.length).toBe(before); // no NEW window opened
  });

  it('(e2) RR#9: the limiter state persists to DAPP_RATELIMIT_KEY and survives a simulated respawn', async () => {
    let t = 1_000;
    const now = () => t;
    const { router, store, adapter, approvals } = await boot({ now });
    await store.allow('https://persist.test', undefined, 7);

    for (let i = 0; i < 10; i += 1) {
      const target = approvals.opened.length + 1;
      const p = router.handle(makeConnectRequest(`p${i}`, 'stoachain'), pageSender('https://persist.test'));
      await waitFor(() => approvals.opened.length === target, `persist window ${i}`);
      approvals.resolveLast({ approved: false });
      await p;
    }

    // The accounted state was persisted under the canonical key.
    expect(adapter.store.has(DAPP_RATELIMIT_KEY)).toBe(true);

    // Respawn: a brand-new limiter rehydrated from the SAME adapter, same clock window.
    const limiter2 = new RequestRateLimiter({ now });
    const router2 = createDappRouter({
      store,
      limiter: limiter2,
      adapter,
      approvals,
      signer: makeSigner(),
      messenger: makeMessenger(),
      runtimeId: RUNTIME_ID,
      networkId: 'stoachain',
      grantedAccounts: [],
      approvalTimeoutMs: 50,
    });
    await router2.hydrate();

    const res = await router2.handle(makeConnectRequest('p10', 'stoachain'), pageSender('https://persist.test'));
    expect(res).toMatchObject({ status: 'fail', reason: 'rate-limited' });
  });

  it('(f) an approved commandSigDatas sign returns the SIGNED responses (XP-4) with NO key field', async () => {
    const { router, store, approvals, signer } = await boot();
    await store.allow('https://dapp.test', undefined, 7);

    const p = router.handle(
      makeQuickSignRequest('s1', 'stoachain', [CMD_A]),
      pageSender('https://dapp.test'),
    );
    await waitFor(() => approvals.opened.length === 1, 'sign window');
    expect(approvals.opened[0].kind).toBe('sign');
    approvals.resolveLast({ approved: true, approvalToken: 'tok-1' });
    const res = await p;

    expect(res.status).toBe('success');
    if (res.status === 'success' && res.method === 'kda_requestQuickSign') {
      expect(res.responses).toHaveLength(1);
      expect(res.responses[0].outcome.result).toBe('success');
      expect(res.responses[0].commandSigData.sigs[0].sig).toBeTruthy();
    }
    // The signer received the FROZEN cmd and the minted approval token (XP-3).
    expect(signer.calls).toHaveLength(1);
    expect(signer.calls[0].token).toBe('tok-1');
    // SECRET-FREE: nothing key-shaped crosses back.
    const flat = JSON.stringify(res);
    expect(flat).not.toContain('privateKey');
    expect(flat).not.toContain('secretKey');
    expect(flat).not.toContain('mnemonic');
  });

  it('(f2) a locked vault on an approved sign returns {status:fail, reason:locked}', async () => {
    const { router, store, approvals, signer } = await boot();
    await store.allow('https://dapp.test', undefined, 7);
    signer.locked = true;

    const p = router.handle(
      makeQuickSignRequest('s2', 'stoachain', [CMD_A]),
      pageSender('https://dapp.test'),
    );
    await waitFor(() => approvals.opened.length === 1, 'locked sign window');
    approvals.resolveLast({ approved: true, approvalToken: 'tok-2' });
    const res = await p;

    expect(res).toMatchObject({ status: 'fail', reason: 'locked' });
  });

  it('NO BAIT-AND-SWITCH: the exact cmd shown in the approval preview is the cmd handed to the signer', async () => {
    const { router, store, approvals, signer } = await boot();
    await store.allow('https://dapp.test', undefined, 7);

    const p = router.handle(
      makeQuickSignRequest('s3', 'stoachain', [CMD_A, CMD_B]),
      pageSender('https://dapp.test'),
    );
    await waitFor(() => approvals.opened.length === 1, 'bait-switch sign window');
    const previewed = approvals.opened[0];
    expect(previewed.kind).toBe('sign');
    approvals.resolveLast({ approved: true, approvalToken: 'tok-3' });
    await p;

    // The previewed command(s) and the signed command(s) are byte-identical (the
    // SAME frozen snapshot) — no re-read could have swapped them between.
    const previewedCmds = previewed.kind === 'sign' ? previewed.commandSigDatas.map((c) => c.cmd) : [];
    const signedCmds = signer.calls[0].cmds.map((c) => c.cmd);
    expect(signedCmds).toEqual(previewedCmds);
    expect(signedCmds).toEqual([CMD_A.cmd, CMD_B.cmd]);
  });

  it('(g) XP-3 token replay: a second sign with a consumed token is rejected and never signs again', async () => {
    const { router, store, approvals, signer } = await boot();
    await store.allow('https://dapp.test', undefined, 7);

    const p1 = router.handle(makeQuickSignRequest('r1', 'stoachain', [CMD_A]), pageSender('https://dapp.test'));
    await waitFor(() => approvals.opened.length === 1, 'replay sign window');
    approvals.resolveLast({ approved: true, approvalToken: 'reused' });
    await p1;
    expect(signer.calls).toHaveLength(1);

    // Replay the SAME approval token directly against the consume path.
    const replay = await router.consumeApprovedSign({
      id: 'r1-replay',
      origin: 'https://dapp.test',
      approvalToken: 'reused',
      commandSigDatas: [CMD_A],
    });

    expect(replay.status).toBe('fail');
    if (replay.status === 'fail') expect(replay.reason).toBe('user-rejected');
    expect(signer.calls).toHaveLength(1); // NOT a second signature
  });

  it('(h) RR#2: two concurrent approvals never cross-resolve — APPROVE for A cannot grant B', async () => {
    const { router, store, approvals } = await boot();

    const pA = router.handle(makeConnectRequest('A', 'stoachain'), pageSender('https://a.test', 1));
    const pB = router.handle(makeConnectRequest('B', 'stoachain'), pageSender('https://b.test', 2));
    await waitFor(() => approvals.opened.length === 2, 'two concurrent windows');

    expect(approvals.opened).toHaveLength(2);
    const nonceA = approvals.opened[0].nonce;
    const nonceB = approvals.opened[1].nonce;
    expect(nonceA).not.toBe(nonceB);

    // Approve ONLY A's nonce.
    approvals.resolveByNonce(nonceA, { approved: true, accounts: ['k:pub-a'] });
    const resA = await pA;
    expect(resA.status).toBe('success');
    expect(await store.isAllowed('https://a.test')).toBe(true);
    // B is still pending and NOT granted.
    expect(await store.isAllowed('https://b.test')).toBe(false);

    approvals.resolveByNonce(nonceB, { approved: false });
    const resB = await pB;
    expect(resB.status).toBe('fail');
    expect(await store.isAllowed('https://b.test')).toBe(false);
  });

  it('(i) RR#11: an active-account switch emits accountsChanged to the connected origin tab ONLY', async () => {
    const { router, store, messenger } = await boot();
    await store.allow('https://connected.test', undefined, 21);
    await store.allow('https://other.test', undefined, 99);

    await router.notifyAccountsChanged('https://connected.test', ['k:pub-a']);

    expect(messenger.sent).toEqual([
      { tabId: 21, message: { event: 'accountsChanged', accounts: ['k:pub-a'] } },
    ]);
    // The unrelated tab (99) received nothing.
    expect(messenger.sent.some((m) => m.tabId === 99)).toBe(false);
  });

  it('(i2) RR#12: a page-initiated disconnect affects ONLY the verified sender origin (A cannot disconnect B)', async () => {
    const { router, store, messenger } = await boot();
    await store.allow('https://a.test', undefined, 1);
    await store.allow('https://b.test', undefined, 2);

    // Page A sends disconnect; even a spoofed payload cannot name B — only sender.origin matters.
    const res = await router.handle(makeDisconnectRequest('d1'), pageSender('https://a.test', 1));

    expect(res).toMatchObject({ id: 'd1', method: 'kda_disconnect', status: 'success' });
    expect(await store.isAllowed('https://a.test')).toBe(false);
    expect(await store.isAllowed('https://b.test')).toBe(true); // B untouched
    // The disconnect event went to A's tab only.
    expect(messenger.sent).toEqual([{ tabId: 1, message: { event: 'disconnect' } }]);
  });

  it('(k) connect default accounts come from a DYNAMIC accountsProvider read at request time, not a static snapshot', async () => {
    // The provider's value changes AFTER router construction (the wallet unlocked
    // / switched account). A static capture would expose the stale set; the
    // request-time read must expose the current one.
    const adapter = memAdapter();
    const store = await DAppPermissionStore.load(adapter);
    let current: readonly { address: string; publicKey: string }[] = [];
    const approvals = makeApprovalGateway();
    const router = createDappRouter({
      store,
      limiter: new RequestRateLimiter(),
      adapter,
      approvals,
      signer: makeSigner(),
      messenger: makeMessenger(),
      runtimeId: RUNTIME_ID,
      networkId: 'stoachain',
      grantedAccounts: [],
      accountsProvider: () => current,
      approvalTimeoutMs: 50,
    });

    // Unlock happens after construction: the active account is now known.
    current = [{ address: 'k:live-active', publicKey: 'live-active' }];

    const p = router.handle(makeConnectRequest('k1', 'stoachain'), pageSender('https://app.test', 4));
    await waitFor(() => approvals.opened.length === 1, 'dynamic connect window');
    // The gateway approve carries NO accounts override → router falls back to the
    // provider's CURRENT value, not the empty construction-time snapshot.
    approvals.resolveLast({ approved: true });
    const res = await p;

    expect(res).toMatchObject({ status: 'success', accounts: ['k:live-active'] });
  });

  it('(l) connect PERSISTS the user-approved subset, and checkStatus returns exactly that subset for the origin', async () => {
    const adapter = memAdapter();
    const store = await DAppPermissionStore.load(adapter);
    const approvals = makeApprovalGateway();
    const router = createDappRouter({
      store,
      limiter: new RequestRateLimiter(),
      adapter,
      approvals,
      signer: makeSigner(),
      messenger: makeMessenger(),
      runtimeId: RUNTIME_ID,
      networkId: 'stoachain',
      grantedAccounts: [],
      // The wallet currently has TWO accounts available...
      accountsProvider: () => [
        { address: 'k:acct-1', publicKey: 'acct-1' },
        { address: 'k:acct-2', publicKey: 'acct-2' },
      ],
      approvalTimeoutMs: 50,
    });

    const p = router.handle(makeConnectRequest('l1', 'stoachain'), pageSender('https://sub.test', 3));
    await waitFor(() => approvals.opened.length === 1, 'subset connect window');
    // ...but the user approved exposing ONLY acct-1.
    approvals.resolveLast({ approved: true, accounts: ['k:acct-1'] });
    const res = await p;

    expect(res).toMatchObject({ status: 'success', accounts: ['k:acct-1'] });

    // checkStatus for the connected origin must return the APPROVED subset, not
    // the full wallet set and not a static global.
    const status = await router.handle(makeCheckStatusRequest('l2', 'stoachain'), pageSender('https://sub.test', 3));
    expect(status).toMatchObject({ status: 'success', accounts: ['k:acct-1'] });
    expect((status as { accounts?: string[] }).accounts).not.toContain('k:acct-2');
  });

  it('(m) checkStatus for an UNCONNECTED origin returns success with NO accounts', async () => {
    const { router } = await boot();
    const status = await router.handle(
      makeCheckStatusRequest('m1', 'stoachain'),
      pageSender('https://stranger.test'),
    );
    expect(status).toMatchObject({ status: 'success' });
    expect((status as { accounts?: string[] }).accounts).toBeUndefined();
  });

  it('(n) H2: notifyAccountsChanged emits ONLY public k: accounts — a non-k: entry is filtered out', async () => {
    const { router, store, messenger } = await boot();
    await store.allow('https://filter.test', undefined, 30);

    // A defense-in-depth boundary: even if a caller passes a non-public address,
    // only the k: accounts cross to the page.
    await router.notifyAccountsChanged('https://filter.test', ['k:good', 'w:bad-multisig', '']);

    expect(messenger.sent).toEqual([
      { tabId: 30, message: { event: 'accountsChanged', accounts: ['k:good'] } },
    ]);
  });

  it('(j) never console-logs a secret across connect → sign', async () => {
    const { router, approvals } = await boot();
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );

    const pc = router.handle(makeConnectRequest('jc', 'stoachain'), pageSender('https://dapp.test', 7));
    await waitFor(() => approvals.opened.length === 1, 'console connect window');
    approvals.resolveLast({ approved: true, accounts: ['k:pub-a'] });
    await pc;

    const ps = router.handle(makeQuickSignRequest('js', 'stoachain', [CMD_A]), pageSender('https://dapp.test', 7));
    await waitFor(() => approvals.opened.length === 2, 'console sign window');
    approvals.resolveLast({ approved: true, approvalToken: 'tok-j' });
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
});
