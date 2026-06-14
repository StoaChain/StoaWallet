import { beforeEach, describe, expect, it } from 'vitest';

import type { KeyVault, StorageAdapter, UnlockedKey } from '../index';
import { InMemoryKeyVault, InMemoryStorageAdapter } from './inMemoryDoubles';

/**
 * Conformance test for the storage contract.
 *
 * The interfaces themselves are pure type declarations with no branching
 * logic, so they get no direct unit test. Instead, the in-memory doubles
 * — which implement BOTH interfaces — are exercised here. This proves the
 * contract is actually implementable AND pins the `lock()` post-condition
 * (clears the in-memory key, not merely flips a boolean) that every real
 * backer must honor.
 */
describe('StorageAdapter contract', () => {
  let adapter: StorageAdapter;

  beforeEach(() => {
    adapter = new InMemoryStorageAdapter();
  });

  it('returns null for a key that was never set, distinguishing absent from empty', async () => {
    // A backer must report a missing envelope as null so callers can branch
    // on "no wallet yet" vs. "wallet present" — returning '' would falsely
    // signal an existing (empty) envelope and skip onboarding.
    await expect(adapter.get('codex.envelope')).resolves.toBeNull();
  });

  it('round-trips a string blob so the encrypted envelope survives set→get', async () => {
    // smartEncrypt emits opaque strings; the adapter must hand back the exact
    // bytes it was given or decryption fails.
    await adapter.set('codex.envelope', 'cipher-text-blob');
    await expect(adapter.get('codex.envelope')).resolves.toBe('cipher-text-blob');
  });

  it('round-trips a Uint8Array blob without coercing it to a string', async () => {
    // The value type is `string | Uint8Array`; a binary envelope must come
    // back as the same bytes, not a stringified or truncated form.
    const blob = new Uint8Array([1, 2, 3, 250]);
    await adapter.set('codex.binary', blob);
    const out = await adapter.get('codex.binary');
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out as Uint8Array)).toEqual([1, 2, 3, 250]);
  });

  it('makes a removed key indistinguishable from one never written', async () => {
    // remove() is how a wallet reset wipes the at-rest envelope; after it,
    // a subsequent get must read as absent (null) so the app re-onboards.
    await adapter.set('codex.envelope', 'cipher-text-blob');
    await adapter.remove('codex.envelope');
    await expect(adapter.get('codex.envelope')).resolves.toBeNull();
  });
});

describe('KeyVault unlocked-key lifecycle', () => {
  let vault: KeyVault;
  const secret: UnlockedKey = new Uint8Array([7, 7, 7, 7]);

  beforeEach(() => {
    vault = new InMemoryKeyVault();
  });

  it('starts locked so a fresh background context never exposes a key', () => {
    expect(vault.isUnlocked()).toBe(false);
  });

  it('returns null from the key getter while locked rather than a stale key', () => {
    // The getter must not surface a key before unlock — callers gate signing
    // on a non-null key, so a stale/non-null value here would sign without
    // the user having authenticated.
    expect(vault.getUnlockedKey()).toBeNull();
  });

  it('exposes the supplied key after unlock so signing can read it in-memory', async () => {
    await vault.unlock(secret);
    expect(vault.isUnlocked()).toBe(true);
    expect(vault.getUnlockedKey()).toBe(secret);
  });

  it('CLEARS the in-memory key on lock(), not merely flipping isUnlocked to false', async () => {
    // This is the load-bearing post-condition: lock() must drop the key so an
    // attacker reading vault state after lock finds nothing. A boolean-only
    // lock that leaves the key resident would leak it in a memory dump.
    await vault.unlock(secret);
    expect(vault.getUnlockedKey()).toBe(secret);

    await vault.lock();

    expect(vault.isUnlocked()).toBe(false);
    expect(vault.getUnlockedKey()).toBeNull();
  });
});
