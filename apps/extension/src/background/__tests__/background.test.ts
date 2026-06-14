import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KeyringManager } from '@stoawallet/core';
import { InMemoryKeyVault } from '@stoawallet/core/testing';

// The SDK's blake2b-256 base64url hasher. Its ESM `.d.ts` is empty in this
// build of @stoachain/kadena-stoic-legacy (only the `.d.cts` declares it), so
// the named export is typed locally; the runtime resolves it from the `.cjs`.
import * as cryptoUtils from '@stoachain/kadena-stoic-legacy/cryptography-utils';

import { ChromeStorageAdapter } from '../../storage/ChromeStorageAdapter';

const hashCmd = (cryptoUtils as unknown as { hash: (str: string) => string }).hash;
import type { Request, Response } from '../../messaging/protocol';
import { createBackground, type Background } from '../createBackground';

/**
 * Integration tests for the MV3 background service worker — the SECURE context.
 *
 * The KeyringManager + KeyVault + the @stoachain crypto run for REAL: a wallet is
 * created (which seals a real V2 envelope into chrome.storage.local through the
 * real ChromeStorageAdapter), then unlocked/signed/locked, so the tests exercise
 * the actual decrypt → derive → sign path. Only the EXTERNAL chrome boundary is a
 * double: `chrome.storage.local`, `chrome.runtime.id`, and `chrome.idle` (its
 * `onStateChanged` listeners + `setDetectionInterval`). configureNode is injected
 * as a spy so the off-network boot path is asserted without hitting the SDK
 * failover health probe.
 */

const PASSWORD = 'correct horse battery staple';
const RUNTIME_ID = 'stoawallet-extension-id';

interface ChromeIdleDouble {
  emit(state: 'active' | 'idle' | 'locked'): void;
  detectionInterval: number | null;
  listenerCount(): number;
}

interface ChromeDouble {
  store: Map<string, unknown>;
  idle: ChromeIdleDouble;
}

function installChromeDouble(): ChromeDouble {
  const store = new Map<string, unknown>();
  const idleListeners = new Set<(state: string) => void>();
  let detectionInterval: number | null = null;

  const chrome = {
    runtime: { id: RUNTIME_ID },
    storage: {
      local: {
        async get(keys: string | string[] | null) {
          const out: Record<string, unknown> = {};
          const list =
            keys == null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
          for (const k of list) if (store.has(k)) out[k] = store.get(k);
          return out;
        },
        async set(items: Record<string, unknown>) {
          for (const [k, v] of Object.entries(items)) store.set(k, v);
        },
        async remove(keys: string | string[]) {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) store.delete(k);
        },
      },
    },
    idle: {
      setDetectionInterval(seconds: number) {
        detectionInterval = seconds;
      },
      onStateChanged: {
        addListener(fn: (state: string) => void) {
          idleListeners.add(fn);
        },
        removeListener(fn: (state: string) => void) {
          idleListeners.delete(fn);
        },
      },
    },
  };

  (globalThis as unknown as { chrome: unknown }).chrome = chrome;

  return {
    store,
    idle: {
      emit(state) {
        for (const fn of idleListeners) fn(state);
      },
      get detectionInterval() {
        return detectionInterval;
      },
      listenerCount() {
        return idleListeners.size;
      },
    },
  };
}

/** A trusted sender: same extension id as `chrome.runtime.id`. */
const TRUSTED_SENDER = { id: RUNTIME_ID } as chrome.runtime.MessageSender;

/** Build a real manager over the chrome-backed storage + a real in-memory KeyVault. */
function makeManager(): { manager: KeyringManager; keyVault: InMemoryKeyVault } {
  const keyVault = new InMemoryKeyVault();
  const manager = new KeyringManager({
    storage: new ChromeStorageAdapter(),
    keyVault,
  });
  return { manager, keyVault };
}

/** Send through the background and await the (async) sendResponse value. */
function dispatch(bg: Background, message: Request, sender = TRUSTED_SENDER): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const returned = bg.handleMessage(message, sender, (res) => resolve(res as Response));
    // The MV3 contract: the listener must return `true` to keep the channel open
    // for the async sendResponse. A non-true return would close it and the popup
    // would never receive the reply.
    if (returned !== true) {
      reject(new Error(`handleMessage must return true for async sendResponse, got ${String(returned)}`));
    }
  });
}

describe('background service worker', () => {
  let chromeDouble: ChromeDouble;
  let configureNodeSpy: ReturnType<typeof vi.fn<(storage: unknown) => Promise<void>>>;

  beforeEach(() => {
    chromeDouble = installChromeDouble();
    configureNodeSpy = vi.fn<(storage: unknown) => Promise<void>>(async () => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  /** Seed a real wallet into chrome.storage, then lock it so we start cold-but-stored. */
  async function seedWallet(): Promise<{ walletId: string; address: string; publicKey: string }> {
    const { manager } = makeManager();
    const onboard = await manager.createWallet(PASSWORD);
    await manager.lock();
    return {
      walletId: onboard.walletId,
      address: onboard.account.account,
      publicKey: onboard.account.publicKey,
    };
  }

  function boot(): { bg: Background; keyVault: InMemoryKeyVault; manager: KeyringManager } {
    const { manager, keyVault } = makeManager();
    const bg = createBackground({
      manager,
      keyVault,
      runtimeId: RUNTIME_ID,
      configureNode: configureNodeSpy,
      idleSeconds: 60,
    });
    return { bg, keyVault, manager };
  }

  it('boots by calling configureNode with the chrome-backed storage adapter (XP-13)', async () => {
    const { bg } = boot();
    await bg.start();
    expect(configureNodeSpy).toHaveBeenCalledTimes(1);
    const [adapter] = configureNodeSpy.mock.calls[0];
    expect(adapter).toBeInstanceOf(ChromeStorageAdapter);
  });

  it('registers an idle detection interval and a state-change listener at start', async () => {
    const { bg } = boot();
    await bg.start();
    expect(chromeDouble.idle.detectionInterval).toBe(60);
    expect(chromeDouble.idle.listenerCount()).toBe(1);
  });

  it('unlock with the correct password populates the KeyVault and acks ok', async () => {
    const { walletId } = await seedWallet();
    const { bg, keyVault } = boot();
    await bg.start();

    const res = await dispatch(bg, { type: 'unlock', walletId, password: PASSWORD });

    expect(res).toEqual({ ok: true });
    expect(keyVault.isUnlocked()).toBe(true);
    expect(keyVault.getUnlockedKey()).not.toBeNull();
  });

  it('unlock with the wrong password maps to {ok:false, reason:"wrong-password"} and leaves the vault locked', async () => {
    const { walletId } = await seedWallet();
    const { bg, keyVault } = boot();
    await bg.start();

    const res = await dispatch(bg, { type: 'unlock', walletId, password: 'nope-nope-nope' });

    expect(res).toEqual({ ok: false, reason: 'wrong-password' });
    expect(keyVault.isUnlocked()).toBe(false);
  });

  it('unlock with no stored wallet maps to {ok:false, reason:"no-wallet"}', async () => {
    const { bg } = boot();
    await bg.start();

    const res = await dispatch(bg, { type: 'unlock', walletId: 'wallet-1', password: PASSWORD });

    expect(res).toEqual({ ok: false, reason: 'no-wallet' });
  });

  it('signTx (signerSpec active) after unlock returns a signed tx and NO key field', async () => {
    const { walletId, address, publicKey } = await seedWallet();
    const { bg } = boot();
    await bg.start();
    await dispatch(bg, { type: 'unlock', walletId, password: PASSWORD });

    // The active account's pubkey is a signer on the tx, so the resolved keypair
    // actually attaches a signature — proving the SW signed with the right key.
    // The hash is the SDK blake2b of `cmd`, exactly as the popup would send it.
    const cmd = JSON.stringify({
      payload: { exec: { code: '(+ 1 1)', data: {} } },
      signers: [{ pubKey: publicKey }],
      meta: { chainId: '0', sender: address, gasLimit: 1000, gasPrice: 1e-6, ttl: 600, creationTime: 0 },
      networkId: 'stoachain',
      nonce: 'n',
    });
    const unsigned = { cmd, hash: hashCmd(cmd) };

    const res = await dispatch(bg, {
      type: 'signTx',
      tx: unsigned,
      accountIndex: 0,
      signerSpec: { kind: 'active' },
    });

    expect(res.ok).toBe(true);
    if (res.ok && 'signed' in res) {
      // A signature was attached by the real signer.
      expect(res.signed.cmd).toBe(unsigned.cmd);
      expect(res.signed.sigs?.length ?? 0).toBeGreaterThan(0);
      const firstSig = res.signed.sigs?.[0];
      expect(firstSig?.sig).toBeTruthy();
    }
    // SECRET-FREE: the response object carries no key material whatsoever.
    const flat = JSON.stringify(res);
    expect(flat).not.toContain('privateKey');
    expect(flat).not.toContain('secretKey');
    expect(flat).not.toContain('mnemonic');
    expect(flat).not.toContain('password');
  });

  it('a commandSigDatas signerSpec (XP-4) signs the dApp-supplied cmd in the BACKGROUND and returns the filled sig — never a stub', async () => {
    const { walletId, address, publicKey } = await seedWallet();
    const { bg } = boot();
    await bg.start();
    await dispatch(bg, { type: 'unlock', walletId, password: PASSWORD });

    // The dApp asks the wallet to fill the empty `sig` slot for ITS pubkey on a
    // command the active account is a signer on.
    const cmd = JSON.stringify({
      payload: { exec: { code: '(+ 2 3)', data: {} } },
      signers: [{ pubKey: publicKey }],
      meta: { chainId: '0', sender: address, gasLimit: 1000, gasPrice: 1e-6, ttl: 600, creationTime: 0 },
      networkId: 'stoachain',
      nonce: 'dapp-n',
    });

    const res = await dispatch(bg, {
      type: 'signTx',
      tx: { cmd, hash: hashCmd(cmd) },
      accountIndex: 0,
      signerSpec: { kind: 'commandSigDatas', sigData: { cmd, sigs: [{ pubKey: publicKey, sig: null }] } },
      approvalToken: bg.mintApprovalToken(),
    });

    expect(res.ok).toBe(true);
    if (res.ok && 'signed' in res) {
      // The SAME cmd that was supplied is returned, now with the dApp pubkey's
      // sig slot FILLED by the real background signer — not an unsupported stub.
      expect(res.signed.cmd).toBe(cmd);
      const filled = res.signed.sigs?.find((s) => s?.pubKey === publicKey);
      expect(filled?.sig).toBeTruthy();
    }
    // SECRET-FREE: no key material crosses back.
    const flat = JSON.stringify(res);
    expect(flat).not.toContain('privateKey');
    expect(flat).not.toContain('secretKey');
    expect(flat).not.toContain('mnemonic');
  });

  it('a commandSigDatas sign while LOCKED maps to {ok:false, reason:"locked"} (no sign)', async () => {
    const { bg } = boot();
    await bg.start();

    const cmd = '{"payload":{"exec":{"code":"(+ 1 1)"}}}';
    const res = await dispatch(bg, {
      type: 'signTx',
      tx: { cmd, hash: 'h' },
      accountIndex: 0,
      signerSpec: { kind: 'commandSigDatas', sigData: { cmd, sigs: [{ pubKey: 'p', sig: null }] } },
      approvalToken: 'tok',
    });

    expect(res).toEqual({ ok: false, reason: 'locked' });
  });

  it('XP-3: a signTx carrying an APPROVAL TOKEN consumes it single-use — a replay with the same token is rejected and never signs twice', async () => {
    const { walletId, address, publicKey } = await seedWallet();
    const { bg, manager } = boot();
    await bg.start();
    await dispatch(bg, { type: 'unlock', walletId, password: PASSWORD });

    // Mint a single-use token the background will honor exactly once.
    const token = bg.mintApprovalToken();

    const cmd = JSON.stringify({
      payload: { exec: { code: '(+ 1 1)', data: {} } },
      signers: [{ pubKey: publicKey }],
      meta: { chainId: '0', sender: address, gasLimit: 1000, gasPrice: 1e-6, ttl: 600, creationTime: 0 },
      networkId: 'stoachain',
      nonce: 'replay-n',
    });
    const signMsg: Request = {
      type: 'signTx',
      tx: { cmd, hash: hashCmd(cmd) },
      accountIndex: 0,
      signerSpec: { kind: 'commandSigDatas', sigData: { cmd, sigs: [{ pubKey: publicKey, sig: null }] } },
      approvalToken: token,
    };

    const signSpy = vi.spyOn(manager, 'resolveActiveSigningKeypairs');

    const first = await dispatch(bg, signMsg);
    expect(first.ok).toBe(true);
    expect(signSpy).toHaveBeenCalledTimes(1);

    // Replay the SAME token: the background rejects it and does NOT sign again.
    const replay = await dispatch(bg, signMsg);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe('unauthorized');
    expect(signSpy).toHaveBeenCalledTimes(1); // no second signature
  });

  it('XP-3: a dApp-shaped signTx (commandSigDatas) WITHOUT a valid token is rejected before signing', async () => {
    const { walletId, address, publicKey } = await seedWallet();
    const { bg, manager } = boot();
    await bg.start();
    await dispatch(bg, { type: 'unlock', walletId, password: PASSWORD });

    const cmd = JSON.stringify({
      payload: { exec: { code: '(+ 1 1)' } },
      signers: [{ pubKey: publicKey }],
      meta: { chainId: '0', sender: address, gasLimit: 1000, gasPrice: 1e-6, ttl: 600, creationTime: 0 },
      networkId: 'stoachain',
      nonce: 'no-tok',
    });
    const signSpy = vi.spyOn(manager, 'resolveActiveSigningKeypairs');

    const res = await dispatch(bg, {
      type: 'signTx',
      tx: { cmd, hash: hashCmd(cmd) },
      accountIndex: 0,
      signerSpec: { kind: 'commandSigDatas', sigData: { cmd, sigs: [{ pubKey: publicKey, sig: null }] } },
      approvalToken: 'never-minted',
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('unauthorized');
    expect(signSpy).not.toHaveBeenCalled();
  });

  it('a gas-station signerSpec is not wired yet → {ok:false, reason:"unsupported-signer"}', async () => {
    const { walletId } = await seedWallet();
    const { bg } = boot();
    await bg.start();
    await dispatch(bg, { type: 'unlock', walletId, password: PASSWORD });

    const res = await dispatch(bg, {
      type: 'signTx',
      tx: { cmd: '{}', hash: 'h' },
      accountIndex: 0,
      signerSpec: { kind: 'gas-station', chainId: '0' },
    });

    expect(res).toEqual({ ok: false, reason: 'unsupported-signer' });
  });

  it('a foreign-sender message (sender.id !== runtime.id) is rejected unauthorized and the manager is NOT invoked', async () => {
    const { walletId } = await seedWallet();
    const { bg, manager } = boot();
    await bg.start();

    const unlockSpy = vi.spyOn(manager, 'unlock');
    const signSpy = vi.spyOn(manager, 'resolveActiveSigningKeypairs');

    const foreign = { id: 'some-other-extension' } as chrome.runtime.MessageSender;
    const res = await dispatch(bg, { type: 'unlock', walletId, password: PASSWORD }, foreign);

    expect(res).toEqual({ ok: false, reason: 'unauthorized' });
    expect(unlockSpy).not.toHaveBeenCalled();
    expect(signSpy).not.toHaveBeenCalled();
  });

  it('a sender carrying a non-extension http origin is rejected unauthorized', async () => {
    const { bg, manager } = boot();
    await bg.start();
    const unlockSpy = vi.spyOn(manager, 'unlock');

    const webSender = {
      id: RUNTIME_ID,
      origin: 'https://evil.example.com',
      url: 'https://evil.example.com/page',
    } as chrome.runtime.MessageSender;

    const res = await dispatch(bg, { type: 'isUnlocked' }, webSender);

    expect(res).toEqual({ ok: false, reason: 'unauthorized' });
    expect(unlockSpy).not.toHaveBeenCalled();
  });

  it('signTx while locked maps to {ok:false, reason:"locked"} without throwing a secret-bearing error', async () => {
    const { bg } = boot();
    await bg.start();

    const res = await dispatch(bg, {
      type: 'signTx',
      tx: { cmd: '{}', hash: 'h' },
      accountIndex: 0,
      signerSpec: { kind: 'active' },
    });

    expect(res).toEqual({ ok: false, reason: 'locked' });
  });

  it('urstoaOp (stake) after unlock resolves the active keypair, calls the core wrapper, and returns the requestKey — NO key field crosses back (XP-12)', async () => {
    const { walletId, address } = await seedWallet();
    const { manager, keyVault } = makeManager();
    // Inject the UrStoa core executors as off-network spies so the op never hits
    // node1; the keypair-resolution + sender-trust + idle-rearm path runs for real.
    const stakeSpy = vi.fn(async (p: { paymentKeyAddress: string; gasStationKey: { privateKey?: string; publicKey?: string } }) => {
      // The background resolved a REAL signing keypair from the in-memory KeyVault
      // and handed it to the wrapper — the secret never came from the popup.
      expect(p.paymentKeyAddress).toBe(address);
      expect(typeof p.gasStationKey.privateKey).toBe('string');
      expect((p.gasStationKey.privateKey ?? '').length).toBeGreaterThan(0);
      return { ok: true as const, requestKey: 'rk-stake-bg' };
    });
    const bg = createBackground({
      manager,
      keyVault,
      runtimeId: RUNTIME_ID,
      configureNode: configureNodeSpy,
      idleSeconds: 60,
      urstoaCore: {
        stakeUrStoa: stakeSpy,
        unstakeUrStoa: vi.fn(),
        collectUrStoa: vi.fn(),
        transferUrStoa: vi.fn(),
      },
    });
    await bg.start();
    await dispatch(bg, { type: 'unlock', walletId, password: PASSWORD });

    const res = await dispatch(bg, {
      type: 'urstoaOp',
      op: 'stake',
      params: { paymentKeyAddress: address, amount: '5.0' },
    });

    expect(stakeSpy).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: true, requestKey: 'rk-stake-bg' });
    // SECRET-FREE: the wire response carries no key material whatsoever.
    const flat = JSON.stringify(res);
    expect(flat).not.toContain('privateKey');
    expect(flat).not.toContain('secretKey');
    expect(flat).not.toContain('mnemonic');
    expect(flat).not.toContain('password');
  });

  it('urstoaOp (transfer) maps the core discriminated failure verbatim onto the wire response', async () => {
    const { walletId, address } = await seedWallet();
    const { manager, keyVault } = makeManager();
    const transferSpy = vi.fn(async () => ({ ok: false as const, reason: 'gas-payer-rejected' as const }));
    const bg = createBackground({
      manager,
      keyVault,
      runtimeId: RUNTIME_ID,
      configureNode: configureNodeSpy,
      idleSeconds: 60,
      urstoaCore: {
        stakeUrStoa: vi.fn(),
        unstakeUrStoa: vi.fn(),
        collectUrStoa: vi.fn(),
        transferUrStoa: transferSpy,
      },
    });
    await bg.start();
    await dispatch(bg, { type: 'unlock', walletId, password: PASSWORD });

    const res = await dispatch(bg, {
      type: 'urstoaOp',
      op: 'transfer',
      params: { senderAddress: address, receiverAddress: 'k:beef', amount: '1.0' },
    });

    expect(transferSpy).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: false, reason: 'gas-payer-rejected' });
  });

  it('urstoaOp while locked maps to {ok:false, reason:"locked"} and NEVER calls the core wrapper', async () => {
    await seedWallet();
    const { manager, keyVault } = makeManager();
    const stakeSpy = vi.fn();
    const bg = createBackground({
      manager,
      keyVault,
      runtimeId: RUNTIME_ID,
      configureNode: configureNodeSpy,
      idleSeconds: 60,
      urstoaCore: {
        stakeUrStoa: stakeSpy,
        unstakeUrStoa: vi.fn(),
        collectUrStoa: vi.fn(),
        transferUrStoa: vi.fn(),
      },
    });
    await bg.start();
    // No unlock → the worker holds no key.

    const res = await dispatch(bg, {
      type: 'urstoaOp',
      op: 'stake',
      params: { paymentKeyAddress: 'k:abc', amount: '5.0' },
    });

    expect(stakeSpy).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: false, reason: 'locked' });
  });

  it('urstoaOp from a FOREIGN sender is rejected as unauthorized before any keypair resolves', async () => {
    const { walletId } = await seedWallet();
    const { manager, keyVault } = makeManager();
    const stakeSpy = vi.fn();
    const bg = createBackground({
      manager,
      keyVault,
      runtimeId: RUNTIME_ID,
      configureNode: configureNodeSpy,
      idleSeconds: 60,
      urstoaCore: {
        stakeUrStoa: stakeSpy,
        unstakeUrStoa: vi.fn(),
        collectUrStoa: vi.fn(),
        transferUrStoa: vi.fn(),
      },
    });
    await bg.start();
    await dispatch(bg, { type: 'unlock', walletId, password: PASSWORD });

    const foreign = { id: 'some-other-extension' } as chrome.runtime.MessageSender;
    const res = await dispatch(
      bg,
      { type: 'urstoaOp', op: 'stake', params: { paymentKeyAddress: 'k:abc', amount: '5.0' } },
      foreign,
    );

    expect(res).toEqual({ ok: false, reason: 'unauthorized' });
    expect(stakeSpy).not.toHaveBeenCalled();
  });

  it('isUnlocked always succeeds with a boolean (true after unlock, false after lock)', async () => {
    const { walletId } = await seedWallet();
    const { bg } = boot();
    await bg.start();

    const before = await dispatch(bg, { type: 'isUnlocked' });
    expect(before).toEqual({ ok: true, unlocked: false });

    await dispatch(bg, { type: 'unlock', walletId, password: PASSWORD });
    const after = await dispatch(bg, { type: 'isUnlocked' });
    expect(after).toEqual({ ok: true, unlocked: true });

    await dispatch(bg, { type: 'lock' });
    const locked = await dispatch(bg, { type: 'isUnlocked' });
    expect(locked).toEqual({ ok: true, unlocked: false });
  });

  it('an idle state-change locks the vault: KeyVault.lock() runs and the mnemonic is cleared', async () => {
    const { walletId } = await seedWallet();
    const { bg, keyVault } = boot();
    await bg.start();
    await dispatch(bg, { type: 'unlock', walletId, password: PASSWORD });
    expect(keyVault.isUnlocked()).toBe(true);

    chromeDouble.idle.emit('idle');
    // lock() is async inside the listener; flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    expect(keyVault.isUnlocked()).toBe(false);
    expect(keyVault.getUnlockedKey()).toBeNull();

    const after = await dispatch(bg, { type: 'isUnlocked' });
    expect(after).toEqual({ ok: true, unlocked: false });

    // And a subsequent signTx is locked out.
    const sign = await dispatch(bg, {
      type: 'signTx',
      tx: { cmd: '{}', hash: 'h' },
      accountIndex: 0,
      signerSpec: { kind: 'active' },
    });
    expect(sign).toEqual({ ok: false, reason: 'locked' });
  });

  it('idle auto-lock clears the KeyringManager secret too (H-1): it routes through manager.lock(), not bare keyVault.lock()', async () => {
    // The decrypted mnemonic+password live in the manager's private `unlocked`
    // field, cleared ONLY by manager.lock(). A bare keyVault.lock() on idle would
    // leave that secret resident and re-derivable. The idle handler must lock the
    // MANAGER (which in turn locks the KeyVault) — matching the `lock` msg path.
    const { walletId } = await seedWallet();
    const { bg, keyVault, manager } = boot();
    await bg.start();
    await dispatch(bg, { type: 'unlock', walletId, password: PASSWORD });
    expect(keyVault.isUnlocked()).toBe(true);

    const managerLockSpy = vi.spyOn(manager, 'lock');

    chromeDouble.idle.emit('idle');
    await Promise.resolve();
    await Promise.resolve();

    // The manager's own lock ran — so its in-memory unlocked secret is cleared,
    // not merely the KeyVault key.
    expect(managerLockSpy).toHaveBeenCalledTimes(1);
    expect(keyVault.isUnlocked()).toBe(false);

    // There is no way to re-derive/sign without a fresh unlock.
    const sign = await dispatch(bg, {
      type: 'signTx',
      tx: { cmd: '{}', hash: 'h' },
      accountIndex: 0,
      signerSpec: { kind: 'active' },
    });
    expect(sign).toEqual({ ok: false, reason: 'locked' });
  });

  it('a "locked" idle state (OS lock screen) also locks the vault', async () => {
    const { walletId } = await seedWallet();
    const { bg, keyVault } = boot();
    await bg.start();
    await dispatch(bg, { type: 'unlock', walletId, password: PASSWORD });

    chromeDouble.idle.emit('locked');
    await Promise.resolve();
    await Promise.resolve();

    expect(keyVault.isUnlocked()).toBe(false);
  });

  it('a serviced op resets the idle window (re-arms setDetectionInterval) so activity keeps the vault unlocked', async () => {
    const { walletId } = await seedWallet();
    const { bg } = boot();
    await bg.start();

    const setInterval = vi.spyOn(chrome.idle, 'setDetectionInterval');
    await dispatch(bg, { type: 'unlock', walletId, password: PASSWORD });
    await dispatch(bg, { type: 'getActiveAccount' });

    // Each serviced op re-arms the detection window with the configured seconds.
    expect(setInterval).toHaveBeenCalledWith(60);
    expect(setInterval.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('an "active" idle transition does NOT lock and instead re-arms the window', async () => {
    const { walletId } = await seedWallet();
    const { bg, keyVault } = boot();
    await bg.start();
    await dispatch(bg, { type: 'unlock', walletId, password: PASSWORD });

    chromeDouble.idle.emit('active');
    await Promise.resolve();

    expect(keyVault.isUnlocked()).toBe(true);
  });

  it('cold respawn (a fresh manager with no unlock) reports isUnlocked false even though a wallet is stored', async () => {
    await seedWallet();
    // Simulate SW respawn: a brand-new background over the SAME chrome.storage,
    // with NO unlock call — the in-memory mnemonic is gone.
    const { bg, keyVault } = boot();
    await bg.start();

    expect(keyVault.isUnlocked()).toBe(false);
    const res = await dispatch(bg, { type: 'isUnlocked' });
    expect(res).toEqual({ ok: true, unlocked: false });
  });

  it('getActiveAccount returns the active account after unlock and {ok:false,reason:"locked"} when locked', async () => {
    const { walletId, address } = await seedWallet();
    const { bg } = boot();
    await bg.start();

    const lockedRes = await dispatch(bg, { type: 'getActiveAccount' });
    expect(lockedRes).toEqual({ ok: false, reason: 'locked' });

    await dispatch(bg, { type: 'unlock', walletId, password: PASSWORD });
    const res = await dispatch(bg, { type: 'getActiveAccount' });
    expect(res.ok).toBe(true);
    if (res.ok && 'account' in res) {
      expect(res.account?.account).toBe(address);
      expect(res.account?.index).toBe(0);
    }
  });

  it('addAccount derives the next account WITHOUT a password (RR#7) and returns it', async () => {
    const { walletId } = await seedWallet();
    const { bg } = boot();
    await bg.start();
    await dispatch(bg, { type: 'unlock', walletId, password: PASSWORD });

    const res = await dispatch(bg, { type: 'addAccount', walletId });
    expect(res.ok).toBe(true);
    if (res.ok && 'account' in res) {
      expect(res.account?.index).toBe(1);
      expect(res.account?.account.startsWith('k:')).toBe(true);
    }
  });

  it('addAccount while locked maps to {ok:false, reason:"locked"}', async () => {
    const { walletId } = await seedWallet();
    const { bg } = boot();
    await bg.start();

    const res = await dispatch(bg, { type: 'addAccount', walletId });
    expect(res).toEqual({ ok: false, reason: 'locked' });
  });

  it('an unknown/malformed request type resolves to a discriminated {ok:false, reason} — never undefined or a throw (M-2)', async () => {
    // A trusted sender can still emit a corrupt envelope. Without the router's
    // exhaustive `default`, the switch falls through to `undefined`, which the
    // popup proxy then dereferences and throws on. It must collapse to a
    // discriminated failure the proxy can narrow safely.
    const { bg } = boot();
    await bg.start();

    const res = await dispatch(
      bg,
      { type: 'totally-not-a-real-type' } as unknown as Request,
    );

    expect(res).toBeDefined();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('corrupt-envelope');
    }
  });

  it('never console-logs the mnemonic, password, or private key across unlock → sign → lock (RR#6)', async () => {
    const { walletId, address } = await seedWallet();
    const { bg } = boot();
    await bg.start();

    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );

    await dispatch(bg, { type: 'unlock', walletId, password: PASSWORD });
    await dispatch(bg, {
      type: 'signTx',
      tx: {
        cmd: JSON.stringify({
          payload: { exec: { code: '(+ 1 1)', data: {} } },
          signers: [],
          meta: { chainId: '0', sender: address, gasLimit: 1000, gasPrice: 1e-6, ttl: 600, creationTime: 0 },
          networkId: 'stoachain',
          nonce: 'n',
        }),
        hash: 'h',
      },
      accountIndex: 0,
      signerSpec: { kind: 'active' },
    });
    await dispatch(bg, { type: 'lock' });

    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        const joined = call.map((a) => String(a)).join(' ');
        expect(joined).not.toContain(PASSWORD);
        expect(joined.toLowerCase()).not.toContain('mnemonic');
        expect(joined).not.toContain('privateKey');
      }
    }
  });

  describe('dApp message dispatch (wiring to the dappRouter)', () => {
    interface DappRouterStub {
      handle: ReturnType<typeof vi.fn>;
      hydrate: ReturnType<typeof vi.fn>;
    }

    function bootWithDapp(): { bg: Background; manager: KeyringManager; dapp: DappRouterStub } {
      const { manager, keyVault } = makeManager();
      const dapp: DappRouterStub = {
        handle: vi.fn(async () => ({ id: 'x', method: 'kda_getNetwork', status: 'success', networkId: 'stoachain' })),
        hydrate: vi.fn(async () => {}),
      };
      const bg = createBackground({
        manager,
        keyVault,
        runtimeId: RUNTIME_ID,
        configureNode: configureNodeSpy,
        idleSeconds: 60,
        dappRouter: dapp as unknown as Parameters<typeof createBackground>[0]['dappRouter'],
      });
      return { bg, manager, dapp };
    }

    it('routes a kda_* message (a web-origin sender) to the dappRouter with the RAW sender, not the popup path', async () => {
      const { bg, manager, dapp } = bootWithDapp();
      await bg.start();
      const unlockSpy = vi.spyOn(manager, 'unlock');

      const webSender = {
        id: RUNTIME_ID,
        origin: 'https://dapp.test',
        url: 'https://dapp.test/page',
        tab: { id: 5 },
      } as chrome.runtime.MessageSender;

      const res = await new Promise((resolve) => {
        bg.handleMessage(
          { method: 'kda_getNetwork', id: 'n1' } as unknown as Request,
          webSender,
          (r) => resolve(r),
        );
      });

      // The dApp router was invoked with the request + the REAL sender (so it can
      // derive the trusted origin); the popup keyring path was NOT touched.
      expect(dapp.handle).toHaveBeenCalledTimes(1);
      expect(dapp.handle.mock.calls[0][1]).toBe(webSender);
      expect(unlockSpy).not.toHaveBeenCalled();
      expect(res).toMatchObject({ status: 'success', method: 'kda_getNetwork' });
    });

    it('still rejects a foreign-sender POPUP (type:) message and does NOT route it to the dappRouter', async () => {
      const { bg, dapp } = bootWithDapp();
      await bg.start();

      const foreign = { id: 'evil-ext' } as chrome.runtime.MessageSender;
      const res = await new Promise((resolve) => {
        bg.handleMessage({ type: 'isUnlocked' } as Request, foreign, (r) => resolve(r));
      });

      expect(res).toEqual({ ok: false, reason: 'unauthorized' });
      expect(dapp.handle).not.toHaveBeenCalled();
    });

    it('hydrates the dappRouter rate-limiter state at start (RR#9)', async () => {
      const { bg, dapp } = bootWithDapp();
      await bg.start();
      expect(dapp.hydrate).toHaveBeenCalledTimes(1);
    });
  });

  describe('active-account switch hook (SG-004: pushes accountsChanged to dApps)', () => {
    it('invokes onActiveAccountChanged with the NEW active account after a successful setActiveAccount', async () => {
      const { walletId } = await seedWallet();
      const { manager, keyVault } = makeManager();
      const onSwitch = vi.fn<(account: { account: string; publicKey: string }) => void>();
      const bg = createBackground({
        manager,
        keyVault,
        runtimeId: RUNTIME_ID,
        configureNode: configureNodeSpy,
        idleSeconds: 60,
        onActiveAccountChanged: onSwitch,
      });
      await bg.start();
      await dispatch(bg, { type: 'unlock', walletId, password: PASSWORD });
      // Derive a second account so there is a distinct index to switch TO.
      const added = await dispatch(bg, { type: 'addAccount', walletId });
      const newAddress = added.ok && 'account' in added ? added.account?.account : undefined;

      const res = await dispatch(bg, { type: 'setActiveAccount', walletId, index: 1 });
      expect(res).toEqual({ ok: true });

      // The hook fired once with the new active account's PUBLIC fields — the
      // wiring that lets index.ts push accountsChanged to connected dApps.
      expect(onSwitch).toHaveBeenCalledTimes(1);
      expect(onSwitch.mock.calls[0][0].account).toBe(newAddress);
      expect(onSwitch.mock.calls[0][0].account.startsWith('k:')).toBe(true);
    });

    it('does NOT invoke onActiveAccountChanged when setActiveAccount FAILS', async () => {
      const { manager, keyVault } = makeManager();
      const onSwitch = vi.fn();
      const bg = createBackground({
        manager,
        keyVault,
        runtimeId: RUNTIME_ID,
        configureNode: configureNodeSpy,
        idleSeconds: 60,
        onActiveAccountChanged: onSwitch,
      });
      await bg.start();
      // No unlock / no wallet → setActiveAccount cannot resolve a real account.
      const res = await dispatch(bg, { type: 'setActiveAccount', walletId: 'missing', index: 3 });
      expect(res.ok).toBe(false);
      expect(onSwitch).not.toHaveBeenCalled();
    });

    it('does NOT invoke onActiveAccountChanged for a non-switch op (e.g. getActiveAccount)', async () => {
      const { walletId } = await seedWallet();
      const { manager, keyVault } = makeManager();
      const onSwitch = vi.fn();
      const bg = createBackground({
        manager,
        keyVault,
        runtimeId: RUNTIME_ID,
        configureNode: configureNodeSpy,
        idleSeconds: 60,
        onActiveAccountChanged: onSwitch,
      });
      await bg.start();
      await dispatch(bg, { type: 'unlock', walletId, password: PASSWORD });
      await dispatch(bg, { type: 'getActiveAccount' });
      expect(onSwitch).not.toHaveBeenCalled();
    });
  });
});
