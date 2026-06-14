import {
  classifyGuardKind,
  extractKeysetFromGuard,
} from '@stoachain/stoa-core/guard';

/**
 * The subset of a Pact dirty-read response this module consumes. `data` is the
 * decoded Pact value the executed code evaluated to (an account row for
 * `coin.details`, a keyset for `describe-keyset`).
 */
export interface DirtyReadResult {
  readonly result?: {
    readonly status?: string;
    readonly data?: unknown;
  };
}

/**
 * The single network-read boundary, injectable so tests stub it and stay fully
 * off-network. `dirtyRead` runs arbitrary Pact `pactCode` against the active
 * node for `chainId` and returns the decoded result. The live default
 * (see `fetchAccountGuard.live.ts`) lazily wires the node-active SDK client.
 */
export interface GuardReadDeps {
  dirtyRead: (pactCode: string, chainId: string) => Promise<DirtyReadResult>;
}

/**
 * The on-chain guard situation for an account on one chain. `exists` is the
 * absent-vs-present discriminator; `isKeyset:false` on an EXISTING account is
 * the WARN signal — the account is real but its guard is not a signable keyset
 * (capability / user / unresolved-ref). `keys`/`pred` are populated only when
 * `isKeyset` is true.
 */
export interface AccountGuardResult {
  readonly exists: boolean;
  readonly guard?: unknown;
  readonly isKeyset: boolean;
  readonly keys: string[];
  readonly pred: string;
  readonly balance: number;
}

/** The canonical absent-account result, also used for any read failure. */
const EMPTY: AccountGuardResult = {
  exists: false,
  isKeyset: false,
  keys: [],
  pred: '',
  balance: 0,
};

/**
 * Resolve the live (node-backed) read seam lazily so the barrel-reachable
 * orchestrator never statically imports the SDK Pact builder / client.
 */
async function defaultDeps(): Promise<GuardReadDeps> {
  const { makeLiveGuardReadDeps } = await import('./fetchAccountGuard.live');
  return makeLiveGuardReadDeps();
}

/** Pull a Stoa `balance` out of the row: a bare number OR a `{ decimal }` object. */
function parseBalance(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (raw && typeof raw === 'object' && 'decimal' in raw) {
    const dec = (raw as { decimal?: unknown }).decimal;
    if (typeof dec === 'string' || typeof dec === 'number') {
      const n = parseFloat(String(dec));
      return Number.isNaN(n) ? 0 : n;
    }
  }
  return 0;
}

/**
 * The chain emits a keyset-REFERENCE guard as a STRING ref under one of several
 * field-name variants (`keysetref`, `ks-name`, `keysetref-name`). The SDK
 * `classifyGuardKind` only recognises the OBJECT-form ref, so we detect the
 * string-ref variants here to drive the `describe-keyset` follow-up.
 */
function stringKeysetRef(guard: Record<string, unknown>): string | null {
  for (const field of ['keysetref', 'ks-name', 'keysetref-name']) {
    const v = guard[field];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * Resolve a keyset-ref to its `{ keys, pred }` via a second dirty-read of
 * `(describe-keyset "<ref>")`. Returns null when the ref cannot be resolved.
 */
async function describeKeyset(
  ref: string,
  chainId: string,
  deps: GuardReadDeps,
): Promise<{ keys: string[]; pred: string } | null> {
  const res = await deps.dirtyRead(`(describe-keyset "${ref}")`, chainId);
  if (res.result?.status !== 'success') return null;
  const data = res.result.data;
  if (data && typeof data === 'object' && Array.isArray((data as { keys?: unknown }).keys)) {
    const d = data as { keys: string[]; pred?: unknown };
    return {
      keys: d.keys,
      pred: typeof d.pred === 'string' ? d.pred : 'keys-all',
    };
  }
  return null;
}

/**
 * Read an account's on-chain guard situation on one chain via a dirty-read of
 * `(try false (coin.details "<address>"))`. Guard-shape parsing is delegated to
 * the SDK primitives `classifyGuardKind` + `extractKeysetFromGuard`; the
 * keyset-ref (string-form) variants trigger a `describe-keyset` follow-up read.
 *
 * Never throws a secret-bearing Error and emits NO logs: any non-success read,
 * a `false`/null/non-object row, or a thrown read collapses to the empty
 * `{ exists:false, ... }` result. An EXISTING account with a non-keyset guard
 * surfaces as `{ exists:true, isKeyset:false, keys:[] }` — distinct from absent.
 */
export async function fetchAccountGuard(
  address: string,
  chainId: string,
  deps?: GuardReadDeps,
): Promise<AccountGuardResult> {
  const d = deps ?? (await defaultDeps());

  try {
    const res = await d.dirtyRead(
      `(try false (coin.details "${address}"))`,
      chainId,
    );
    if (res.result?.status !== 'success') return EMPTY;

    const data = res.result.data;
    if (data === false || data === 'false' || data === null) return EMPTY;
    if (!data || typeof data !== 'object') return EMPTY;

    const row = data as Record<string, unknown>;
    const balance = parseBalance(row.balance);
    const guard = row.guard;

    if (!guard || typeof guard !== 'object') {
      return { exists: true, guard, isKeyset: false, keys: [], pred: '', balance };
    }

    // Inline keyset (w:/direct): the SDK classifier + extractor handle the
    // canonical {pred, keys} shape.
    if (classifyGuardKind(guard) === 'keyset') {
      const inline = extractKeysetFromGuard(guard);
      if (inline) {
        return {
          exists: true,
          guard,
          isKeyset: true,
          keys: inline.keys,
          pred: inline.pred || 'keys-all',
          balance,
        };
      }
    }

    // A keyset the chain emitted WITHOUT a pred classifies as non-keyset to the
    // SDK; a bare {keys:[...]} is still a usable inline keyset, defaulting to
    // the keys-all predicate.
    const guardObj = guard as Record<string, unknown>;
    if (Array.isArray(guardObj.keys)) {
      const keys = guardObj.keys as string[];
      const pred =
        typeof guardObj.pred === 'string' && guardObj.pred ? guardObj.pred : 'keys-all';
      return { exists: true, guard, isKeyset: true, keys, pred, balance };
    }

    // Keyset-ref (r:/keysetref string variants): resolve via describe-keyset.
    const ref = stringKeysetRef(guardObj);
    if (ref) {
      const resolved = await describeKeyset(ref, chainId, d);
      if (resolved) {
        return {
          exists: true,
          guard,
          isKeyset: true,
          keys: resolved.keys,
          pred: resolved.pred,
          balance,
        };
      }
    }

    // Non-keyset guard (capability / user / unresolved ref): exists but unsignable.
    return { exists: true, guard, isKeyset: false, keys: [], pred: '', balance };
  } catch {
    return EMPTY;
  }
}
