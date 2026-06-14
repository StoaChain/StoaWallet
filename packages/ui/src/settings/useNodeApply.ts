import type { ApplyResult, NodePreference } from '@stoawallet/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useSettings } from './SettingsContext';

/**
 * The node-apply validation STATE MACHINE (RR#6): `idle → validating →
 * valid | invalid`. It drives the Settings Apply button:
 *
 *   - while `validating` the button is disabled and shows a pending label, so a
 *     custom-node probe (a live network round-trip) cannot be double-submitted;
 *   - a single in-flight apply is enforced by a guard ref, so a second click
 *     mid-probe does NOT start a second apply;
 *   - each apply threads a fresh `AbortController` signal into the applier, and
 *     the controller is aborted on unmount OR when a superseding apply starts —
 *     extension popups close mid-probe, so a late resolution must never call
 *     setState on an unmounted component.
 */
export type NodeApplyState = 'idle' | 'validating' | 'valid' | 'invalid';

export interface UseNodeApplyResult {
  readonly state: NodeApplyState;
  /** The discriminated result of the most recent settled apply, else null. */
  readonly result: ApplyResult | null;
  readonly isValidating: boolean;
  apply(pref: NodePreference): Promise<void>;
}

export function useNodeApply(): UseNodeApplyResult {
  const { applyPreference } = useSettings();
  const [state, setState] = useState<NodeApplyState>('idle');
  const [result, setResult] = useState<ApplyResult | null>(null);

  // The in-flight controller. A non-null value means an apply is pending — it is
  // both the double-apply guard and the cancellation handle.
  const inFlightRef = useRef<AbortController | null>(null);
  // True only while mounted, so a late (post-unmount) resolution skips setState.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Cancel any in-flight probe on unmount so its resolution is a no-op.
      inFlightRef.current?.abort();
      inFlightRef.current = null;
    };
  }, []);

  const apply = useCallback(
    async (pref: NodePreference): Promise<void> => {
      // Double-apply guard: ignore a click while an apply is already in flight.
      if (inFlightRef.current !== null) return;

      const controller = new AbortController();
      inFlightRef.current = controller;
      setState('validating');
      setResult(null);

      try {
        const r = await applyPreference(pref, { signal: controller.signal });
        // A superseding apply / unmount may have replaced or cleared this run;
        // only the still-current, still-mounted run may commit state.
        if (!mountedRef.current || inFlightRef.current !== controller) return;
        setResult(r);
        setState(r.ok ? 'valid' : 'invalid');
      } catch {
        // An abort (unmount / supersede) rejects here — swallow without setState.
        // Any other failure also collapses to a non-committed run; the discrete
        // failure reasons travel through the discriminated result, not throws.
        if (!mountedRef.current || inFlightRef.current !== controller) return;
        setState('invalid');
      } finally {
        if (inFlightRef.current === controller) {
          inFlightRef.current = null;
        }
      }
    },
    [applyPreference],
  );

  return {
    state,
    result,
    isValidating: state === 'validating',
    apply,
  };
}
