import type { AdvancedAccount } from '@stoawallet/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  useWallet,
  type ContextAddAdvancedResult,
  type ContextResolveForeignKeyResult,
} from '../context/WalletContext';

export type { ContextAddAdvancedResult, ContextResolveForeignKeyResult };

/**
 * Staged state for an advanced-account add.
 *
 * The core orchestration does classify -> fetch-guard -> analyze in ONE call, so
 * the hook cannot observe those sub-steps. It therefore sets a SINGLE in-flight
 * stage (`adding`) synchronously on entry and maps the terminal core result
 * honestly — it never advertises `classifying`/`fetching-guard`/`analyzing`
 * stages it can never actually reach (the honest-staging discipline).
 *
 * Terminals:
 *  - `added` — the account was persisted; carries the decided `mode` and (for a
 *    watch-only add) the `neededMore` count.
 *  - `warning` — the account is real but cannot be made send-capable as-is:
 *    `not-key-guarded` (guard is not a signable keyset) or `unrecognized-predicate`
 *    (an unknown predicate forces watch-only). Distinct from `error` so the UI
 *    warns rather than reporting a hard failure, and distinct from a silent add.
 *  - `error` — a hard failure reason (`locked`, `invalid-address`,
 *    `already-derived`, `account-not-found`, or any other).
 */
export type AdvancedAddState =
  | { readonly status: 'idle' }
  | { readonly status: 'adding' }
  | {
      readonly status: 'added';
      readonly account: AdvancedAccount;
      readonly mode: AdvancedAccount['mode'];
      readonly neededMore?: number;
    }
  | {
      readonly status: 'warning';
      readonly reason: 'not-key-guarded' | 'unrecognized-predicate';
    }
  | { readonly status: 'error'; readonly reason: string };

export interface UseAdvancedAccountsOptions {
  /**
   * The context advanced-add op (builds the pub set + runs core INSIDE the
   * manager). Defaults to `useWallet().addAdvancedAccount` so the hook never
   * holds key material (XP-12). Tests inject a stub.
   */
  readonly addAdvancedAccount?: (
    address: string,
    chainId: string,
  ) => Promise<ContextAddAdvancedResult>;
  /**
   * The context foreign-key-resolve op. Defaults to
   * `useWallet().resolveForeignKey`. The pasted key is forwarded to this op and
   * the hook keeps NO reference to it afterward (RR#8).
   */
  readonly resolveForeignKey?: (
    account: AdvancedAccount,
    privateKey: string,
  ) => Promise<ContextResolveForeignKeyResult>;
  /**
   * Reads the current advanced-account list from the vault. Defaults to
   * `useWallet().listAdvancedAccounts`. Re-read after every successful add/paste
   * so the rendered list reflects a transition (e.g. watch-only -> send-capable).
   */
  readonly listAdvancedAccounts?: () => Promise<readonly AdvancedAccount[]>;
}

export interface UseAdvancedAccountsResult {
  readonly state: AdvancedAddState;
  /**
   * The advanced accounts read from the vault, each with its `mode`. A watch-only
   * account is exposed with `mode: 'watch-only'` and so is NEVER rendered with a
   * send action; after a satisfying paste the list reflects the promotion.
   */
  readonly advancedAccounts: readonly AdvancedAccount[];
  /** Classify + fetch + analyze + persist an advanced account. */
  addAccount(address: string, chainId: string): Promise<void>;
  /**
   * Resolve a pasted foreign key for `account`. Returns the discriminated
   * outcome (send-capable promotion vs still watch-only + neededMore, or a
   * validation reason). The hook retains NO reference to `privateKey` after this
   * resolves (RR#8).
   */
  pasteKey(
    account: AdvancedAccount,
    privateKey: string,
  ): Promise<ContextResolveForeignKeyResult>;
  /** Reset the add state back to idle. */
  reset(): void;
}

/**
 * State hook over the advanced-account add + foreign-key-paste seams.
 *
 * SECRET DISCIPLINE: the hook NEVER holds the wallet password/mnemonic — those
 * live in the KeyringManager behind the context seam (XP-12). The pasted private
 * key transits as an argument to `pasteKey` and is forwarded straight to the
 * context op; the hook captures NO closure/state copy of it after resolution
 * (RR#8). No `console.*` is emitted, so nothing can leak a pasted key.
 */
export function useAdvancedAccounts(
  options: UseAdvancedAccountsOptions = {},
): UseAdvancedAccountsResult {
  const wallet = useWallet();
  const addOp = options.addAdvancedAccount ?? wallet.addAdvancedAccount;
  const resolveOp = options.resolveForeignKey ?? wallet.resolveForeignKey;
  const listOp = options.listAdvancedAccounts ?? wallet.listAdvancedAccounts;

  const [state, setState] = useState<AdvancedAddState>({ status: 'idle' });
  const [advancedAccounts, setAdvancedAccounts] = useState<
    readonly AdvancedAccount[]
  >([]);

  // Suppress post-resolution setState after unmount (MV3 popup close mid-action).
  // The in-flight op is NOT aborted — only its UI write is dropped. Same idiom as
  // useSendSameChain: a single-shot action needs an unmount guard, not a nonce.
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const safeSetState = useCallback((next: AdvancedAddState) => {
    if (cancelledRef.current) return;
    setState(next);
  }, []);

  const refreshList = useCallback(async () => {
    const next = await listOp();
    if (cancelledRef.current) return;
    setAdvancedAccounts(next);
  }, [listOp]);

  // Seed the list on mount so a returning user sees their advanced accounts.
  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  const addAccount = useCallback(
    async (address: string, chainId: string): Promise<void> => {
      // RR#12: set the in-flight stage SYNCHRONOUSLY on entry. This both engages
      // the progress UI immediately and CLEARS any prior terminal (a warning from
      // a previous add must not bleed into this one).
      safeSetState({ status: 'adding' });

      const result = await addOp(address, chainId);

      if (!result.ok) {
        // not-key-guarded is a distinct WARNING (the account exists but its guard
        // is unsignable) — never an added send-capable, never a silent add. Every
        // other failure (locked, invalid-address, already-derived, …) is an error.
        if (result.reason === 'not-key-guarded') {
          safeSetState({ status: 'warning', reason: 'not-key-guarded' });
          return;
        }
        safeSetState({ status: 'error', reason: result.reason });
        return;
      }

      // A persisted watch-only add whose predicate the wallet does not recognize
      // is surfaced as a WARNING, not a plain added: the account is real but the
      // unknown predicate means it can never be auto-treated as send-capable.
      if (result.mode === 'watch-only' && result.predicateRecognized === false) {
        await refreshList();
        safeSetState({ status: 'warning', reason: 'unrecognized-predicate' });
        return;
      }

      await refreshList();
      safeSetState({
        status: 'added',
        account: result.account,
        mode: result.mode,
        neededMore: result.mode === 'watch-only' ? result.neededMore : undefined,
      });
    },
    [addOp, refreshList, safeSetState],
  );

  const pasteKey = useCallback(
    async (
      account: AdvancedAccount,
      privateKey: string,
    ): Promise<ContextResolveForeignKeyResult> => {
      // The pasted key is forwarded straight to the context seam and is NOT
      // captured in any ref/state here — once this call returns the hook holds no
      // reference to it (RR#8).
      const result = await resolveOp(account, privateKey);

      // Re-read the vault so a satisfying paste's promotion (watch-only ->
      // send-capable) is reflected in the rendered list. A rejected paste persists
      // nothing, so the re-read simply confirms the unchanged mode.
      await refreshList();
      return result;
    },
    [resolveOp, refreshList],
  );

  const reset = useCallback(() => {
    safeSetState({ status: 'idle' });
  }, [safeSetState]);

  return { state, advancedAccounts, addAccount, pasteKey, reset };
}
