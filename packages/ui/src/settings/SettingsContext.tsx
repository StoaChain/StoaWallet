import {
  applyAndPersistNodePreference as coreApplyAndPersist,
  getCurrentNodeStatus as coreGetCurrentNodeStatus,
  getNodePreference as coreGetNodePreference,
  revertToDefault as coreRevertToDefault,
  type ApplyOptions,
  type ApplyResult,
  type NodePreference,
  type NodeStatus,
  type StorageAdapter,
} from '@stoawallet/core';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * The Settings React surface. It wraps the T10.3 runtime node-preference applier
 * behind the INJECTED `StorageAdapter` (the same injection seam the wallet
 * context uses) so the extension supplies a `ChromeStorageAdapter` and mobile a
 * `CapacitorStorageAdapter` — this UI package imports NO `chrome.*`/Capacitor.
 *
 * The core node functions are swappable through {@link SettingsDeps} so tests can
 * drive the apply/probe outcomes deterministically with stubs (no live network),
 * mirroring how the screens stub core reads elsewhere in this package.
 *
 * DISCIPLINE: the candidate custom URL is forwarded to the applier and surfaced
 * back only as a discriminated reason code — this context never logs it.
 */

/** The core node operations the provider drives — overridable in tests. */
export interface SettingsDeps {
  applyAndPersistNodePreference(
    pref: NodePreference,
    adapter: StorageAdapter,
    opts?: ApplyOptions,
  ): Promise<ApplyResult>;
  revertToDefault(adapter: StorageAdapter): Promise<ApplyResult>;
  getNodePreference(adapter: StorageAdapter): Promise<NodePreference>;
  getCurrentNodeStatus(): NodeStatus;
}

const defaultDeps: SettingsDeps = {
  applyAndPersistNodePreference: coreApplyAndPersist,
  revertToDefault: coreRevertToDefault,
  getNodePreference: coreGetNodePreference,
  getCurrentNodeStatus: coreGetCurrentNodeStatus,
};

export interface SettingsContextValue {
  /** The live node status (configured primary/fallback + active host). */
  readonly nodeStatus: NodeStatus;

  /**
   * True when the persisted preference was reset from a corrupt blob on load
   * (T10.1 `recoveredFromCorrupt`). Drives a one-time "setting was reset" notice;
   * {@link dismissResetNotice} clears it.
   */
  readonly recoveredFromCorrupt: boolean;
  dismissResetNotice(): void;

  /**
   * Apply + persist a node preference through the injected adapter, then refresh
   * the displayed status. Returns the discriminated apply result so the caller
   * can message each failure reason distinctly. A failure leaves the prior status
   * untouched (the applier never moves the active host on rejection).
   */
  applyPreference(
    pref: NodePreference,
    opts?: ApplyOptions,
  ): Promise<ApplyResult>;

  /** Revert to the default node1/node2 failover in one action, then refresh. */
  revert(): Promise<ApplyResult>;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export interface SettingsProviderProps {
  readonly storage: StorageAdapter;
  /** Core node-op overrides for tests; production uses the real core functions. */
  readonly deps?: Partial<SettingsDeps>;
  readonly children: ReactNode;
}

export function SettingsProvider({
  storage,
  deps,
  children,
}: SettingsProviderProps): ReactNode {
  const ops = useMemo<SettingsDeps>(
    () => ({ ...defaultDeps, ...deps }),
    [deps],
  );

  const [nodeStatus, setNodeStatus] = useState<NodeStatus>(() =>
    ops.getCurrentNodeStatus(),
  );
  const [recoveredFromCorrupt, setRecoveredFromCorrupt] = useState(false);

  const refreshStatus = useCallback(() => {
    setNodeStatus(ops.getCurrentNodeStatus());
  }, [ops]);

  // On mount, read the persisted preference so a corrupt-reset (T10.1) surfaces a
  // one-time notice, and sync the displayed status to the live SDK config.
  useEffect(() => {
    let active = true;
    void (async () => {
      const pref = await ops.getNodePreference(storage);
      if (!active) return;
      if (pref.recoveredFromCorrupt === true) setRecoveredFromCorrupt(true);
      setNodeStatus(ops.getCurrentNodeStatus());
    })();
    return () => {
      active = false;
    };
  }, [ops, storage]);

  const applyPreference = useCallback(
    async (pref: NodePreference, opts?: ApplyOptions): Promise<ApplyResult> => {
      const result = await ops.applyAndPersistNodePreference(
        pref,
        storage,
        opts,
      );
      // Refresh the displayed status from the SDK regardless of outcome: on
      // success it reflects the new active host; on failure the applier left the
      // prior config in place, so the display correctly stays put.
      refreshStatus();
      return result;
    },
    [ops, storage, refreshStatus],
  );

  const revert = useCallback(async (): Promise<ApplyResult> => {
    const result = await ops.revertToDefault(storage);
    refreshStatus();
    return result;
  }, [ops, storage, refreshStatus]);

  const dismissResetNotice = useCallback(() => {
    setRecoveredFromCorrupt(false);
  }, []);

  const value: SettingsContextValue = {
    nodeStatus,
    recoveredFromCorrupt,
    dismissResetNotice,
    applyPreference,
    revert,
  };

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (ctx === null) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return ctx;
}
