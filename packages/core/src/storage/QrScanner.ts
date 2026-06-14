/**
 * Camera-based QR scanning for obtaining a RECIPIENT ADDRESS on the Send flow.
 *
 * This is the abstraction over a platform camera/QR backer, decoupled from any
 * concrete API. Like `StorageAdapter` and `BiometricUnlock`, the contract here
 * is platform-AGNOSTIC: no Capacitor import, no `navigator.mediaDevices`. The
 * two planned realities are:
 *   - mobile: `@capacitor-mlkit/barcode-scanning` (native camera).
 *   - web/extension: NO scanner at all — the `UnsupportedQrScanner` default
 *     below, so the UI degrades to manual address entry without branching.
 *
 * The scanned value is a recipient ADDRESS ONLY. It does NOT select a chain and
 * it is NOT validated as a `k:` address here — `scan()` returns the decoded
 * string as-is (bounded, see below) and the address classifier validates it
 * downstream. The scanner's sole correctness duty beyond decoding is to BOUND
 * the raw input so an adversarial multi-KB / non-ASCII QR can never reach (and
 * hang) that classifier.
 *
 * A recipient address is PUBLIC, so returning it is not a secret leak — but the
 * same no-logging discipline as the rest of the storage layer applies.
 */

/**
 * Why a structured scan failed.
 *
 * - `permission-denied` — the user denied camera access; the UI shows an honest
 *   "camera access needed" state rather than treating it as a scan error.
 * - `cancelled` — the user closed the scanner without decoding anything; the UI
 *   simply returns to the form.
 * - `unavailable` — no scanner backer exists (web/extension), or the scanner /
 *   bridge errored. The UI treats this as a silent no-op.
 * - `invalid-payload` — the decoded payload was rejected at the input boundary
 *   (oversized > MAX_QR_PAYLOAD_LENGTH / non-ASCII). DISTINCT from `unavailable`
 *   so the UI can show the same "not a valid StoaChain address" feedback it shows
 *   for a decoded-but-invalid `k:` address, rather than a silent no-op.
 */
export type QrScanFailureReason =
  | 'permission-denied'
  | 'cancelled'
  | 'unavailable'
  | 'invalid-payload';

/**
 * The result of a `scan()` call: either a decoded, length/charset-bounded
 * recipient-address string, or a structured failure the UI can branch on
 * without catching an exception.
 */
export type QrScanResult =
  | { ok: true; value: string }
  | { ok: false; reason: QrScanFailureReason };

/**
 * Upper bound on a decoded QR payload the scanner will return.
 *
 * A `k:` address is `k:` + 64 hex = 66 chars. This allows generous margin for
 * other legitimate address shapes while still rejecting multi-KB adversarial
 * payloads at the boundary, so the downstream address classifier never has to
 * defend against unbounded input.
 */
export const MAX_QR_PAYLOAD_LENGTH = 128;

export interface QrScanner {
  /**
   * Capability probe: whether this platform can actually scan a QR right now
   * (camera present and supported). The Send UI gates the "scan" affordance on
   * this. Implementations MUST resolve (never reject) so the probe itself can
   * never break the screen.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Request camera permission, open the scanner, and resolve with the decoded
   * recipient-address string (bounded) or a structured failure. MUST resolve in
   * every case — including permission denial, cancellation, and a rejected
   * adversarial payload — so callers never need a try/catch around it.
   */
  scan(): Promise<QrScanResult>;
}

/**
 * Whether a decoded payload is within bounds to be returned as a candidate
 * recipient address: non-empty, no longer than `MAX_QR_PAYLOAD_LENGTH`, and
 * printable ASCII only. This is the RR#5 input bound — it does NOT validate the
 * `k:` address shape, it only ensures an adversarial QR cannot reach the
 * classifier downstream.
 */
export function isBoundedQrPayload(value: string): boolean {
  if (value.length === 0 || value.length > MAX_QR_PAYLOAD_LENGTH) {
    return false;
  }
  // Printable ASCII range (space through tilde). Rejects control chars and any
  // multibyte / non-ASCII code point, which a k: address can never contain.
  return /^[\x20-\x7e]+$/.test(value);
}

/**
 * The production default for web and the Chrome extension, where there is no
 * platform camera-QR API.
 *
 * `isAvailable()` resolves `false` so the UI hides the scan button, and
 * `scan()` resolves a structured `unavailable` result. This is real runtime
 * behavior, not a test stub: it lets the Send screen render manual-entry-only
 * without any platform branching in the UI.
 */
export class UnsupportedQrScanner implements QrScanner {
  isAvailable(): Promise<boolean> {
    return Promise.resolve(false);
  }

  scan(): Promise<QrScanResult> {
    return Promise.resolve({ ok: false, reason: 'unavailable' });
  }
}
