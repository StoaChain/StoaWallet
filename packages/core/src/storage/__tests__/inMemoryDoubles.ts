/**
 * Re-export of the shared in-memory doubles, now single-sourced at
 * `packages/core/src/testing/inMemory.ts` (exposed as `@stoawallet/core/testing`).
 * Kept as a thin alias so existing core suites importing the old path still
 * resolve the SAME canonical implementation.
 */
export {
  InMemoryStorageAdapter,
  InMemoryKeyVault,
} from '../../testing/inMemory';
