import { InMemoryStorageAdapter } from '@stoawallet/core/testing';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ADVANCED_MODE,
  getAdvancedMode,
  setAdvancedMode,
} from '../advancedModePreference';
import { ADVANCED_MODE_KEY } from '../../storage/storageKeys';

describe('advancedModePreference', () => {
  it('defaults to OFF on a fresh install (absent key)', async () => {
    const storage = new InMemoryStorageAdapter();
    expect(await getAdvancedMode(storage)).toBe(false);
  });

  it('persists ON under the registry key and reads it back after a reload', async () => {
    const storage = new InMemoryStorageAdapter();
    await setAdvancedMode(storage, true);
    // Written under the shared registry key (not an inlined literal), so the
    // reset/wipe path that enumerates STORAGE_KEYS can actually clear it.
    const raw = await storage.get(ADVANCED_MODE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({ enabled: true });
    expect(await getAdvancedMode(storage)).toBe(true);
  });

  it('turns back OFF once enabled — presence of the blob is not "enabled"', async () => {
    const storage = new InMemoryStorageAdapter();
    await setAdvancedMode(storage, true);
    await setAdvancedMode(storage, false);
    expect(await getAdvancedMode(storage)).toBe(false);
  });

  it('degrades a non-JSON or structurally-wrong blob to the default instead of throwing', async () => {
    const storage = new InMemoryStorageAdapter();
    await storage.set(ADVANCED_MODE_KEY, 'not json');
    await expect(getAdvancedMode(storage)).resolves.toBe(DEFAULT_ADVANCED_MODE);
    await storage.set(ADVANCED_MODE_KEY, JSON.stringify({ nope: true }));
    await expect(getAdvancedMode(storage)).resolves.toBe(DEFAULT_ADVANCED_MODE);
    await storage.set(ADVANCED_MODE_KEY, 'null');
    await expect(getAdvancedMode(storage)).resolves.toBe(DEFAULT_ADVANCED_MODE);
    // A tampered/legacy truthy non-boolean must NOT coerce advanced mode on.
    await storage.set(ADVANCED_MODE_KEY, JSON.stringify({ enabled: 'yes' }));
    await expect(getAdvancedMode(storage)).resolves.toBe(DEFAULT_ADVANCED_MODE);
  });

  it('reads a blob a backend returned as bytes (Uint8Array), not only as a string', async () => {
    const storage = new InMemoryStorageAdapter();
    await storage.set(
      ADVANCED_MODE_KEY,
      new TextEncoder().encode(JSON.stringify({ enabled: true })),
    );
    expect(await getAdvancedMode(storage)).toBe(true);
  });
});
