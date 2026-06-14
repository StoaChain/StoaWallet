/**
 * Connection-request rate limiter for the dApp provider — a pure, deterministic
 * rolling-window policy.
 *
 * THE THREAT: a hostile or buggy dApp can spam connection / approval-triggering
 * requests (`kda_connect`, `kda_requestSign`, …) to wear the user down into
 * approving, or to flood the approval UI. This limiter caps how many such
 * requests a single origin may make inside a rolling time window, telling the
 * caller how long to back off once it overflows.
 *
 * DETERMINISM (injected clock): time enters ONLY through the injected `now()` —
 * never `Date.now()` and never a timer. Advancing the injected clock past the
 * window expires the recorded requests and refills the budget. This mirrors the
 * Phase-7 idle auto-lock's state-based testing discipline: the policy is a pure
 * function of (recorded timestamps, now), so every behaviour is reproducible.
 *
 * SCOPE: this throttles the spam vector — connection/approval-triggering ops.
 * Read-only status pings (`kda_checkStatus`, `isConnected`) are NOT routed
 * through `check()` by the T9.6 router, so they stay responsive; this module
 * holds no opinion about them beyond not being asked.
 *
 * RR#9 PERSISTENCE SEAM: an in-memory-only limiter resets on every MV3
 * service-worker respawn, so an attacker bypasses it by spamming until the
 * worker idles and is torn down. To prevent that, the entire limiter state is
 * SERIALIZABLE: `getState()` returns a plain JSON-safe object of per-origin
 * timestamps and `loadState()` rehydrates it (dropping anything already expired
 * relative to `now()`). The T9.6 router owns the actual storage I/O — it
 * persists `getState()` under `DAPP_RATELIMIT_KEY` via the ChromeStorageAdapter
 * after each accounted request and calls `loadState()` on boot. This module
 * stays pure and clock-injected; it performs NO storage I/O itself.
 *
 * SECRETS: the state is public-only — request timestamps keyed by origin. No
 * key material, no `console.*`.
 */

/**
 * Maximum connection/approval-triggering requests a single origin may make
 * within one {@link RATELIMIT_WINDOW_MS} window before being throttled. Chosen
 * to comfortably cover a legitimate connect → sign retry burst while still
 * cutting off automated spam.
 */
export const MAX_CONNECT_REQUESTS_PER_WINDOW = 10;

/** Length of the rolling window the cap is measured over (one minute). */
export const RATELIMIT_WINDOW_MS = 60_000;

export interface RateLimiterDeps {
  /** Time source; defaults to `Date.now` only at the impure edge, never in tests. */
  readonly now?: () => number;
  /** Override the per-origin cap (defaults to {@link MAX_CONNECT_REQUESTS_PER_WINDOW}). */
  readonly maxPerWindow?: number;
  /** Override the rolling-window length in ms (defaults to {@link RATELIMIT_WINDOW_MS}). */
  readonly windowMs?: number;
}

export interface RateLimitDecision {
  /** Whether this request is within budget and may proceed. */
  readonly allowed: boolean;
  /** When blocked, the ms until the oldest in-window request expires and a slot frees. */
  readonly retryAfterMs?: number;
}

/**
 * Serializable snapshot of the limiter — a map of origin → the epoch-ms
 * timestamps of its in-window requests. JSON-safe so the T9.6 router can persist
 * it under `DAPP_RATELIMIT_KEY` and rehydrate it across SW respawns.
 */
export interface RateLimiterState {
  readonly origins: Record<string, number[]>;
}

export class RequestRateLimiter {
  private readonly now: () => number;
  private readonly maxPerWindow: number;
  private readonly windowMs: number;

  /** origin → sorted-ascending timestamps of its in-window requests. */
  private readonly buckets = new Map<string, number[]>();

  constructor(deps: RateLimiterDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.maxPerWindow = deps.maxPerWindow ?? MAX_CONNECT_REQUESTS_PER_WINDOW;
    this.windowMs = deps.windowMs ?? RATELIMIT_WINDOW_MS;
  }

  /**
   * Account one connection/approval-triggering request from `origin`. Returns
   * whether it is within budget; when blocked, `retryAfterMs` is the wait until
   * the oldest in-window request for that origin expires. A blocked request is
   * NOT recorded, so being throttled cannot push the reset point further out.
   */
  check(origin: string): RateLimitDecision {
    const t = this.now();
    const live = this.prune(origin, t);

    if (live.length >= this.maxPerWindow) {
      const oldest = live[0];
      const retryAfterMs = oldest + this.windowMs - t;
      return { allowed: false, retryAfterMs };
    }

    live.push(t);
    this.buckets.set(origin, live);
    return { allowed: true };
  }

  /** Serializable snapshot for the T9.6 router to persist across SW respawns. */
  getState(): RateLimiterState {
    const origins: Record<string, number[]> = {};
    for (const [origin, stamps] of this.buckets) {
      origins[origin] = [...stamps];
    }
    return { origins };
  }

  /**
   * Rehydrate from a persisted snapshot. Tolerates an absent blob (first boot)
   * and discards any timestamp that has already aged out of the window relative
   * to the current clock, so a long SW sleep cannot wrongly keep a budget spent.
   */
  loadState(state: RateLimiterState | null | undefined): void {
    this.buckets.clear();
    if (!state || !state.origins) return;
    const t = this.now();
    const cutoff = t - this.windowMs;
    for (const [origin, stamps] of Object.entries(state.origins)) {
      const live = stamps.filter((ts) => ts > cutoff).sort((a, b) => a - b);
      if (live.length > 0) {
        this.buckets.set(origin, live);
      }
    }
  }

  /** Drop expired timestamps for an origin and return its live, sorted list. */
  private prune(origin: string, t: number): number[] {
    const cutoff = t - this.windowMs;
    const existing = this.buckets.get(origin) ?? [];
    return existing.filter((ts) => ts > cutoff);
  }
}
