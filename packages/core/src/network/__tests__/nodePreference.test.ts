import { afterEach, describe, expect, it, vi } from 'vitest';

import { InMemoryStorageAdapter } from '@stoawallet/core/testing';

import {
  getNodePreference,
  setNodePreference,
  type NodePreference,
} from '../nodePreference';
import { NODE_PREFERENCE_KEY } from '../../storage/storageKeys';

/**
 * The node-preference layer is non-secret config persisted under the shared
 * `NODE_PREFERENCE_KEY`. The contract these tests pin: a custom preference
 * round-trips through storage; an absent key reads back as the node1-primary
 * default WITHOUT a throw (backward compat); a corrupt blob degrades to a
 * SURFACED default (`recoveredFromCorrupt: true`) so a later phase can show a
 * one-time reset notice; the (de)serialization validator rejects shapes that
 * pair `kind` with the wrong `customUrl` presence; and the user's custom URL
 * never reaches a console/logger.
 */
describe('nodePreference', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('round-trips a custom preference: set then get returns the same kind and customUrl', async () => {
    const adapter = new InMemoryStorageAdapter();
    const pref: NodePreference = {
      kind: 'custom',
      customUrl: 'https://my-node.example.com',
    };

    await setNodePreference(adapter, pref);

    // Drives the expectation from the value we persisted, not a constant: if
    // serialization dropped or mangled customUrl, the read-back would differ.
    expect(await getNodePreference(adapter)).toEqual({
      kind: 'custom',
      customUrl: 'https://my-node.example.com',
    });
  });

  it('round-trips the node2 preference without attaching a customUrl', async () => {
    const adapter = new InMemoryStorageAdapter();

    await setNodePreference(adapter, { kind: 'node2' });

    const read = await getNodePreference(adapter);
    expect(read).toEqual({ kind: 'node2' });
    // A non-custom kind must NOT carry a URL through the round-trip.
    expect(read.customUrl).toBeUndefined();
  });

  it('reads an absent key back as the node1-primary default WITHOUT throwing (XP-11 backward compat)', async () => {
    const adapter = new InMemoryStorageAdapter();

    // Nothing was ever written: a fresh install must boot the default, not error.
    const read = await getNodePreference(adapter);
    expect(read).toEqual({ kind: 'default' });
    // A clean default is DISTINCT from a recovered one — it must not be flagged.
    expect(read.recoveredFromCorrupt).toBeUndefined();
  });

  it('degrades a corrupt persisted blob to a SURFACED default (recoveredFromCorrupt) instead of throwing (RR#10)', async () => {
    const adapter = new InMemoryStorageAdapter();
    // A blob that is not valid JSON for our shape — e.g. the legacy raw "node2"
    // string configureNode used to write, or any tampered value.
    await adapter.set(NODE_PREFERENCE_KEY, 'not-json-{garbage');

    const read = await getNodePreference(adapter);
    // The reset must be surfaced so T10.5 can show a one-time notice; it is
    // strictly distinguishable from a clean default by the flag.
    expect(read).toEqual({ kind: 'default', recoveredFromCorrupt: true });
  });

  it('degrades structurally-valid JSON that is not a node preference to a surfaced default', async () => {
    const adapter = new InMemoryStorageAdapter();
    // Parses as JSON but is not a NodePreference (unknown kind).
    await adapter.set(NODE_PREFERENCE_KEY, JSON.stringify({ kind: 'node99' }));

    expect(await getNodePreference(adapter)).toEqual({
      kind: 'default',
      recoveredFromCorrupt: true,
    });
  });

  it('rejects a custom preference that is missing its customUrl at set time (validator, not just type)', async () => {
    const adapter = new InMemoryStorageAdapter();

    // Cast away the type so we exercise the RUNTIME validator, not the compiler.
    await expect(
      setNodePreference(adapter, { kind: 'custom' } as NodePreference),
    ).rejects.toThrow();

    // A rejected write must NOT have persisted anything: the read stays default.
    expect(await getNodePreference(adapter)).toEqual({ kind: 'default' });
  });

  it('rejects a custom preference whose customUrl is an empty string', async () => {
    const adapter = new InMemoryStorageAdapter();

    await expect(
      setNodePreference(adapter, { kind: 'custom', customUrl: '' }),
    ).rejects.toThrow();
  });

  it('rejects a default/node2 preference that wrongly carries a customUrl', async () => {
    const adapter = new InMemoryStorageAdapter();

    await expect(
      setNodePreference(adapter, {
        kind: 'default',
        customUrl: 'https://sneaky.example.com',
      } as unknown as NodePreference),
    ).rejects.toThrow();

    await expect(
      setNodePreference(adapter, {
        kind: 'node2',
        customUrl: 'https://sneaky.example.com',
      } as unknown as NodePreference),
    ).rejects.toThrow();
  });

  it('never writes the custom URL to console/logger across a set then get cycle', async () => {
    const adapter = new InMemoryStorageAdapter();
    const secretUrl = 'https://private-rpc.example.internal/secret-path';
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'debug').mockImplementation(() => {}),
    ];

    await setNodePreference(adapter, { kind: 'custom', customUrl: secretUrl });
    await getNodePreference(adapter);

    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        const joined = call.map((arg) => String(arg)).join(' ');
        expect(joined).not.toContain(secretUrl);
      }
    }
  });
});
