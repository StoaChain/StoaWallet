import { useState, type ReactElement, type ReactNode } from 'react';

import styles from './PasswordInput.module.css';

/**
 * A controlled password field with a show/hide reveal toggle. Used by every
 * password-entry surface (create, import, unlock). The reveal is a PURELY local
 * display toggle: the secret value lives in the parent's state and is lifted up
 * via `onChange` — this component never owns or logs it.
 *
 * The toggle is a `type="button"` so a reveal click never submits the
 * surrounding form (which would seal a half-typed wallet). Its accessible name
 * and `aria-pressed` flip between Show/Hide so screen-reader users get the same
 * affordance as sighted users.
 */

export interface PasswordInputProps {
  /** Wires the `<label>` to the `<input>`; must be unique on the page. */
  readonly id: string;
  /** Visible label text and the input's accessible name. */
  readonly label: string;
  /** Controlled value — the parent owns the password. */
  readonly value: string;
  /** Lifts the next value up on every keystroke. */
  onChange(next: string): void;
  readonly autoComplete?: string;
  readonly placeholder?: string;
}

function EyeIcon({ revealed }: { revealed: boolean }): ReactNode {
  // Inline so the package adds no icon dependency (matching FingerprintIcon in
  // UnlockScreen); decorative, hidden from AT — the button's name carries meaning.
  return revealed ? (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  ) : (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function PasswordInput({
  id,
  label,
  value,
  onChange,
  autoComplete,
  placeholder,
}: PasswordInputProps): ReactElement {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <div className={styles.wrap}>
        <input
          id={id}
          className={styles.input}
          type={revealed ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          placeholder={placeholder}
        />
        <button
          type="button"
          className={styles.toggle}
          aria-label={revealed ? 'Hide password' : 'Show password'}
          aria-pressed={revealed}
          onClick={() => setRevealed((r) => !r)}
        >
          <EyeIcon revealed={revealed} />
        </button>
      </div>
    </div>
  );
}
