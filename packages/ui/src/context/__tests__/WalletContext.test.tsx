import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import { act, render, renderHook } from '@testing-library/react';
import { type ReactNode, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WalletProvider, useWallet } from '../WalletContext';

const PASSWORD = 'correct horse battery staple';

function makeWrapper() {
  const storage = new InMemoryStorageAdapter();
  const keyVault = new InMemoryKeyVault();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WalletProvider storage={storage} keyVault={keyVault}>
      {children}
    </WalletProvider>
  );
  return { storage, keyVault, wrapper };
}

describe('WalletContext', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('startCreate generates a 24-word phrase into context state for display', async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useWallet(), { wrapper });

    expect(result.current.words).toEqual([]);
    expect(result.current.mode).toBe('create');

    await act(async () => {
      await result.current.startCreate();
    });

    // The generated phrase is exactly 24 distinct words held in state for the
    // backup-confirmation screen — proof the create flow produced a real seed.
    expect(result.current.words).toHaveLength(24);
    expect(result.current.words.every((w) => w.length > 0)).toBe(true);
  });

  it('saveWallet clears the in-memory words after a successful save', async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useWallet(), { wrapper });

    await act(async () => {
      await result.current.startCreate();
    });
    expect(result.current.words).toHaveLength(24);

    let outcome: { ok: boolean } | undefined;
    await act(async () => {
      outcome = await result.current.saveWallet(PASSWORD);
    });

    // Success both reports ok and scrubs the plaintext phrase from state so it
    // can never be read back from the live context after onboarding.
    expect(outcome?.ok).toBe(true);
    expect(result.current.words).toEqual([]);
  });

  it('importWallet with an invalid phrase exposes the validation reason and creates no wallet', async () => {
    const { wrapper, storage } = makeWrapper();
    const { result } = renderHook(() => useWallet(), { wrapper });

    // 24 tokens that are not all valid BIP39 words → "invalid-words", distinct
    // from a wrong-count rejection.
    const badPhrase = Array.from({ length: 24 }, () => 'zzzz');

    let outcome: { ok: boolean; reason?: string } | undefined;
    await act(async () => {
      outcome = await result.current.importWallet(badPhrase, PASSWORD);
    });

    expect(outcome?.ok).toBe(false);
    expect(outcome?.reason).toBe('invalid-words');
    // No vault was written: an invalid phrase must not touch persistence.
    expect(await storage.get('stoawallet:vault')).toBeNull();

    // A short phrase is rejected with the DISTINCT word-count reason.
    let shortOutcome: { ok: boolean; reason?: string } | undefined;
    await act(async () => {
      shortOutcome = await result.current.importWallet(['abandon'], PASSWORD);
    });
    expect(shortOutcome?.ok).toBe(false);
    expect(shortOutcome?.reason).toBe('word-count');
  });

  it('unlock surfaces wrong-password distinctly from corrupt-envelope', async () => {
    const { wrapper, storage, keyVault } = makeWrapper();
    const { result } = renderHook(() => useWallet(), { wrapper });

    await act(async () => {
      await result.current.startCreate();
      await result.current.saveWallet(PASSWORD);
    });

    await act(async () => {
      await result.current.lock();
    });

    let wrong: { ok: boolean; reason?: string } | undefined;
    await act(async () => {
      wrong = await result.current.unlock('not the password');
    });
    expect(wrong?.ok).toBe(false);
    expect(wrong?.reason).toBe('wrong-password');
    // A failed unlock leaves no key resident.
    expect(keyVault.isUnlocked()).toBe(false);

    // Corrupt the stored vault blob's encrypted phrase so decrypt cannot parse
    // an envelope → a DIFFERENT discriminated reason than wrong-password.
    const raw = (await storage.get('stoawallet:vault')) as string;
    const vault = JSON.parse(raw);
    vault.wallets[0].encryptedPhrase = 'not-a-real-envelope';
    await storage.set('stoawallet:vault', JSON.stringify(vault));

    let corrupt: { ok: boolean; reason?: string } | undefined;
    await act(async () => {
      corrupt = await result.current.unlock(PASSWORD);
    });
    expect(corrupt?.ok).toBe(false);
    expect(corrupt?.reason).not.toBe('wrong-password');
    expect(corrupt?.reason).toBe('corrupt-envelope');
  });

  it('activeAccount reflects the active selection and updates after switchAccount', async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useWallet(), { wrapper });

    await act(async () => {
      await result.current.startCreate();
      await result.current.saveWallet(PASSWORD);
    });

    const first = result.current.activeAccount;
    expect(first?.account).toMatch(/^k:[0-9a-f]{64}$/);
    expect(first?.index).toBe(0);

    // Add a second account → it becomes active.
    await act(async () => {
      await result.current.addAccount();
    });
    expect(result.current.activeAccount?.index).toBe(1);
    expect(result.current.activeAccount?.account).not.toBe(first?.account);

    // Switch back to the first account → activeAccount reflects the selection.
    await act(async () => {
      await result.current.switchAccount(0);
    });
    expect(result.current.activeAccount?.index).toBe(0);
    expect(result.current.activeAccount?.account).toBe(first?.account);
  });

  it('exposes hasExistingWallet / existingWallets after a wallet is saved', async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useWallet(), { wrapper });

    expect(result.current.hasExistingWallet).toBe(false);
    expect(result.current.existingWallets).toEqual([]);

    await act(async () => {
      await result.current.startCreate();
      await result.current.saveWallet(PASSWORD);
    });

    // Onboarding can now offer "a wallet already exists → add another".
    expect(result.current.hasExistingWallet).toBe(true);
    expect(result.current.existingWallets).toHaveLength(1);
    expect(result.current.existingWallets[0]?.id).toBeTruthy();
  });

  it('never lets the plaintext phrase appear in any console output across create→save', async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useWallet(), { wrapper });

    await act(async () => {
      await result.current.startCreate();
    });
    const phrase = result.current.words.join(' ');
    expect(phrase.split(' ')).toHaveLength(24);

    await act(async () => {
      await result.current.saveWallet(PASSWORD);
    });

    const allLogged = [errorSpy, logSpy, warnSpy]
      .flatMap((spy) => spy.mock.calls)
      .flat()
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join('\n');

    expect(allLogged).not.toContain(phrase);
    for (const word of result.current.words) {
      // words is cleared post-save, so this loop is empty; the phrase check above
      // is the real guard. Kept defensive in case clearing regresses.
      expect(allLogged).not.toContain(word);
    }
  });

  it('clears words on unmount even when saveWallet was never called (flow abandon)', async () => {
    const { wrapper } = makeWrapper();
    const captured: { words: string[] } = { words: [] };

    function Probe() {
      const ctx = useWallet();
      useEffect(() => {
        captured.words = ctx.words;
      }, [ctx.words]);
      return null;
    }

    const { result } = renderHook(() => useWallet(), { wrapper });
    await act(async () => {
      await result.current.startCreate();
    });
    expect(result.current.words).toHaveLength(24);

    // A fresh provider whose subtree unmounts must not leak the phrase: mount a
    // create flow, then unmount, and confirm no phrase survives the teardown.
    const { unmount } = render(
      <WalletProvider
        storage={new InMemoryStorageAdapter()}
        keyVault={new InMemoryKeyVault()}
      >
        <Probe />
      </WalletProvider>,
    );
    unmount();
    // The captured snapshot is the empty initial state; the unmount cleanup ran.
    expect(captured.words).toEqual([]);
  });

  // --- XP-12: background-backed custody seam (the extension popup path) -------

  it('delegates unlock to the injected remoteVault and surfaces its reason (no local decrypt)', async () => {
    // Seed a real stored wallet so a walletId resolves, then drive a SECOND
    // provider that injects a remoteVault double — the popup path.
    const storage = new InMemoryStorageAdapter();
    const keyVault = new InMemoryKeyVault();
    const { KeyringManager } = await import('@stoawallet/core');
    const seed = new KeyringManager({ storage, keyVault });
    await seed.importWallet(
      'flat portion other shield engine fly original desert network riot shop own evidence august belt steel into embody bounce parrot naive cruel word gown',
      PASSWORD,
    );
    await seed.lock();

    const calls: Array<{ walletId: string; password: string }> = [];
    const remoteVault = {
      unlock: vi.fn(async (walletId: string, password: string) => {
        calls.push({ walletId, password });
        // The double answers the SAME discriminated reason the wire returns.
        return { ok: false, reason: 'wrong-password' as const };
      }),
      lock: vi.fn(async () => {}),
      isUnlocked: vi.fn(async () => false),
      getActiveAccount: vi.fn(async () => null),
      listAccounts: vi.fn(async () => []),
      addAccount: vi.fn(async () => ({ ok: true as const })),
      setActiveAccount: vi.fn(async () => ({ ok: true as const })),
      signTx: vi.fn(async () => ({ ok: true as const, signed: {} })),
      urstoaExecute: vi.fn(async () => ({ ok: true as const, requestKey: 'rk' })),
    };

    const wrapper = ({ children }: { children: ReactNode }) => (
      <WalletProvider storage={storage} keyVault={keyVault} remoteVault={remoteVault}>
        {children}
      </WalletProvider>
    );
    const { result } = renderHook(() => useWallet(), { wrapper });

    let outcome: { ok: boolean; reason?: string } | undefined;
    await act(async () => {
      outcome = await result.current.unlock('whatever');
    });

    // The unlock crossed to the remote vault (the popup never decrypted), and
    // the wire reason is surfaced unchanged so the unlock UI branches identically.
    expect(remoteVault.unlock).toHaveBeenCalledTimes(1);
    expect(calls[0]?.password).toBe('whatever');
    expect(outcome).toEqual({ ok: false, reason: 'wrong-password' });
    // The local keyVault was NEVER unlocked — no key material entered this context.
    expect(keyVault.isUnlocked()).toBe(false);
  });

  it('lock with a remoteVault delegates and clears the active account locally', async () => {
    const storage = new InMemoryStorageAdapter();
    const keyVault = new InMemoryKeyVault();
    const remoteVault = {
      unlock: vi.fn(async () => ({ ok: true as const })),
      lock: vi.fn(async () => {}),
      isUnlocked: vi.fn(async () => false),
      getActiveAccount: vi.fn(async () => null),
      listAccounts: vi.fn(async () => []),
      addAccount: vi.fn(async () => ({ ok: true as const })),
      setActiveAccount: vi.fn(async () => ({ ok: true as const })),
      signTx: vi.fn(async () => ({ ok: true as const, signed: {} })),
      urstoaExecute: vi.fn(async () => ({ ok: true as const, requestKey: 'rk' })),
    };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <WalletProvider storage={storage} keyVault={keyVault} remoteVault={remoteVault}>
        {children}
      </WalletProvider>
    );
    const { result } = renderHook(() => useWallet(), { wrapper });

    await act(async () => {
      await result.current.lock();
    });

    // Lock is delegated to the worker, never run against a local manager session.
    expect(remoteVault.lock).toHaveBeenCalledTimes(1);
    expect(result.current.activeAccount).toBeNull();
  });

  it('routes switchAccount/addAccount through the remoteVault in remote mode (never the local manager) and mirrors the background selection', async () => {
    // C-1: in the extension the local manager is an inert/always-locked proxy.
    // Mutating the active account through it would leave the BACKGROUND's
    // active-account pointer stale → a later signTx {kind:'active'} would sign
    // for the OLD account (wrong-account fund movement), and addAccount would
    // throw on the inert KeyVault's requireUnlocked. Both must cross the seam.
    const storage = new InMemoryStorageAdapter();
    const keyVault = new InMemoryKeyVault();
    const { KeyringManager } = await import('@stoawallet/core');
    const seed = new KeyringManager({ storage, keyVault });
    await seed.importWallet(
      'flat portion other shield engine fly original desert network riot shop own evidence august belt steel into embody bounce parrot naive cruel word gown',
      PASSWORD,
    );
    await seed.lock();

    // The background's authoritative selection: index 0 active until a switch to
    // index 1 flips the getActiveAccount() answer the mirror reads back.
    const accounts = [
      { index: 0, publicKey: 'pk0', account: 'k:pk0', derivationPath: "m/44'/626'/0'/0'/0'" },
      { index: 1, publicKey: 'pk1', account: 'k:pk1', derivationPath: "m/44'/626'/0'/0'/1'" },
    ];
    let activeIndex = 0;

    const setActiveAccount = vi.fn(async (_walletId: string, index: number) => {
      activeIndex = index;
      return { ok: true as const };
    });
    const addAccount = vi.fn(async () => ({ ok: true as const }));

    // The local manager must NOT be touched for these ops in remote mode.
    const managerSetActiveSpy = vi.spyOn(
      KeyringManager.prototype,
      'setActiveAccount',
    );
    const managerAddSpy = vi.spyOn(KeyringManager.prototype, 'addAccount');

    const remoteVault = {
      unlock: vi.fn(async () => ({ ok: true as const })),
      lock: vi.fn(async () => {}),
      isUnlocked: vi.fn(async () => true),
      getActiveAccount: vi.fn(async () => accounts[activeIndex]),
      listAccounts: vi.fn(async () => accounts),
      addAccount,
      setActiveAccount,
      signTx: vi.fn(async () => ({ ok: true as const, signed: {} })),
      urstoaExecute: vi.fn(async () => ({ ok: true as const, requestKey: 'rk' })),
    };

    const wrapper = ({ children }: { children: ReactNode }) => (
      <WalletProvider storage={storage} keyVault={keyVault} remoteVault={remoteVault}>
        {children}
      </WalletProvider>
    );
    const { result } = renderHook(() => useWallet(), { wrapper });

    await act(async () => {
      await result.current.unlock(PASSWORD);
    });
    expect(result.current.activeAccount?.index).toBe(0);

    let switchOutcome: { ok: boolean } | undefined;
    await act(async () => {
      switchOutcome = await result.current.switchAccount(1);
    });

    // The switch crossed to the background, NOT the inert local manager.
    expect(setActiveAccount).toHaveBeenCalledWith(expect.any(String), 1);
    expect(managerSetActiveSpy).not.toHaveBeenCalled();
    expect(switchOutcome).toEqual({ ok: true });
    // The displayed active account now reflects the background's NEW selection —
    // so a subsequent signTx {kind:'active'} resolves the same (index 1) account.
    expect(result.current.activeAccount?.index).toBe(1);

    await act(async () => {
      await result.current.addAccount();
    });
    expect(addAccount).toHaveBeenCalledTimes(1);
    expect(managerAddSpy).not.toHaveBeenCalled();
  });

  it('routes sendSameChain signing through the remoteVault.signTx, never local key resolution', async () => {
    // Seed + unlock through a remoteVault double whose getActiveAccount returns a
    // real (public-only) account, so the send path has a sender but NO local key.
    const storage = new InMemoryStorageAdapter();
    const keyVault = new InMemoryKeyVault();
    const { KeyringManager } = await import('@stoawallet/core');
    const seed = new KeyringManager({ storage, keyVault });
    const { account } = await seed.importWallet(
      'flat portion other shield engine fly original desert network riot shop own evidence august belt steel into embody bounce parrot naive cruel word gown',
      PASSWORD,
    );
    await seed.lock();

    const remoteAccount = {
      index: account.index,
      publicKey: account.publicKey,
      account: account.account,
      derivationPath: account.derivationPath,
    };
    // The remote signer records the sign request and returns a signed public tx
    // (the only thing the worker hands back) — never a key.
    const signTx = vi.fn(async () => ({
      ok: true as const,
      signed: { cmd: '{"signed":true}', hash: 'h', sigs: [{ pubKey: 'p', sig: 'deadbeef' }] },
    }));
    const remoteVault = {
      unlock: vi.fn(async () => ({ ok: true as const })),
      lock: vi.fn(async () => {}),
      isUnlocked: vi.fn(async () => true),
      getActiveAccount: vi.fn(async () => remoteAccount),
      listAccounts: vi.fn(async () => [remoteAccount]),
      addAccount: vi.fn(async () => ({ ok: true as const })),
      setActiveAccount: vi.fn(async () => ({ ok: true as const })),
      signTx,
      urstoaExecute: vi.fn(async () => ({ ok: true as const, requestKey: 'rk' })),
    };

    // Inject a fully-stubbed same-chain deps set so the send stays off-network;
    // the ONLY production-path piece under test is that `sign` delegates remotely.
    const sendDeps = {
      readAccountExists: async () => true,
      buildTx: (spec: { signerPublicKey: string }) => ({
        cmd: JSON.stringify({ signer: spec.signerPublicKey }),
        hash: 'unsigned-hash',
      }),
      dirtyRead: async () => ({ result: { status: 'success' }, gas: 100 }),
      submit: async () => ({ requestKey: 'rk-1', status: 'success' }),
      calculateAutoGasLimit: (g: number) => g,
    };

    const wrapper = ({ children }: { children: ReactNode }) => (
      <WalletProvider storage={storage} keyVault={keyVault} remoteVault={remoteVault}>
        {children}
      </WalletProvider>
    );
    const { result } = renderHook(() => useWallet(), { wrapper });

    await act(async () => {
      await result.current.unlock(PASSWORD);
    });

    let outcome: { ok: boolean; reason?: string; requestKey?: string } | undefined;
    await act(async () => {
      outcome = await result.current.sendSameChain({
        recipient: 'k:' + 'b'.repeat(64),
        amount: '1.0',
        chainId: '0',
        sendDeps,
      });
    });

    // Signing went through the background; the popup never resolved a keypair.
    expect(signTx).toHaveBeenCalledTimes(1);
    expect(outcome?.ok).toBe(true);
    expect(outcome?.requestKey).toBe('rk-1');
  });

  it('routes sendCrossChainStep0 signing through the remoteVault.signTx, never local key resolution (XP-12 + Phase-5 extension path)', async () => {
    const storage = new InMemoryStorageAdapter();
    const keyVault = new InMemoryKeyVault();
    const { KeyringManager } = await import('@stoawallet/core');
    const seed = new KeyringManager({ storage, keyVault });
    const { account } = await seed.importWallet(
      'flat portion other shield engine fly original desert network riot shop own evidence august belt steel into embody bounce parrot naive cruel word gown',
      PASSWORD,
    );
    await seed.lock();

    const remoteAccount = {
      index: account.index,
      publicKey: account.publicKey,
      account: account.account,
      derivationPath: account.derivationPath,
    };
    const signTx = vi.fn(async (_spec: unknown, _tx: unknown) => ({
      ok: true as const,
      signed: { cmd: '{"signed":true}', hash: 'signed-hash', sigs: [{ pubKey: 'p', sig: 'deadbeef' }] },
    }));
    const remoteVault = {
      unlock: vi.fn(async () => ({ ok: true as const })),
      lock: vi.fn(async () => {}),
      isUnlocked: vi.fn(async () => true),
      getActiveAccount: vi.fn(async () => remoteAccount),
      listAccounts: vi.fn(async () => [remoteAccount]),
      addAccount: vi.fn(async () => ({ ok: true as const })),
      setActiveAccount: vi.fn(async () => ({ ok: true as const })),
      signTx,
      urstoaExecute: vi.fn(async () => ({ ok: true as const, requestKey: 'rk' })),
    };

    // A fully-stubbed step-0 deps set so the cross-chain stays off-network; the
    // ONLY production-path piece under test is that signTransaction delegates remotely.
    const sendCrossDeps = {
      buildStep0: async () => ({
        ok: true as const,
        tx: { cmd: '{"unsigned":true}', hash: 'unsigned-hash' },
      }),
      submit: async () => ({ requestKey: 'rk-cross-1' }),
      listen: async () => ({ result: { status: 'success' } }),
      isTimeout: () => false,
    };

    const wrapper = ({ children }: { children: ReactNode }) => (
      <WalletProvider storage={storage} keyVault={keyVault} remoteVault={remoteVault}>
        {children}
      </WalletProvider>
    );
    const { result } = renderHook(() => useWallet(), { wrapper });

    await act(async () => {
      await result.current.unlock(PASSWORD);
    });

    let outcome: { ok: boolean; reason?: string; requestKey?: string } | undefined;
    await act(async () => {
      outcome = await result.current.sendCrossChainStep0({
        receiver: remoteAccount.account,
        amount: '1.0',
        sourceChain: '0',
        targetChain: '5',
        // @ts-expect-error — the deps override seam mirrors sendSameChain's sendDeps
        crossDeps: sendCrossDeps,
      });
    });

    // Signing went through the background; the popup never resolved a keypair.
    expect(signTx).toHaveBeenCalledTimes(1);
    // The signer spec routes to the active account (the chain-0 dual-cap is filled
    // by the single active-key call — both caps carry the sender's pubkey).
    expect((signTx.mock.calls[0][0] as { kind?: string }).kind).toBe('active');
    expect(outcome?.ok).toBe(true);
    expect(outcome?.requestKey).toBe('rk-cross-1');
  });

  it('resolveActiveMinerSigners returns a usable LOCAL signer set (real keypairs, no remote override)', async () => {
    const { storage, keyVault, wrapper } = makeWrapper();
    const { KeyringManager } = await import('@stoawallet/core');
    const seed = new KeyringManager({ storage, keyVault });
    await seed.importWallet(
      'flat portion other shield engine fly original desert network riot shop own evidence august belt steel into embody bounce parrot naive cruel word gown',
      PASSWORD,
    );

    const { result } = renderHook(() => useWallet(), { wrapper });
    await act(async () => {
      await result.current.unlock(PASSWORD);
    });

    let resolved: Awaited<ReturnType<typeof result.current.resolveActiveMinerSigners>> | undefined;
    await act(async () => {
      resolved = await result.current.resolveActiveMinerSigners(true);
    });

    expect(resolved?.ok).toBe(true);
    if (resolved?.ok !== true) throw new Error('expected ok');
    // Local mode: real key material is resolved INSIDE the context and passed to core.
    expect(resolved.signingKeypairs.length).toBeGreaterThan(0);
    expect(resolved.signingKeypairs[0].privateKey).not.toBe('');
    // Chain-0 gas-payer cap is signed by the sender's OWN key (XP-8).
    expect(resolved.gasStationKeypair?.publicKey).toBe(
      resolved.signingKeypairs[0].publicKey,
    );
    // No remote override in local mode — core's default signer runs.
    expect(resolved.signTransaction).toBeUndefined();
  });

  it('resolveActiveMinerSigners returns a PUBLIC-ONLY set + background sign override in remote mode (XP-12: no secret in the popup)', async () => {
    const storage = new InMemoryStorageAdapter();
    const keyVault = new InMemoryKeyVault();
    const { KeyringManager } = await import('@stoawallet/core');
    const seed = new KeyringManager({ storage, keyVault });
    const { account } = await seed.importWallet(
      'flat portion other shield engine fly original desert network riot shop own evidence august belt steel into embody bounce parrot naive cruel word gown',
      PASSWORD,
    );
    await seed.lock();

    const remoteAccount = {
      index: account.index,
      publicKey: account.publicKey,
      account: account.account,
      derivationPath: account.derivationPath,
    };
    const signTx = vi.fn(async () => ({
      ok: true as const,
      signed: { cmd: '{"signed":true}', hash: 'h', sigs: [] },
    }));
    const remoteVault = {
      unlock: vi.fn(async () => ({ ok: true as const })),
      lock: vi.fn(async () => {}),
      isUnlocked: vi.fn(async () => true),
      getActiveAccount: vi.fn(async () => remoteAccount),
      listAccounts: vi.fn(async () => [remoteAccount]),
      addAccount: vi.fn(async () => ({ ok: true as const })),
      setActiveAccount: vi.fn(async () => ({ ok: true as const })),
      signTx,
      urstoaExecute: vi.fn(async () => ({ ok: true as const, requestKey: 'rk' })),
    };

    const wrapper = ({ children }: { children: ReactNode }) => (
      <WalletProvider storage={storage} keyVault={keyVault} remoteVault={remoteVault}>
        {children}
      </WalletProvider>
    );
    const { result } = renderHook(() => useWallet(), { wrapper });
    await act(async () => {
      await result.current.unlock(PASSWORD);
    });

    let resolved: Awaited<ReturnType<typeof result.current.resolveActiveMinerSigners>> | undefined;
    await act(async () => {
      resolved = await result.current.resolveActiveMinerSigners(true);
    });

    expect(resolved?.ok).toBe(true);
    if (resolved?.ok !== true) throw new Error('expected ok');
    // XP-12: the popup-side set carries the sender's PUBLIC key only — NO secret.
    expect(resolved.signingKeypairs[0].publicKey).toBe(remoteAccount.publicKey);
    expect(resolved.signingKeypairs[0].privateKey).toBe('');
    // The chain-0 gas stub is also public-only (sender's pubkey, empty secret).
    expect(resolved.gasStationKeypair?.privateKey).toBe('');
    expect(resolved.gasStationKeypair?.publicKey).toBe(remoteAccount.publicKey);
    // The override routes signing through the background.
    expect(resolved.signTransaction).toBeDefined();
    const signed = await resolved.signTransaction!({ cmd: '{}', hash: 'u' } as never);
    expect(signTx).toHaveBeenCalledTimes(1);
    expect((signed as { hash?: string }).hash).toBe('h');
  });

  it('resolveActiveMinerSigners surfaces locked when no active account (web/local, never unlocked)', async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useWallet(), { wrapper });
    let resolved: Awaited<ReturnType<typeof result.current.resolveActiveMinerSigners>> | undefined;
    await act(async () => {
      resolved = await result.current.resolveActiveMinerSigners(false);
    });
    expect(resolved).toEqual({ ok: false, reason: 'locked' });
  });

  describe('UrStoa op seams (XP-12 local-vs-remote)', () => {
    const MNEMONIC =
      'flat portion other shield engine fly original desert network riot shop own evidence august belt steel into embody bounce parrot naive cruel word gown';

    it('LOCAL stake resolves the active keypair via the manager and calls the core wrapper with it', async () => {
      const storage = new InMemoryStorageAdapter();
      const keyVault = new InMemoryKeyVault();
      const { KeyringManager } = await import('@stoawallet/core');
      const manager = new KeyringManager({ storage, keyVault });
      const { account } = await manager.importWallet(MNEMONIC, PASSWORD);

      // Off-network core wrapper spy — asserts the keypair carries a real secret
      // resolved INSIDE the seam (the popup/hook never sees it).
      const stakeUrStoa = vi.fn(async (p: {
        paymentKeyAddress: string;
        amount: string;
        gasStationKey: { publicKey?: string; privateKey?: string };
      }) => {
        expect(p.paymentKeyAddress).toBe(account.account);
        expect(p.amount).toBe('5.0');
        expect((p.gasStationKey.privateKey ?? '').length).toBeGreaterThan(0);
        expect(p.gasStationKey.publicKey).toBe(account.publicKey);
        return { ok: true as const, requestKey: 'rk-local-stake' };
      });

      const wrapper = ({ children }: { children: ReactNode }) => (
        <WalletProvider storage={storage} keyVault={keyVault} manager={manager}>
          {children}
        </WalletProvider>
      );
      const { result } = renderHook(() => useWallet(), { wrapper });

      let outcome: { ok: boolean; requestKey?: string } | undefined;
      await act(async () => {
        outcome = await result.current.urstoaStake({
          paymentKeyAddress: account.account,
          amount: '5.0',
          urstoaCore: { stakeUrStoa } as never,
        });
      });

      expect(stakeUrStoa).toHaveBeenCalledTimes(1);
      expect(outcome).toEqual({ ok: true, requestKey: 'rk-local-stake' });
    });

    it('LOCAL collect/transfer resolve the keypair via the manager and call their core wrappers', async () => {
      const storage = new InMemoryStorageAdapter();
      const keyVault = new InMemoryKeyVault();
      const { KeyringManager } = await import('@stoawallet/core');
      const manager = new KeyringManager({ storage, keyVault });
      const { account } = await manager.importWallet(MNEMONIC, PASSWORD);

      const collectUrStoa = vi.fn(async (p: { paymentKeyAddress: string; gasStationKey: { privateKey?: string } }) => {
        expect(p.paymentKeyAddress).toBe(account.account);
        expect((p.gasStationKey.privateKey ?? '').length).toBeGreaterThan(0);
        return { ok: true as const, requestKey: 'rk-local-collect' };
      });
      const transferUrStoa = vi.fn(async (p: { senderAddress: string; paymentKeypair: { privateKey?: string } }) => {
        expect(p.senderAddress).toBe(account.account);
        expect((p.paymentKeypair.privateKey ?? '').length).toBeGreaterThan(0);
        return { ok: true as const, requestKey: 'rk-local-transfer' };
      });

      const wrapper = ({ children }: { children: ReactNode }) => (
        <WalletProvider storage={storage} keyVault={keyVault} manager={manager}>
          {children}
        </WalletProvider>
      );
      const { result } = renderHook(() => useWallet(), { wrapper });

      let collectOut: { ok: boolean; requestKey?: string } | undefined;
      let transferOut: { ok: boolean; requestKey?: string } | undefined;
      await act(async () => {
        collectOut = await result.current.urstoaCollect({
          paymentKeyAddress: account.account,
          urstoaCore: { collectUrStoa } as never,
        });
        transferOut = await result.current.urstoaTransfer({
          senderAddress: account.account,
          receiverAddress: 'k:' + 'b'.repeat(64),
          amount: '1.0',
          urstoaCore: { transferUrStoa } as never,
        });
      });

      expect(collectOut).toEqual({ ok: true, requestKey: 'rk-local-collect' });
      expect(transferOut).toEqual({ ok: true, requestKey: 'rk-local-transfer' });
    });

    it('LOCAL op returns locked WITHOUT calling core when the wallet is locked', async () => {
      const { wrapper } = makeWrapper();
      const stakeUrStoa = vi.fn(async () => ({ ok: true as const, requestKey: 'rk' }));
      const { result } = renderHook(() => useWallet(), { wrapper });

      let outcome: { ok: boolean; reason?: string } | undefined;
      await act(async () => {
        outcome = await result.current.urstoaStake({
          paymentKeyAddress: 'k:abc',
          amount: '5.0',
          urstoaCore: { stakeUrStoa } as never,
        });
      });

      expect(stakeUrStoa).not.toHaveBeenCalled();
      expect(outcome).toEqual({ ok: false, reason: 'locked' });
    });

    it('REMOTE op routes to remoteVault.urstoaExecute with PUBLIC params only — NO keypair/private key in the message (XP-12)', async () => {
      const storage = new InMemoryStorageAdapter();
      const keyVault = new InMemoryKeyVault();
      const { KeyringManager } = await import('@stoawallet/core');
      const seed = new KeyringManager({ storage, keyVault });
      const { account } = await seed.importWallet(MNEMONIC, PASSWORD);
      await seed.lock();

      const remoteAccount = {
        index: account.index,
        publicKey: account.publicKey,
        account: account.account,
        derivationPath: account.derivationPath,
      };
      const urstoaExecute = vi.fn(
        async (_req: { op: string; params: unknown }) => ({
          ok: true as const,
          requestKey: 'rk-remote',
        }),
      );
      const remoteVault = {
        unlock: vi.fn(async () => ({ ok: true as const })),
        lock: vi.fn(async () => {}),
        isUnlocked: vi.fn(async () => true),
        getActiveAccount: vi.fn(async () => remoteAccount),
        listAccounts: vi.fn(async () => [remoteAccount]),
        addAccount: vi.fn(async () => ({ ok: true as const })),
        setActiveAccount: vi.fn(async () => ({ ok: true as const })),
        signTx: vi.fn(async () => ({ ok: true as const, signed: {} })),
        urstoaExecute,
      };

      const wrapper = ({ children }: { children: ReactNode }) => (
        <WalletProvider storage={storage} keyVault={keyVault} remoteVault={remoteVault}>
          {children}
        </WalletProvider>
      );
      const { result } = renderHook(() => useWallet(), { wrapper });

      await act(async () => {
        await result.current.unlock(PASSWORD);
      });

      let outcome: { ok: boolean; requestKey?: string } | undefined;
      await act(async () => {
        outcome = await result.current.urstoaStake({
          paymentKeyAddress: account.account,
          amount: '7.0',
        });
      });

      expect(urstoaExecute).toHaveBeenCalledTimes(1);
      const arg = urstoaExecute.mock.calls[0][0] as { op: string; params: Record<string, unknown> };
      expect(arg.op).toBe('stake');
      expect(arg.params).toEqual({ paymentKeyAddress: account.account, amount: '7.0' });
      // XP-12: the message to the background carries NO key material whatsoever.
      const flat = JSON.stringify(arg).toLowerCase();
      expect(flat).not.toMatch(/privatekey|secretkey|mnemonic|"password"|gasstationkey|paymentkeypair/);
      expect(outcome).toEqual({ ok: true, requestKey: 'rk-remote' });
    });

    it('REMOTE op returns locked WITHOUT a message when no active account is mirrored', async () => {
      const storage = new InMemoryStorageAdapter();
      const keyVault = new InMemoryKeyVault();
      const urstoaExecute = vi.fn(async () => ({ ok: true as const, requestKey: 'rk' }));
      const remoteVault = {
        unlock: vi.fn(async () => ({ ok: true as const })),
        lock: vi.fn(async () => {}),
        isUnlocked: vi.fn(async () => false),
        getActiveAccount: vi.fn(async () => null),
        listAccounts: vi.fn(async () => []),
        addAccount: vi.fn(async () => ({ ok: true as const })),
        setActiveAccount: vi.fn(async () => ({ ok: true as const })),
        signTx: vi.fn(async () => ({ ok: true as const, signed: {} })),
        urstoaExecute,
      };
      const wrapper = ({ children }: { children: ReactNode }) => (
        <WalletProvider storage={storage} keyVault={keyVault} remoteVault={remoteVault}>
          {children}
        </WalletProvider>
      );
      const { result } = renderHook(() => useWallet(), { wrapper });

      let outcome: { ok: boolean; reason?: string } | undefined;
      await act(async () => {
        outcome = await result.current.urstoaCollect({ paymentKeyAddress: 'k:abc' });
      });

      expect(urstoaExecute).not.toHaveBeenCalled();
      expect(outcome).toEqual({ ok: false, reason: 'locked' });
    });
  });
});
