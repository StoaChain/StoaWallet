import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createChromeApprovalGateway,
  type ApprovalWindowsApi,
  type ApprovalRuntimeApi,
} from '../chromeApprovalGateway';
import { createApprovalTokenRegistry } from '../approvalTokens';
import type { ApprovalRequest } from '../../dapp/dappRouter';

/**
 * Production approval-gateway tests — the seam that opens the real
 * `chrome.windows.create` popup, decodes the user's `approval-decision`, and
 * reconciles a dismissed window to a reject (RR#13). Only the chrome boundary is
 * doubled; the gateway logic (URL params, nonce match, token mint, cleanup) is
 * REAL.
 */

const APPROVAL_URL = 'chrome-extension://stoa-id/src/approval/approval.html';
const NETWORK_ID = 'stoachain';

/** A controllable `chrome.windows` double recording created/removed windows. */
function makeWindows(): ApprovalWindowsApi & {
  created: { url: string; type: string }[];
  removed: number[];
  emitRemoved(windowId: number): void;
  lastWindowId: number;
} {
  const created: { url: string; type: string }[] = [];
  const removed: number[] = [];
  const removedListeners = new Set<(windowId: number) => void>();
  let nextId = 100;
  let lastWindowId = 0;

  return {
    created,
    removed,
    get lastWindowId() {
      return lastWindowId;
    },
    emitRemoved(windowId: number) {
      for (const fn of removedListeners) fn(windowId);
    },
    async create(opts: { url: string; type: string }) {
      created.push({ url: opts.url, type: opts.type });
      lastWindowId = nextId;
      nextId += 1;
      return { id: lastWindowId };
    },
    async remove(windowId: number) {
      removed.push(windowId);
    },
    onRemoved: {
      addListener(fn: (windowId: number) => void) {
        removedListeners.add(fn);
      },
      removeListener(fn: (windowId: number) => void) {
        removedListeners.delete(fn);
      },
    },
  };
}

/** A controllable `chrome.runtime.onMessage` double the test drives decisions through. */
function makeRuntime(): ApprovalRuntimeApi & {
  emit(message: unknown): void;
  listenerCount(): number;
} {
  const listeners = new Set<(message: unknown) => void>();
  return {
    emit(message: unknown) {
      for (const fn of [...listeners]) fn(message);
    },
    listenerCount() {
      return listeners.size;
    },
    onMessage: {
      addListener(fn: (message: unknown) => void) {
        listeners.add(fn);
      },
      removeListener(fn: (message: unknown) => void) {
        listeners.delete(fn);
      },
    },
  };
}

function connectRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    kind: 'connect',
    nonce: 'nonce-connect',
    origin: 'https://app.test',
    tabId: 7,
    networkId: NETWORK_ID,
    ...overrides,
  } as ApprovalRequest;
}

const SIGN_CMD = {
  cmd: JSON.stringify({ payload: { exec: { code: '(transfer)' } }, nonce: 'X' }),
  sigs: [{ pubKey: 'pub-a', sig: null }],
};

function signRequest(): ApprovalRequest {
  return {
    kind: 'sign',
    nonce: 'nonce-sign',
    origin: 'https://app.test',
    tabId: 7,
    networkId: NETWORK_ID,
    commandSigDatas: [SIGN_CMD],
  };
}

function boot(opts: { locked?: boolean; accounts?: string[] } = {}) {
  const windows = makeWindows();
  const runtime = makeRuntime();
  const approvalTokens = createApprovalTokenRegistry();
  const gateway = createChromeApprovalGateway({
    chromeWindows: windows,
    chromeRuntime: runtime,
    approvalTokens,
    getConnectAccounts: () => opts.accounts ?? ['k:pub-a'],
    isLocked: () => opts.locked ?? false,
    approvalUrl: APPROVAL_URL,
  });
  return { gateway, windows, runtime, approvalTokens };
}

describe('chromeApprovalGateway', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens a focused popup window at the approval URL carrying the connect params parseApprovalParams decodes', async () => {
    const { gateway, windows, runtime } = boot();
    const p = gateway.open(connectRequest());
    // Drive the decision so the promise settles for this assertion-of-open.
    runtime.emit({ type: 'approval-decision', decision: { requestId: 'nonce-connect', nonce: 'nonce-connect', approved: false } });
    await p;

    expect(windows.created).toHaveLength(1);
    const { url, type } = windows.created[0];
    expect(type).toBe('popup');
    const params = new URL(url).searchParams;
    expect(url.startsWith(APPROVAL_URL)).toBe(true);
    expect(params.get('kind')).toBe('connect');
    expect(params.get('nonce')).toBe('nonce-connect');
    expect(params.get('id')).toBe('nonce-connect');
    expect(params.get('origin')).toBe('https://app.test');
    expect(params.get('networkId')).toBe(NETWORK_ID);
  });

  it('encodes the FROZEN commandSigDatas as JSON in the sign params so the preview shows the exact cmd', async () => {
    const { gateway, windows, runtime } = boot();
    const p = gateway.open(signRequest());
    runtime.emit({ type: 'approval-decision', decision: { requestId: 'nonce-sign', nonce: 'nonce-sign', approved: false } });
    await p;

    const params = new URL(windows.created[0].url).searchParams;
    expect(params.get('kind')).toBe('sign');
    const decoded = JSON.parse(params.get('commandSigDatas') as string);
    expect(decoded).toEqual([SIGN_CMD]);
  });

  it('passes locked=1 when the vault is locked at open time, and omits it when unlocked', async () => {
    const lockedBoot = boot({ locked: true });
    const lp = lockedBoot.gateway.open(connectRequest());
    lockedBoot.runtime.emit({ type: 'approval-decision', decision: { requestId: 'nonce-connect', nonce: 'nonce-connect', approved: false } });
    await lp;
    expect(new URL(lockedBoot.windows.created[0].url).searchParams.get('locked')).toBe('1');

    const unlockedBoot = boot({ locked: false });
    const up = unlockedBoot.gateway.open(connectRequest());
    unlockedBoot.runtime.emit({ type: 'approval-decision', decision: { requestId: 'nonce-connect', nonce: 'nonce-connect', approved: false } });
    await up;
    expect(new URL(unlockedBoot.windows.created[0].url).searchParams.get('locked')).not.toBe('1');
  });

  it('on a connect APPROVE resolves with the current active accounts from getConnectAccounts', async () => {
    const { gateway, runtime } = boot({ accounts: ['k:active-1'] });
    const p = gateway.open(connectRequest());
    runtime.emit({ type: 'approval-decision', decision: { requestId: 'nonce-connect', nonce: 'nonce-connect', approved: true } });
    const result = await p;

    expect(result).toMatchObject({ nonce: 'nonce-connect', approved: true, accounts: ['k:active-1'] });
  });

  it('on a sign APPROVE mints a single-use token from the shared registry and resolves it', async () => {
    const { gateway, runtime, approvalTokens } = boot();
    const consumeSpy = vi.spyOn(approvalTokens, 'mint');
    const p = gateway.open(signRequest());
    runtime.emit({ type: 'approval-decision', decision: { requestId: 'nonce-sign', nonce: 'nonce-sign', approved: true } });
    const result = await p;

    expect(consumeSpy).toHaveBeenCalledTimes(1);
    expect(result.approved).toBe(true);
    expect(result.approvalToken).toBeTruthy();
    // The token resolves is consumable EXACTLY once from the same registry (XP-3).
    expect(approvalTokens.consume(result.approvalToken as string)).toBe(true);
    expect(approvalTokens.consume(result.approvalToken as string)).toBe(false);
  });

  it('on a REJECT decision resolves {approved:false} and mints NO token', async () => {
    const { gateway, runtime, approvalTokens } = boot();
    const mintSpy = vi.spyOn(approvalTokens, 'mint');
    const p = gateway.open(signRequest());
    runtime.emit({ type: 'approval-decision', decision: { requestId: 'nonce-sign', nonce: 'nonce-sign', approved: false } });
    const result = await p;

    expect(result).toEqual({ nonce: 'nonce-sign', approved: false });
    expect(mintSpy).not.toHaveBeenCalled();
  });

  it('RR#2: a decision whose nonce does NOT match is IGNORED — the window stays open until the matching nonce arrives', async () => {
    const { gateway, runtime } = boot();
    let settled = false;
    const p = gateway.open(connectRequest()).then((r) => {
      settled = true;
      return r;
    });

    // A decision for a DIFFERENT nonce must not resolve this request.
    runtime.emit({ type: 'approval-decision', decision: { requestId: 'other', nonce: 'other-nonce', approved: true } });
    await Promise.resolve();
    expect(settled).toBe(false);

    // The matching nonce resolves it.
    runtime.emit({ type: 'approval-decision', decision: { requestId: 'nonce-connect', nonce: 'nonce-connect', approved: true } });
    const result = await p;
    expect(result.nonce).toBe('nonce-connect');
    expect(result.approved).toBe(true);
  });

  it('RR#13: a window closed BEFORE any decision resolves {approved:false} (dismiss = reject)', async () => {
    const { gateway, windows } = boot();
    const p = gateway.open(connectRequest());
    // The created window is dismissed by the user with no decision sent.
    windows.emitRemoved(windows.lastWindowId);
    const result = await p;

    expect(result).toEqual({ nonce: 'nonce-connect', approved: false });
  });

  it('cleans up its runtime + onRemoved listeners and closes the window on settle (no leak)', async () => {
    const { gateway, windows, runtime } = boot();
    const p = gateway.open(connectRequest());
    expect(runtime.listenerCount()).toBe(1);
    runtime.emit({ type: 'approval-decision', decision: { requestId: 'nonce-connect', nonce: 'nonce-connect', approved: true } });
    await p;

    // Both listeners detached and the popup explicitly closed.
    expect(runtime.listenerCount()).toBe(0);
    expect(windows.removed).toContain(windows.lastWindowId);
  });

  it('a LATE second decision after settle does not double-resolve or re-touch the window', async () => {
    const { gateway, windows, runtime } = boot();
    const p = gateway.open(connectRequest());
    runtime.emit({ type: 'approval-decision', decision: { requestId: 'nonce-connect', nonce: 'nonce-connect', approved: true } });
    await p;
    const removedCount = windows.removed.length;

    // A replayed decision after the listener was removed is a no-op (idempotent settle).
    runtime.emit({ type: 'approval-decision', decision: { requestId: 'nonce-connect', nonce: 'nonce-connect', approved: false } });
    await Promise.resolve();
    expect(windows.removed.length).toBe(removedCount);
  });
});
