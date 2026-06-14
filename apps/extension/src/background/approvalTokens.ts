/**
 * Single-use approval-token registry (XP-3) — the background's anti-replay guard
 * for dApp signing.
 *
 * THE THREAT: a dApp signing request is gated behind a user approval. Without a
 * one-time binding, a malicious page (or a relay that captured the approved
 * message) could REPLAY the exact same approved `signTx` and obtain a second
 * signature the user never authorized. This registry mints an unguessable token
 * at approval time and CONSUMES it on the first sign, so an approved sign signs
 * AT MOST ONCE — a replay presents an already-spent (or never-minted) token and
 * is rejected before any key material is touched.
 *
 * The token is public, opaque, and short-lived: it carries no key material and is
 * never persisted (an MV3 respawn drops every in-flight approval, which is the
 * safe direction — a replay after respawn finds no live token and is rejected).
 */

/** A cryptographically-unguessable single-use token. */
function freshToken(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface ApprovalTokenRegistry {
  /** Mint a single-use token at approval time. */
  mint(): string;
  /**
   * Validate-and-consume a token on a sign attempt. Returns `true` exactly once
   * per minted token; a replayed or never-minted token returns `false` WITHOUT
   * leaving any usable state behind.
   */
  consume(token: string): boolean;
}

export function createApprovalTokenRegistry(): ApprovalTokenRegistry {
  const live = new Set<string>();
  return {
    mint(): string {
      const token = freshToken();
      live.add(token);
      return token;
    },
    consume(token: string): boolean {
      if (!live.has(token)) return false;
      live.delete(token);
      return true;
    },
  };
}
