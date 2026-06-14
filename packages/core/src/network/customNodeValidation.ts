/**
 * Custom-node-URL trust boundary for the Settings "custom node" path.
 *
 * The URL is USER-SUPPLIED untrusted input, so two distinct gates run before a
 * candidate is ever handed to the SDK `setNodeConfig`:
 *
 *   1. {@link validateCustomNodeUrl} — a pure shape/scheme check. Mirrors the
 *      three guards the SDK's `setNodeConfig("custom", url)` enforces post-
 *      v3.2.3 (audit F-SEC-002): WHATWG-URL parse, https-only allow-list, and
 *      origin-only normalization (path/query/fragment discarded). Running it as
 *      a discriminated PRE-check lets the UI message a clean reason BEFORE
 *      `setNodeConfig` would otherwise throw a synchronous `TypeError`.
 *   2. {@link probeCustomNode} — a live reachability + network-identity check the
 *      SDK does NOT perform: a `/info` read confirms the endpoint is reachable
 *      AND is a StoaChain node of network `KADENA_NETWORK` ("stoa"). The SDK
 *      failover health check only inspects `res.ok`; it never confirms the node
 *      is the EXPECTED network, so a well-formed https URL pointing at some
 *      other Chainweb network would pass `setNodeConfig` silently. This probe
 *      closes that gap.
 *
 * Every outcome is a DISCRIMINATED result (never a thrown Error) so the caller
 * branches on a reason code rather than catching an Error that could carry the
 * untrusted URL into a log. The candidate URL is written to NO `console.*`
 * method in ANY path, including error paths.
 */
import { KADENA_NETWORK } from '@stoachain/stoa-core/constants';

/** Default probe timeout, mirroring the SDK failover `/info` health check (3s). */
export const PROBE_TIMEOUT_MS = 3000;

/** Discriminated result of the pure shape/scheme check. */
export type ValidateUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'malformed-url' | 'insecure-scheme' };

/** Discriminated result of the live reachability + network-identity probe. */
export type ProbeResult =
  | { ok: true }
  | { ok: false; reason: 'unreachable' | 'wrong-network' };

/** Union of every shape + probe reason, for the chained {@link validateAndProbe}. */
export type ValidateAndProbeResult =
  | { ok: true; url: string }
  | {
      ok: false;
      reason: 'malformed-url' | 'insecure-scheme' | 'unreachable' | 'wrong-network';
    };

/**
 * The subset of the REAL Chainweb `GET /info` response this module consumes.
 *
 * `nodeVersion` is the ChainwebVersion — the network identifier (e.g.
 * `"mainnet01"`, `"testnet04"`, and for StoaChain `"stoa"`). It is the field
 * pinned for the network-identity gate: a Stoa node reports
 * `nodeVersion === KADENA_NETWORK`. The SDK's own `/info` health check inspects
 * only the HTTP status, so the body schema is not typed in the SDK dist — this
 * is the minimal real shape, NOT a fictional `network: "stoa"` field.
 */
export interface NodeInfo {
  readonly nodeVersion?: string;
  readonly nodeApiVersion?: string;
  readonly nodeChains?: readonly string[];
}

/**
 * The single network-read boundary, injectable so tests stub it and stay fully
 * off-network. `readNodeInfo` issues the `GET {origin}/info` read with the
 * forwarded abort signal and returns the parsed body. The live default
 * (see `customNodeValidation.live.ts`) wires a bounded-timeout `fetch`.
 */
export interface NodeInfoReadDeps {
  readNodeInfo: (origin: string, signal: AbortSignal) => Promise<NodeInfo>;
}

/** Options for {@link probeCustomNode} / {@link validateAndProbe}. */
export interface ProbeOptions {
  /** Caller abort seam (UI cancels on unmount / superseding Apply). */
  signal?: AbortSignal;
  /** Bounded probe timeout in ms. Defaults to {@link PROBE_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Injected network-read seam; the live default is lazily imported. */
  deps?: NodeInfoReadDeps;
}

/**
 * Pure shape/scheme gate. Parses with `new URL`, enforces the https-only
 * allow-list, and returns the ORIGIN-only normalized URL (matching what the
 * SDK `setNodeConfig` custom path will accept). The raw input is never logged.
 */
export function validateCustomNodeUrl(raw: string): ValidateUrlResult {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'malformed-url' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'insecure-scheme' };
  }

  return { ok: true, url: parsed.origin };
}

/** Lazily resolve the live `/info` read seam so the barrel stays browser-safe. */
async function defaultDeps(): Promise<NodeInfoReadDeps> {
  const { makeLiveNodeInfoReadDeps } = await import('./customNodeValidation.live');
  return makeLiveNodeInfoReadDeps();
}

/**
 * Live reachability + network-identity gate. Issues a `/info` read against the
 * candidate origin with a bounded timeout and the caller's abort signal.
 *
 * NEVER throws — every outcome is a discriminated result:
 *   - a read rejection (fetch failure, timeout, or abort) → `unreachable`;
 *   - a reachable node whose `nodeVersion` is not `KADENA_NETWORK` → `wrong-network`.
 *
 * Abort contract (RR#7): an aborted signal — whether already aborted on entry or
 * aborting mid-flight — resolves as the documented non-error early return
 * `{ ok:false, reason:"unreachable" }`, NOT a thrown AbortError. An already-
 * aborted signal short-circuits without issuing the read.
 *
 * SPV reachability (RR#4): the probe confirms reachability of the candidate
 * HOST via `/info` only; it does NOT separately probe the SPV endpoint family.
 * A custom node applies to BOTH pact and SPV (same origin), so an `/info`-
 * reachable host is treated as reachable for both. The residual limitation — a
 * host serving pact but not SPV — is surfaced via the no-failover degrade in
 * the trust warning (a custom node has no node1/node2 fallback), not here.
 */
export async function probeCustomNode(
  url: string,
  opts: ProbeOptions = {},
): Promise<ProbeResult> {
  if (opts.signal?.aborted) {
    return { ok: false, reason: 'unreachable' };
  }

  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const deps = opts.deps ?? (await defaultDeps());

  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const info = await deps.readNodeInfo(url, controller.signal);
    if (info.nodeVersion !== KADENA_NETWORK) {
      return { ok: false, reason: 'wrong-network' };
    }
    return { ok: true };
  } catch {
    // A network failure, timeout, or abort all collapse to the same non-error
    // early return — the reason code carries no URL into any caught Error.
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * Convenience chain: shape gate first (short-circuits on a shape failure without
 * issuing any network read), then the live probe against the origin-only URL.
 * Returns the union of all four reasons so the UI can message each distinctly.
 */
export async function validateAndProbe(
  raw: string,
  opts: ProbeOptions = {},
): Promise<ValidateAndProbeResult> {
  const shape = validateCustomNodeUrl(raw);
  if (!shape.ok) return shape;

  const probe = await probeCustomNode(shape.url, opts);
  if (!probe.ok) return probe;

  return { ok: true, url: shape.url };
}
