/**
 * SINGLE-SOURCED timeout / transience taxonomy for the cross-chain orchestrators
 * (PAT-003, F-004). The three legs of a cross-chain transfer previously each
 * carried their own inline error classifier; this module consolidates them into
 * two documented predicates so the divergence between them is an EXPLICIT,
 * single-sourced decision rather than three copies that can silently drift.
 *
 * Browser-safe: this module imports nothing node-only (no transport, no SDK
 * client). The `SigningError` constructor is passed IN by the caller so this
 * file never statically imports the error module either — keeping it reachable
 * from the browser barrel.
 */

/** A SigningError-shaped class: an Error subclass carrying a `.code` token. */
export interface SigningErrorClass {
  new (...args: never[]): Error & { readonly code: string };
}

/** Pull a usable message out of an unknown thrown value (never a secret). */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}

/**
 * The CONTINUATION-leg timeout signal: a `SigningError` carrying
 * `code === "TIMEOUT"`. Used by `pollAndContinue` and `resumeCrossChain` on the
 * step-1 submit — a TIMEOUT there is a PENDING signal (the continuation MAY have
 * committed), never a definitive failure, so the caller re-checks and NEVER
 * resubmits (a resubmit would double-execute step 1).
 *
 * The `SigningError` constructor is injected so this predicate's `instanceof`
 * check runs against the SAME constructor the orchestrator's deps were wired
 * with (production SDK or test double).
 */
export function isSigningTimeout(
  err: unknown,
  SigningError: SigningErrorClass,
): boolean {
  return err instanceof SigningError && err.code === 'TIMEOUT';
}

/**
 * The BURN-leg (step-0 submit) transience policy: BROADER than
 * `isSigningTimeout` on purpose. On the submit leg an error here means the tx
 * MAY have landed, so the safe action is to flow into confirm rather than
 * declare a hard failure — a false hard-failure would tell the user nothing
 * landed when the burn might be on chain. This predicate therefore errs SAFE,
 * matching a `SigningError` TIMEOUT OR any network-class message (fetch/socket/
 * connection failures that survived both the primary and fallback node).
 *
 * Documenting the divergence: the burn leg uses THIS broader predicate; the
 * continuation leg uses the narrow {@link isSigningTimeout}. The asymmetry is
 * deliberate — a step-0 submit that errs safe flows to confirm (never a false
 * hard-failure), whereas the step-1 submit treats only an explicit TIMEOUT as
 * pending.
 */
export function isRecoverableSubmitError(
  err: unknown,
  SigningError?: SigningErrorClass,
): boolean {
  if (SigningError && isSigningTimeout(err, SigningError)) return true;
  // Fallback for callers that don't inject SigningError: the raw TIMEOUT code.
  if ((err as { code?: unknown } | null)?.code === 'TIMEOUT') return true;
  const msg = errorMessage(err).toLowerCase();
  return (
    msg.includes('fetch') ||
    msg.includes('network') ||
    msg.includes('socket') ||
    msg.includes('econn') ||
    msg.includes('timed out') ||
    msg.includes('timeout')
  );
}
