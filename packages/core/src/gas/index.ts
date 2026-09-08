/**
 * Gas sub-barrel for `@stoawallet/core` — the Yin Engine live gas floor.
 *
 * StoaChain's minimum gas price is TIME-VARYING: it starts at 10,000 ANU at
 * genesis, rises by 1 ANU every 3 hours, and caps at 400,000 ANU. Consensus
 * rejects any transaction priced below the floor as of the block's own time,
 * so a hardcoded `gasPrice` (or @kadena/client's implicit 1e-8 default) goes
 * stale and starts bouncing.
 *
 * This barrel deliberately RE-EXPORTS the canonical implementation from
 * `@stoachain/stoa-core/gas` (4.4.0+) rather than carrying a local copy. That
 * is the same function every other fixed consumer in the ecosystem calls —
 * OuronetUI, ouronet-core, Codex — so the formula, the genesis constant and the
 * padding-based ANU→STOA conversion can never drift between them.
 *
 * USAGE — `stoaGasMeta()` does ONE clock read and returns both fields, so the
 * `creationTime` stamped on a transaction and the `gasPrice` derived from it can
 * never straddle a tick boundary (which would silently underprice it):
 *
 *   .setMeta({ senderAccount, chainId, gasLimit, ttl, ...stoaGasMeta() })
 *
 * Do NOT clamp a user-typed gas price up to this floor in any manual/advanced
 * gas field — show a warning instead. The UI must never submit a price that
 * differs from the one it displays.
 */

export {
  minGasPriceAnu,
  anuToStoaNumber,
  stoaGasMeta,
} from '@stoachain/stoa-core/gas';
