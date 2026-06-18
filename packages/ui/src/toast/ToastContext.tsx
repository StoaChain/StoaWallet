import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * Lightweight, app-wide TOAST notifications — the floating, self-dismissing
 * transaction feedback (pending → confirmed ✓ / failed ✗), modelled on the
 * OuronetUI multi-step toast. A `pending` toast persists until it is `update`d to
 * a terminal status; a terminal toast carries an `autoDismissMs` after which the
 * viewport removes it (with a depleting progress bar).
 *
 * The context default is a NO-OP so a component calling `useToast()` outside a
 * `ToastProvider` (e.g. a unit test that doesn't mount the shell) is a silent
 * no-op rather than a throw.
 */

export type ToastStatus = 'pending' | 'success' | 'error' | 'info';

/**
 * One sub-row of a MULTI-STEP toast (e.g. the miner aggregate, where each swept
 * chain is a step). The step's `status` drives its own mini glyph, independent of
 * the parent toast's overall status.
 */
export interface ToastStep {
  readonly label: string;
  readonly status: ToastStatus;
  /** Optional trailing note (e.g. "SPV 3/40", a request key tail). */
  readonly note?: string;
}

export interface ToastSpec {
  readonly status: ToastStatus;
  readonly title: string;
  readonly detail?: string;
  /** An explorer URL surfaced as a "View on explorer" link. */
  readonly explorerUrl?: string;
  /**
   * Sub-steps for a multi-tx toast (the aggregate). When present the viewport
   * renders each as its own status row beneath the title; the parent toast still
   * carries the overall status (pending until every step settles).
   */
  readonly steps?: readonly ToastStep[];
  /**
   * Auto-dismiss after this many ms. Omit (or 0) to persist — a `pending` toast
   * stays until it is updated to a terminal status carrying its own dismiss time.
   */
  readonly autoDismissMs?: number;
}

export interface Toast extends ToastSpec {
  readonly id: string;
}

export interface ToastApi {
  readonly toasts: readonly Toast[];
  /** Show a toast; returns its id so a later `update`/`dismiss` can target it. */
  show(spec: ToastSpec): string;
  /** Patch an existing toast (e.g. pending → success with an autoDismissMs). */
  update(id: string, partial: Partial<ToastSpec>): void;
  /** Remove a toast immediately. */
  dismiss(id: string): void;
}

const NOOP: ToastApi = {
  toasts: [],
  show: () => '',
  update: () => {},
  dismiss: () => {},
};

const ToastContext = createContext<ToastApi>(NOOP);

/** Access the toast API. Returns a no-op when no `ToastProvider` is mounted. */
export function useToast(): ToastApi {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  // A monotonic counter for ids — deterministic (no Math.random/Date), so toast
  // ordering and test assertions are stable.
  const nextId = useRef(0);

  const show = useCallback((spec: ToastSpec): string => {
    const id = `toast-${nextId.current}`;
    nextId.current += 1;
    setToasts((prev) => [...prev, { ...spec, id }]);
    return id;
  }, []);

  const update = useCallback((id: string, partial: Partial<ToastSpec>): void => {
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...partial } : t)),
    );
  }, []);

  const dismiss = useCallback((id: string): void => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const api = useMemo<ToastApi>(
    () => ({ toasts, show, update, dismiss }),
    [toasts, show, update, dismiss],
  );

  return <ToastContext.Provider value={api}>{children}</ToastContext.Provider>;
}
