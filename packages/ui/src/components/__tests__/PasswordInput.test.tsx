import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PasswordInput } from '../PasswordInput';

function renderInput(value = '', onChange = vi.fn()) {
  const utils = render(
    <PasswordInput
      id="pw"
      label="Password"
      value={value}
      onChange={onChange}
    />,
  );
  const input = screen.getByLabelText('Password') as HTMLInputElement;
  const toggle = screen.getByRole('button');
  return { input, toggle, onChange, ...utils };
}

describe('PasswordInput', () => {
  it('defaults to a hidden (type=password) field with a Show-password toggle', () => {
    const { input, toggle } = renderInput();

    // Reveal defaults to HIDDEN: the field masks input and the toggle offers to
    // SHOW it, with aria-pressed reflecting the not-yet-revealed state.
    expect(input.type).toBe('password');
    expect(toggle).toHaveAttribute('aria-label', 'Show password');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('reveals the value as plain text when the toggle is clicked', () => {
    const { input, toggle } = renderInput();

    fireEvent.click(toggle);

    // Clicking reveal switches the field to readable text and flips the toggle
    // to offer HIDE, so the user can verify what they typed.
    expect(input.type).toBe('text');
    expect(toggle).toHaveAttribute('aria-label', 'Hide password');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  it('hides the value again on a second toggle click', () => {
    const { input, toggle } = renderInput();

    fireEvent.click(toggle);
    fireEvent.click(toggle);

    // The reveal is a pure local toggle: a second click returns to the masked
    // default rather than latching open.
    expect(input.type).toBe('password');
    expect(toggle).toHaveAttribute('aria-label', 'Show password');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('uses a type=button toggle so it never submits the surrounding form', () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <PasswordInput id="pw" label="Password" value="" onChange={vi.fn()} />
      </form>,
    );

    // The toggle lives inside password forms; a submit-type button would seal a
    // half-typed wallet on a reveal click, so it must be type=button.
    const toggle = screen.getByRole('button');
    expect(toggle).toHaveAttribute('type', 'button');
    fireEvent.click(toggle);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('propagates typed input via onChange with the next string value', () => {
    const onChange = vi.fn();
    const { input } = renderInput('', onChange);

    fireEvent.change(input, { target: { value: 'hunter2' } });

    // The component is controlled: it lifts the next value up rather than owning
    // the secret, so the parent stays the single source of the password.
    expect(onChange).toHaveBeenCalledWith('hunter2');
  });
});
