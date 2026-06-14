import type { ApprovalCommandSigData } from './approvalTypes';

/** A single capability the user is about to grant, decoded from a signer clist. */
export interface PactCapability {
  /** The capability name, e.g. `coin.TRANSFER` or `coin.GAS_PAYER`. */
  readonly name: string;
  /** The capability arguments, rendered as readable text. */
  readonly args: readonly string[];
  /** True for a gas-station / gas-payer sponsorship cap, surfaced distinctly. */
  readonly isGasPayer: boolean;
}

/** A signer (public key) plus the capabilities scoped to it. */
export interface PactSigner {
  readonly pubKey: string;
  readonly caps: readonly PactCapability[];
}

/**
 * A GENERIC, transfer-agnostic preview decoded from a dApp's `cmd` JSON — what
 * the user is about to sign, shown EXACTLY before they approve. Distinct from
 * the Phase-4 transfer panel: any Pact command (a vote, a swap, a contract
 * deploy) yields a non-empty preview of its code, signers, capabilities, and
 * meta.
 */
export interface PactPreview {
  /** The Pact code being executed (or a `cont` description), never empty. */
  readonly code: string;
  /** The pubkeys signing, with their scoped capabilities. */
  readonly signers: readonly PactSigner[];
  /** Every capability across all signers (the full grant set). */
  readonly capabilities: readonly PactCapability[];
  /** Whether a gas-payer sponsor capability is present. */
  readonly hasGasPayer: boolean;
  /** The target chain id, if the command declared one. */
  readonly chainId?: string;
  /** The gas-payer / sender account from `meta`, if present. */
  readonly sender?: string;
}

/** Capability names that denote a gas-station sponsorship (someone else pays gas). */
const GAS_PAYER_CAP_RE = /gas[_-]?payer|gas[_-]?station/i;

/** Render a single Pact cap arg (string, number, or object literal) as text. */
function renderArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg);
  if (arg === null) return 'null';
  // Pact int/decimal literals arrive as { int: n } / { decimal: "n" }; render
  // them readably rather than as "[object Object]".
  if (typeof arg === 'object') {
    const rec = arg as Record<string, unknown>;
    if ('int' in rec) return String(rec.int);
    if ('decimal' in rec) return String(rec.decimal);
    try {
      return JSON.stringify(arg);
    } catch {
      return '[unreadable]';
    }
  }
  return String(arg);
}

function decodeCapability(raw: unknown): PactCapability | null {
  if (raw == null || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const name = typeof rec.name === 'string' ? rec.name : '';
  if (name === '') return null;
  const rawArgs = Array.isArray(rec.args) ? rec.args : [];
  const args = rawArgs.map(renderArg);
  return { name, args, isGasPayer: GAS_PAYER_CAP_RE.test(name) };
}

function decodeSigner(raw: unknown): PactSigner | null {
  if (raw == null || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const pubKey = typeof rec.pubKey === 'string' ? rec.pubKey : '';
  if (pubKey === '') return null;
  const rawClist = Array.isArray(rec.clist) ? rec.clist : [];
  const caps = rawClist
    .map(decodeCapability)
    .filter((c): c is PactCapability => c !== null);
  return { pubKey, caps };
}

/**
 * Decode ONE command's `cmd` JSON into a {@link PactPreview}. Handles both an
 * `exec` payload (code + data) and a `cont` payload (a continuation step), and
 * tolerates a malformed `cmd` by surfacing the raw string rather than throwing —
 * the user must still see SOMETHING to reject, never a blank panel.
 */
export function decodePactPreview(command: ApprovalCommandSigData): PactPreview {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(command.cmd) as Record<string, unknown>;
  } catch {
    parsed = null;
  }

  if (parsed == null) {
    // An undecodable command still yields a non-empty preview: the raw string is
    // shown so the user can reject an unparseable request rather than face a
    // blank panel they might blindly approve.
    return {
      code: command.cmd,
      signers: [],
      capabilities: [],
      hasGasPayer: false,
    };
  }

  const payload = (parsed.payload ?? {}) as Record<string, unknown>;
  const exec = (payload.exec ?? null) as Record<string, unknown> | null;
  const cont = (payload.cont ?? null) as Record<string, unknown> | null;

  let code: string;
  if (exec != null && typeof exec.code === 'string' && exec.code !== '') {
    code = exec.code;
  } else if (cont != null && typeof cont.pactId === 'string') {
    const step = typeof cont.step === 'number' ? cont.step : '?';
    code = `Continuation: pactId=${cont.pactId}, step=${step}`;
  } else {
    // No recognizable code/cont — fall back to the raw cmd so the panel is never
    // empty.
    code = command.cmd;
  }

  const rawSigners = Array.isArray(parsed.signers) ? parsed.signers : [];
  const signers = rawSigners
    .map(decodeSigner)
    .filter((s): s is PactSigner => s !== null);

  const capabilities = signers.flatMap((s) => s.caps);
  const hasGasPayer = capabilities.some((c) => c.isGasPayer);

  const meta = (parsed.meta ?? {}) as Record<string, unknown>;
  const chainId = typeof meta.chainId === 'string' ? meta.chainId : undefined;
  const sender = typeof meta.sender === 'string' ? meta.sender : undefined;

  return { code, signers, capabilities, hasGasPayer, chainId, sender };
}

/** Decode every command in a sign request into its own preview. */
export function decodePactPreviews(
  commands: readonly ApprovalCommandSigData[],
): readonly PactPreview[] {
  return commands.map(decodePactPreview);
}
