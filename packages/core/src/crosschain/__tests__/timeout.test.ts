import { describe, expect, it } from 'vitest';

import {
  isRecoverableSubmitError,
  isSigningTimeout,
  type SigningErrorClass,
} from '../timeout';

/** A SigningError stand-in carrying a `.code` — mirrors @stoachain/stoa-core. */
class FakeSigningError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'SigningError';
    this.code = code;
  }
}

const SE = FakeSigningError as unknown as SigningErrorClass;

describe('crosschain timeout taxonomy', () => {
  describe('isSigningTimeout — the narrow continuation-leg signal', () => {
    it('is true ONLY for a SigningError with code TIMEOUT', () => {
      expect(isSigningTimeout(new FakeSigningError('deadline', 'TIMEOUT'), SE)).toBe(
        true,
      );
    });

    it('is false for a non-TIMEOUT SigningError (e.g. INVALID) — a hard failure', () => {
      expect(
        isSigningTimeout(new FakeSigningError('bad envelope', 'INVALID'), SE),
      ).toBe(false);
    });

    it('is false for a plain Error even if its message says timeout (must be the typed signal)', () => {
      expect(isSigningTimeout(new Error('request timed out'), SE)).toBe(false);
    });
  });

  describe('isRecoverableSubmitError — the broader burn-leg policy', () => {
    it('treats a SigningError TIMEOUT as recoverable (flows to confirm, never a false hard-failure)', () => {
      expect(
        isRecoverableSubmitError(new FakeSigningError('deadline', 'TIMEOUT'), SE),
      ).toBe(true);
    });

    it('treats a raw {code:"TIMEOUT"} as recoverable even without the SigningError class injected', () => {
      expect(isRecoverableSubmitError({ code: 'TIMEOUT' })).toBe(true);
    });

    it('treats a network-class error message as recoverable (tx MAY have landed)', () => {
      expect(isRecoverableSubmitError(new Error('fetch failed: ECONN reset'))).toBe(
        true,
      );
    });

    it('is false for a definitive non-network, non-timeout error (the tx did NOT land)', () => {
      expect(isRecoverableSubmitError(new Error('insufficient funds'))).toBe(false);
    });
  });
});
