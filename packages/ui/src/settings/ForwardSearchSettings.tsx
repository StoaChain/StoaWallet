import {
  FORWARD_SEARCH_OPTIONS,
  getForwardSearchPref,
  setForwardSearchPref,
  type ForwardSearchPref,
} from '@stoawallet/core';
import { useEffect, useState, type ReactNode } from 'react';

import { useWallet } from '../context/WalletContext';
import styles from './ForwardSearchSettings.module.css';

/**
 * Wallet-wide ADVANCED setting: forward key search.
 *
 * Off by default — the wallet resolves a key only from what it HOLDS (pure +
 * added accounts). When ON, key resolution-by-address (e.g. "sign a message")
 * also probes a bounded range of derivation indices per seed (the depth) to find
 * an address a seed controls but hasn't added. Deeper finds more but is slower —
 * BIP32-Ed25519 derivation is expensive — so depth is capped at 100.
 */
export function ForwardSearchSettings(): ReactNode {
  const { storage } = useWallet();
  const [pref, setPref] = useState<ForwardSearchPref | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const p = await getForwardSearchPref(storage);
      if (alive) setPref(p);
    })();
    return () => {
      alive = false;
    };
  }, [storage]);

  async function update(patch: Partial<ForwardSearchPref>): Promise<void> {
    setSaving(true);
    try {
      setPref(await setForwardSearchPref(storage, patch));
    } finally {
      setSaving(false);
    }
  }

  const enabled = pref?.enabled ?? false;

  return (
    <section className={styles.section} data-testid="forward-search-settings">
      <h3 className={styles.heading}>Forward key search (advanced)</h3>
      <p className={styles.help}>
        Off by default — the wallet signs only with keys it holds (imported keys and added
        accounts). Turn this on to also search un-added derivation positions of your seeds when
        resolving an address (e.g. to sign a message proving you control it).
      </p>

      <label className={styles.toggleRow}>
        <span className={styles.label}>Search un-added positions</span>
        <input
          type="checkbox"
          data-testid="forward-search-toggle"
          checked={enabled}
          disabled={pref === null || saving}
          onChange={(e) => void update({ enabled: e.target.checked })}
        />
      </label>

      {enabled && (
        <>
          <label className={styles.row}>
            <span className={styles.label}>Search depth</span>
            <select
              data-testid="forward-search-depth"
              className={styles.select}
              value={pref?.depth ?? ''}
              disabled={pref === null || saving}
              onChange={(e) => void update({ depth: Number(e.target.value) })}
            >
              {FORWARD_SEARCH_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {d} positions per seed
                </option>
              ))}
            </select>
          </label>
          <p className={styles.warn}>
            A deeper search derives more accounts and can take several seconds (it&rsquo;s capped
            at 100). Signing shows a progress bar while it searches.
          </p>
        </>
      )}
    </section>
  );
}
