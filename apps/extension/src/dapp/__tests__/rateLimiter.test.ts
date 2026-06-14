import { describe, expect, it } from 'vitest';

import {
  MAX_CONNECT_REQUESTS_PER_WINDOW,
  RATELIMIT_WINDOW_MS,
  RequestRateLimiter,
  type RateLimiterState,
} from '../rateLimiter';

/**
 * Connection-request rate limiter — pure policy with an INJECTED CLOCK.
 *
 * The limiter throttles the dApp spam vector: an origin that fires connection /
 * approval-triggering requests faster than the documented cap is told to back
 * off. The logic is deterministic because time enters only through an injected
 * `now()` — no real `Date.now()` or timers — which is the same state-based
 * testing discipline the Phase-7 idle auto-lock uses. RR#9 requires the budget
 * to survive a service-worker respawn, so the limiter exposes
 * `getState`/`loadState` for the T9.6 router to persist + rehydrate.
 */

/** A controllable clock: advance time explicitly, never wall-clock. */
function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const ORIGIN_A = 'https://app-a.example';
const ORIGIN_B = 'https://app-b.example';

describe('RequestRateLimiter — named, documented caps', () => {
  it('exposes the per-window cap as a named positive constant, not a magic literal', () => {
    expect(MAX_CONNECT_REQUESTS_PER_WINDOW).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_CONNECT_REQUESTS_PER_WINDOW)).toBe(true);
  });

  it('exposes the rolling-window length as a named positive constant', () => {
    expect(RATELIMIT_WINDOW_MS).toBeGreaterThan(0);
  });
});

describe('RequestRateLimiter — rolling-window throttling (injected clock)', () => {
  it('allows exactly the cap within one window and blocks the very next request', () => {
    const clock = fakeClock();
    const limiter = new RequestRateLimiter({ now: clock.now });

    for (let i = 0; i < MAX_CONNECT_REQUESTS_PER_WINDOW; i++) {
      expect(limiter.check(ORIGIN_A).allowed).toBe(true);
    }

    const overflow = limiter.check(ORIGIN_A);
    expect(overflow.allowed).toBe(false);
    // A blocked caller must be told how long to wait. With the clock frozen the
    // oldest request ages 0ms, so the full window remains before it expires.
    expect(overflow.retryAfterMs).toBe(RATELIMIT_WINDOW_MS);
  });

  it('reports a shrinking retryAfterMs as the oldest request ages toward expiry', () => {
    const clock = fakeClock();
    const limiter = new RequestRateLimiter({ now: clock.now });

    for (let i = 0; i < MAX_CONNECT_REQUESTS_PER_WINDOW; i++) {
      limiter.check(ORIGIN_A);
    }

    clock.advance(1000);
    const blocked = limiter.check(ORIGIN_A);
    expect(blocked.allowed).toBe(false);
    // The oldest of the capped requests is now 1000ms old, so only the remainder
    // of the window is left before the budget frees up.
    expect(blocked.retryAfterMs).toBe(RATELIMIT_WINDOW_MS - 1000);
  });

  it('resets the budget once the clock advances past the rolling window', () => {
    const clock = fakeClock();
    const limiter = new RequestRateLimiter({ now: clock.now });

    for (let i = 0; i < MAX_CONNECT_REQUESTS_PER_WINDOW; i++) {
      limiter.check(ORIGIN_A);
    }
    expect(limiter.check(ORIGIN_A).allowed).toBe(false);

    // Stepping one millisecond past the window expires every recorded request.
    clock.advance(RATELIMIT_WINDOW_MS + 1);
    expect(limiter.check(ORIGIN_A).allowed).toBe(true);
  });

  it('partially refills as individual requests age out of the window, not all at once', () => {
    const clock = fakeClock();
    const limiter = new RequestRateLimiter({ now: clock.now });

    // First request at t0, the rest 10ms later.
    limiter.check(ORIGIN_A);
    clock.advance(10);
    for (let i = 1; i < MAX_CONNECT_REQUESTS_PER_WINDOW; i++) {
      limiter.check(ORIGIN_A);
    }
    expect(limiter.check(ORIGIN_A).allowed).toBe(false);

    // Advance just enough to expire ONLY the first (t0) request: exactly one slot
    // frees, so exactly one more request is allowed, then we are capped again.
    clock.advance(RATELIMIT_WINDOW_MS - 10 + 1);
    expect(limiter.check(ORIGIN_A).allowed).toBe(true);
    expect(limiter.check(ORIGIN_A).allowed).toBe(false);
  });
});

describe('RequestRateLimiter — per-origin isolation', () => {
  it('does not let one origin exhausting its budget block a different origin', () => {
    const clock = fakeClock();
    const limiter = new RequestRateLimiter({ now: clock.now });

    for (let i = 0; i < MAX_CONNECT_REQUESTS_PER_WINDOW; i++) {
      limiter.check(ORIGIN_A);
    }
    expect(limiter.check(ORIGIN_A).allowed).toBe(false);

    // Origin B is untouched and starts with a full budget.
    expect(limiter.check(ORIGIN_B).allowed).toBe(true);
  });
});

describe('RequestRateLimiter — RR#9 persistence seam (getState / loadState)', () => {
  it('round-trips state so a respawned limiter keeps an exhausted budget within the window', () => {
    const clock = fakeClock();
    const limiter = new RequestRateLimiter({ now: clock.now });

    for (let i = 0; i < MAX_CONNECT_REQUESTS_PER_WINDOW; i++) {
      limiter.check(ORIGIN_A);
    }
    expect(limiter.check(ORIGIN_A).allowed).toBe(false);

    // Serialize, then simulate a service-worker respawn: a brand-new instance
    // sharing the SAME clock rehydrates the recorded timestamps.
    const persisted: RateLimiterState = limiter.getState();
    const respawned = new RequestRateLimiter({ now: clock.now });
    respawned.loadState(persisted);

    // The budget is still spent — spamming until the SW idles no longer bypasses
    // the limiter, because the timestamps survived the respawn.
    expect(respawned.check(ORIGIN_A).allowed).toBe(false);
  });

  it('persisted state is JSON-serializable (survives a structured/JSON storage round-trip)', () => {
    const clock = fakeClock();
    const limiter = new RequestRateLimiter({ now: clock.now });
    limiter.check(ORIGIN_A);
    limiter.check(ORIGIN_B);

    const json = JSON.stringify(limiter.getState());
    const revived = JSON.parse(json) as RateLimiterState;

    const respawned = new RequestRateLimiter({ now: clock.now });
    respawned.loadState(revived);

    // Both origins' single recorded request carries over: each still has cap-1
    // allowances left, so cap-1 more succeed and the cap-th is blocked.
    for (let i = 1; i < MAX_CONNECT_REQUESTS_PER_WINDOW; i++) {
      expect(respawned.check(ORIGIN_A).allowed).toBe(true);
    }
    expect(respawned.check(ORIGIN_A).allowed).toBe(false);
  });

  it('rehydration drops timestamps that already expired before the respawn', () => {
    const clock = fakeClock();
    const limiter = new RequestRateLimiter({ now: clock.now });
    for (let i = 0; i < MAX_CONNECT_REQUESTS_PER_WINDOW; i++) {
      limiter.check(ORIGIN_A);
    }
    const persisted = limiter.getState();

    // Time passes beyond the window while the worker is asleep; on rehydrate the
    // stale timestamps must not count against the budget.
    clock.advance(RATELIMIT_WINDOW_MS + 1);
    const respawned = new RequestRateLimiter({ now: clock.now });
    respawned.loadState(persisted);

    expect(respawned.check(ORIGIN_A).allowed).toBe(true);
  });

  it('loadState tolerates an absent/empty persisted blob (first-ever boot)', () => {
    const clock = fakeClock();
    const limiter = new RequestRateLimiter({ now: clock.now });
    expect(() => limiter.loadState(undefined)).not.toThrow();
    expect(limiter.check(ORIGIN_A).allowed).toBe(true);
  });
});
