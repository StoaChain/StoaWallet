import { useEffect, type ReactNode } from 'react';

import { useToast, type Toast } from './ToastContext';
import styles from './ToastViewport.module.css';

/**
 * The floating toast stack (bottom of the shell). Each terminal toast carries a
 * depleting progress bar and auto-dismisses when its timer elapses; a `pending`
 * toast persists (a spinner) until it is updated to a terminal status. Renders
 * nothing when the stack is empty.
 */
export function ToastViewport(): ReactNode {
  const { toasts, dismiss } = useToast();
  if (toasts.length === 0) return null;
  return (
    <div className={styles.viewport} data-testid="toast-viewport" aria-live="polite">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} dismiss={dismiss} />
      ))}
    </div>
  );
}

/** The status glyph: a spinner while pending, a mark once terminal. */
function StatusGlyph({ status }: { status: Toast['status'] }): ReactNode {
  if (status === 'pending') {
    return <span className={styles.spinner} aria-hidden="true" />;
  }
  const glyph = status === 'success' ? '✓' : status === 'error' ? '✗' : 'ⓘ';
  return (
    <span className={`${styles.glyph} ${styles[status]}`} aria-hidden="true">
      {glyph}
    </span>
  );
}

function ToastItem({
  toast,
  dismiss,
}: {
  readonly toast: Toast;
  readonly dismiss: (id: string) => void;
}): ReactNode {
  // Arm the auto-dismiss timer when the toast carries an autoDismissMs (set when
  // a pending toast is updated to a terminal status). `dismiss` is stable and the
  // deps key on the dismiss time + id, so the timer is armed exactly once per
  // terminal transition — not reset on every render.
  const { autoDismissMs, id } = toast;
  useEffect(() => {
    if (autoDismissMs === undefined || autoDismissMs <= 0) return;
    const timer = setTimeout(() => dismiss(id), autoDismissMs);
    return () => clearTimeout(timer);
  }, [autoDismissMs, id, dismiss]);

  return (
    <div
      className={`${styles.toast} ${styles[toast.status]}`}
      role="status"
      data-testid="toast"
      data-status={toast.status}
    >
      <div className={styles.body}>
        <StatusGlyph status={toast.status} />
        <div className={styles.content}>
          <p className={styles.title}>{toast.title}</p>
          {toast.detail !== undefined && (
            <p className={styles.detail}>{toast.detail}</p>
          )}
          {toast.steps !== undefined && toast.steps.length > 0 && (
            <ul className={styles.steps} data-testid="toast-steps">
              {toast.steps.map((step) => (
                <li key={step.label} className={styles.step} data-status={step.status}>
                  <StatusGlyph status={step.status} />
                  <span className={styles.stepLabel}>{step.label}</span>
                  {step.note !== undefined && (
                    <span className={styles.stepNote}>{step.note}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {toast.explorerUrl !== undefined && (
            <a
              className={styles.explorerLink}
              href={toast.explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="toast-explorer-link"
            >
              View on explorer ↗
            </a>
          )}
        </div>
        <button
          type="button"
          className={styles.close}
          aria-label="Dismiss"
          onClick={() => dismiss(toast.id)}
        >
          ✕
        </button>
      </div>
      {autoDismissMs !== undefined && autoDismissMs > 0 && (
        <span
          className={styles.bar}
          style={{ animationDuration: `${autoDismissMs}ms` }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
