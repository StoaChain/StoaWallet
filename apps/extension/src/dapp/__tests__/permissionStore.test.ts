import { describe, expect, it, vi } from 'vitest';

import { DAPP_PERMISSIONS_KEY } from '@stoawallet/core';
import { InMemoryStorageAdapter } from '@stoawallet/core/testing';

import { DAppPermissionStore } from '../permissionStore';

/**
 * Security-critical unit tests for the per-origin REJECT-BY-DEFAULT dApp
 * permission allow-list.
 *
 * The non-negotiable invariant is that NOTHING is connected until the user
 * explicitly approves it: a fresh store must reject EVERY origin, and the only
 * way an origin becomes allowed is an explicit `allow()` (which the connect
 * flow calls only after approval). Origins are keyed by their canonical
 * serialized origin (scheme+host+port) so a path/query cannot smuggle a
 * different origin in.
 *
 * The injected `StorageAdapter` is the Phase-7 in-memory double, standing in
 * for `chrome.storage.local`; persistence is asserted by re-hydrating a fresh
 * store from the SAME adapter and observing the connection survived.
 */

describe('DAppPermissionStore', () => {
  describe('reject-by-default invariant', () => {
    it('rejects EVERY origin on a fresh store because nothing is connected until explicitly approved', async () => {
      const store = await DAppPermissionStore.load(new InMemoryStorageAdapter());

      // No origin has ever been approved, so each of these distinct origins
      // must be rejected — there is no implicit, wildcard, or auto-allow path.
      await expect(store.isAllowed('https://app.stoachain.com')).resolves.toBe(false);
      await expect(store.isAllowed('https://explorer.stoachain.com')).resolves.toBe(false);
      await expect(store.isAllowed('http://localhost:3000')).resolves.toBe(false);
      await expect(store.isAllowed('https://evil.com')).resolves.toBe(false);
    });

    it('lists nothing on a fresh store so the management UI shows zero connections', async () => {
      const store = await DAppPermissionStore.load(new InMemoryStorageAdapter());
      expect(await store.listAllowed()).toEqual([]);
    });
  });

  describe('allow / revoke lifecycle', () => {
    it('allows an origin only after an explicit allow() call so approval is the sole gate', async () => {
      const store = await DAppPermissionStore.load(new InMemoryStorageAdapter());

      await expect(store.isAllowed('https://app.stoachain.com')).resolves.toBe(false);
      await store.allow('https://app.stoachain.com');
      await expect(store.isAllowed('https://app.stoachain.com')).resolves.toBe(true);
    });

    it('does not allow a DIFFERENT origin when one origin is approved so approval does not leak across sites', async () => {
      const store = await DAppPermissionStore.load(new InMemoryStorageAdapter());

      await store.allow('https://app.stoachain.com');
      await expect(store.isAllowed('https://evil.com')).resolves.toBe(false);
    });

    it('rejects an origin again after revoke() so a disconnect actually severs access', async () => {
      const store = await DAppPermissionStore.load(new InMemoryStorageAdapter());

      await store.allow('https://app.stoachain.com');
      await store.revoke('https://app.stoachain.com');
      await expect(store.isAllowed('https://app.stoachain.com')).resolves.toBe(false);
    });

    it('rejects an origin again after disconnect() since disconnect is the user-facing alias of revoke', async () => {
      const store = await DAppPermissionStore.load(new InMemoryStorageAdapter());

      await store.allow('https://app.stoachain.com');
      await store.disconnect('https://app.stoachain.com');
      await expect(store.isAllowed('https://app.stoachain.com')).resolves.toBe(false);
    });

    it('lists exactly the connected origins so the disconnect UI reflects real grants', async () => {
      const store = await DAppPermissionStore.load(new InMemoryStorageAdapter());

      await store.allow('https://app.stoachain.com');
      await store.allow('https://explorer.stoachain.com');
      await store.revoke('https://explorer.stoachain.com');

      expect(await store.listAllowed()).toEqual(['https://app.stoachain.com']);
    });

    it('returns the persisted approved account SUBSET for a connected origin (the set checkStatus reads back)', async () => {
      const store = await DAppPermissionStore.load(new InMemoryStorageAdapter());

      // The user approved exposing ONLY acct-1 of the available accounts.
      await store.allow(
        'https://app.stoachain.com',
        [{ address: 'k:acct-1', publicKey: 'acct-1' }],
        7,
      );

      expect(await store.accountsForOrigin('https://app.stoachain.com')).toEqual([
        { address: 'k:acct-1', publicKey: 'acct-1' },
      ]);
    });

    it('returns no accounts for an unconnected origin so a stranger reads back an empty set', async () => {
      const store = await DAppPermissionStore.load(new InMemoryStorageAdapter());
      expect(await store.accountsForOrigin('https://stranger.test')).toEqual([]);
    });

    it('persists the approved subset across a re-hydrated store (survives an SW respawn)', async () => {
      const adapter = new InMemoryStorageAdapter();
      const store = await DAppPermissionStore.load(adapter);
      await store.allow('https://app.test', [{ address: 'k:a', publicKey: 'a' }], 1);

      // Respawn: a brand-new store rehydrated from the SAME persisted backing.
      const rehydrated = await DAppPermissionStore.load(adapter);
      expect(await rehydrated.accountsForOrigin('https://app.test')).toEqual([
        { address: 'k:a', publicKey: 'a' },
      ]);
    });
  });

  describe('canonical-origin keying (anti-masquerade)', () => {
    it('collapses same-origin URLs that differ only by path/query to ONE entry so a path cannot fork a grant', async () => {
      const store = await DAppPermissionStore.load(new InMemoryStorageAdapter());

      await store.allow('https://app.stoachain.com/connect?session=1');
      await store.allow('https://app.stoachain.com/dashboard#tab');

      // Both URLs share the origin https://app.stoachain.com, so the allow-list
      // holds a single canonical entry, not two.
      expect(await store.listAllowed()).toEqual(['https://app.stoachain.com']);
      await expect(store.isAllowed('https://app.stoachain.com/anything/else')).resolves.toBe(true);
    });

    it('keeps a malicious path-embedded host from masquerading as the real origin so evil.com/app.stoachain.com stays evil.com', async () => {
      const store = await DAppPermissionStore.load(new InMemoryStorageAdapter());

      // Approving the attacker page must NOT grant the impersonated host: the
      // canonical origin of this URL is https://evil.com, not the victim.
      await store.allow('https://evil.com/app.stoachain.com');

      await expect(store.isAllowed('https://app.stoachain.com')).resolves.toBe(false);
      await expect(store.isAllowed('https://evil.com')).resolves.toBe(true);
      expect(await store.listAllowed()).toEqual(['https://evil.com']);
    });

    it('treats different ports as distinct origins so localhost:3000 and localhost:4000 are separate grants', async () => {
      const store = await DAppPermissionStore.load(new InMemoryStorageAdapter());

      await store.allow('http://localhost:3000');
      await expect(store.isAllowed('http://localhost:4000')).resolves.toBe(false);
      await expect(store.isAllowed('http://localhost:3000')).resolves.toBe(true);
    });
  });

  describe('persistence across service-worker restart', () => {
    it('survives re-instantiation from the same adapter so a SW restart keeps the grant', async () => {
      const adapter = new InMemoryStorageAdapter();

      const first = await DAppPermissionStore.load(adapter);
      await first.allow('https://app.stoachain.com');

      // A new store hydrated from the SAME persisted blob (the SW restarted)
      // must still recognize the previously-approved origin.
      const rehydrated = await DAppPermissionStore.load(adapter);
      await expect(rehydrated.isAllowed('https://app.stoachain.com')).resolves.toBe(true);
    });

    it('removes a revoked origin from the persisted set so a restart does not resurrect it', async () => {
      const adapter = new InMemoryStorageAdapter();

      const first = await DAppPermissionStore.load(adapter);
      await first.allow('https://app.stoachain.com');
      await first.revoke('https://app.stoachain.com');

      const rehydrated = await DAppPermissionStore.load(adapter);
      await expect(rehydrated.isAllowed('https://app.stoachain.com')).resolves.toBe(false);
    });

    it('persists under the shared DAPP_PERMISSIONS_KEY so it does not collide with another feature blob', async () => {
      const adapter = new InMemoryStorageAdapter();
      const store = await DAppPermissionStore.load(adapter);

      await store.allow('https://app.stoachain.com');

      // The grant must be readable back under exactly the registry key — proving
      // the store went through the adapter under the canonical key, not a stray
      // literal.
      const raw = await adapter.get(DAPP_PERMISSIONS_KEY);
      expect(raw).not.toBeNull();
      expect(String(raw)).toContain('https://app.stoachain.com');
    });

    it('never persists key material — only the public origin string is stored', async () => {
      const adapter = new InMemoryStorageAdapter();
      const store = await DAppPermissionStore.load(adapter);

      await store.allow('https://app.stoachain.com', [
        { address: 'k:abc', publicKey: 'pub-abc' },
      ]);

      const raw = String(await adapter.get(DAPP_PERMISSIONS_KEY));
      // Public account data is allowed; there must be no private/secret key
      // field smuggled into the persisted blob.
      expect(raw).not.toContain('privateKey');
      expect(raw).not.toContain('secretKey');
      expect(raw).not.toContain('mnemonic');
    });
  });

  describe('tabId tracking (RR#11 — event routing)', () => {
    it('records the tabId an origin connected from so events route to the right tab', async () => {
      const store = await DAppPermissionStore.load(new InMemoryStorageAdapter());

      await store.allow('https://app.stoachain.com', undefined, 42);
      expect(await store.tabIdsForOrigin('https://app.stoachain.com')).toEqual([42]);
    });

    it('accumulates multiple tabs for one origin so a dApp open in two tabs gets events in both', async () => {
      const store = await DAppPermissionStore.load(new InMemoryStorageAdapter());

      await store.allow('https://app.stoachain.com', undefined, 42);
      await store.allow('https://app.stoachain.com', undefined, 99);

      expect((await store.tabIdsForOrigin('https://app.stoachain.com')).sort((a, b) => a - b)).toEqual([
        42, 99,
      ]);
    });

    it('does not duplicate a tabId when the same tab reconnects so the event fan-out has no repeats', async () => {
      const store = await DAppPermissionStore.load(new InMemoryStorageAdapter());

      await store.allow('https://app.stoachain.com', undefined, 42);
      await store.allow('https://app.stoachain.com', undefined, 42);

      expect(await store.tabIdsForOrigin('https://app.stoachain.com')).toEqual([42]);
    });

    it('returns no tabIds for an origin that was never connected so a lookup on an unknown origin is empty', async () => {
      const store = await DAppPermissionStore.load(new InMemoryStorageAdapter());
      expect(await store.tabIdsForOrigin('https://app.stoachain.com')).toEqual([]);
    });

    it('keys tabIds by canonical origin so a path-bearing connect URL still routes by origin', async () => {
      const store = await DAppPermissionStore.load(new InMemoryStorageAdapter());

      await store.allow('https://app.stoachain.com/connect?x=1', undefined, 7);
      expect(await store.tabIdsForOrigin('https://app.stoachain.com')).toEqual([7]);
    });

    it('persists tabIds across re-instantiation so a restarted SW still knows where to deliver events', async () => {
      const adapter = new InMemoryStorageAdapter();

      const first = await DAppPermissionStore.load(adapter);
      await first.allow('https://app.stoachain.com', undefined, 42);

      const rehydrated = await DAppPermissionStore.load(adapter);
      expect(await rehydrated.tabIdsForOrigin('https://app.stoachain.com')).toEqual([42]);
    });
  });

  describe('logging hygiene', () => {
    it('never console-logs across the allow/isAllowed path so no stored value leaks to logs', async () => {
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation(() => {}),
      );

      const store = await DAppPermissionStore.load(new InMemoryStorageAdapter());
      await store.allow('https://app.stoachain.com', undefined, 42);
      await store.isAllowed('https://app.stoachain.com');

      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
      vi.restoreAllMocks();
    });
  });
});
