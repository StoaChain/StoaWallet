import type {
  ApprovalCommandSigData,
  ApprovalPendingRequest,
} from '@stoawallet/ui';

/**
 * Parse the approval window's launch params into a typed
 * {@link ApprovalPendingRequest}.
 *
 * The router (T9.6) opens this window with the pending request encoded in the
 * URL — the canonical origin, the RR#2 correlation nonce, the request id, the
 * intent kind, and (for a sign) the FROZEN command(s). This decodes and VALIDATES
 * those params; a missing/garbled param yields `null` so the entry renders an
 * error rather than a half-built approval the user might act on.
 *
 * The `locked` flag travels alongside: the router knows whether the vault was
 * locked at approval time, so the surface can route through the re-unlock UX
 * first.
 *
 * SECURITY: the params carry only PUBLIC data (origin, nonce, id, the public
 * `cmd` string). No key material is ever placed on the URL.
 */
export interface ParsedApprovalParams {
  readonly request: ApprovalPendingRequest;
  readonly locked: boolean;
}

function nonEmpty(value: string | null): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function parseApprovalParams(
  search: string,
): ParsedApprovalParams | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return null;
  }

  const kind = params.get('kind');
  const requestId = params.get('id');
  const nonce = params.get('nonce');
  const origin = params.get('origin');
  const networkId = params.get('networkId');
  const locked = params.get('locked') === '1';

  if (!nonEmpty(requestId) || !nonEmpty(nonce) || !nonEmpty(origin) || !nonEmpty(networkId)) {
    return null;
  }

  if (kind === 'connect') {
    return {
      request: { kind: 'connect', requestId, nonce, origin, networkId },
      locked,
    };
  }

  if (kind === 'sign') {
    const rawCommands = params.get('commandSigDatas');
    if (!nonEmpty(rawCommands)) return null;
    let commandSigDatas: readonly ApprovalCommandSigData[];
    try {
      commandSigDatas = JSON.parse(rawCommands) as readonly ApprovalCommandSigData[];
    } catch {
      return null;
    }
    if (!Array.isArray(commandSigDatas) || commandSigDatas.length === 0) {
      return null;
    }
    return {
      request: { kind: 'sign', requestId, nonce, origin, networkId, commandSigDatas },
      locked,
    };
  }

  return null;
}
