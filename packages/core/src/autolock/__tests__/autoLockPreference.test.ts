import { InMemoryStorageAdapter } from '@stoawallet/core/testing';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AUTO_LOCK_MINUTES,
  MAX_AUTO_LOCK_MINUTES,
  MIN_AUTO_LOCK_MINUTES,
  clampAutoLockMinutes,
  getAutoLockMinutes,
  setAutoLockMinutes,
} from '../autoLockPreference';
import { AUTO_LOCK_KEY } from '../../storage/storageKeys';

describe('autoLockPreference', () => {
  it('defaults to 5 minutes on a fresh install (absent key)', async () => {
    const storage = new InMemoryStorageAdapter();
    expect(DEFAULT_AUTO_LOCK_MINUTES).toBe(5);
    expect(await getAutoLockMinutes(storage)).toBe(5);
  });

  it('persists and reads back a chosen option value', async () => {
    const storage = new InMemoryStorageAdapter();
    await setAutoLockMinutes(storage, 15);
    expect(await getAutoLockMinutes(storage)).toBe(15);
    await setAutoLockMinutes(storage, 30);
    expect(await getAutoLockMinutes(storage)).toBe(30);
  });

  it('SNAPS an out-of-set value to the nearest allowed option {5,15,30,60}', async () => {
    const storage = new InMemoryStorageAdapter();
    expect(await setAutoLockMinutes(storage, 99)).toBe(MAX_AUTO_LOCK_MINUTES); // 60
    expect(await getAutoLockMinutes(storage)).toBe(60);
    expect(await setAutoLockMinutes(storage, 0)).toBe(MIN_AUTO_LOCK_MINUTES); // 5
    expect(await getAutoLockMinutes(storage)).toBe(5);
    // 20 is nearer 15 than 30; 44 is nearer 30 than 60.
    expect(await setAutoLockMinutes(storage, 20)).toBe(15);
    expect(await setAutoLockMinutes(storage, 44)).toBe(30);
  });

  it('snaps a fractional / non-finite minute to an allowed option', () => {
    expect(clampAutoLockMinutes(4.6)).toBe(5);
    expect(clampAutoLockMinutes(13)).toBe(15);
    expect(clampAutoLockMinutes(Number.NaN)).toBe(DEFAULT_AUTO_LOCK_MINUTES);
  });

  it('degrades a corrupt or out-of-range stored blob to a sane value', async () => {
    const storage = new InMemoryStorageAdapter();
    await storage.set(AUTO_LOCK_KEY, '{ not json');
    expect(await getAutoLockMinutes(storage)).toBe(DEFAULT_AUTO_LOCK_MINUTES);
    await storage.set(AUTO_LOCK_KEY, JSON.stringify({ minutes: 999 }));
    expect(await getAutoLockMinutes(storage)).toBe(MAX_AUTO_LOCK_MINUTES); // 60
    await storage.set(AUTO_LOCK_KEY, JSON.stringify({ nope: true }));
    expect(await getAutoLockMinutes(storage)).toBe(DEFAULT_AUTO_LOCK_MINUTES);
  });
});
