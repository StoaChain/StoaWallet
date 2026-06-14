import {
  BarcodeScanner,
  type Barcode,
} from '@capacitor-mlkit/barcode-scanning';

import {
  isBoundedQrPayload,
  type QrScanner,
  type QrScanResult,
} from '@stoawallet/core';

/**
 * Mobile `QrScanner` backed by `@capacitor-mlkit/barcode-scanning`.
 *
 * Concrete implementation of the platform-agnostic core contract, the THIRD
 * instance (after the Capacitor `StorageAdapter` and `BiometricUnlock`) of the
 * interface-in-core / impl-in-app discipline. The whole Capacitor surface is
 * confined to this file; the shared UI codes only against `QrScanner`.
 *
 * The decoded payload is a RECIPIENT ADDRESS ONLY — it never selects a chain.
 * `scan()` returns the decoded string as-is once it passes the RR#5 input bound;
 * the `k:`-address validation happens downstream in the Send flow, not here.
 *
 * A recipient address is public, so no secret is logged or handled here.
 */
export class CapacitorQrScanner implements QrScanner {
  /**
   * Whether the device's camera can support barcode scanning. Resolves false
   * (never rejects) on any probe error so the Send screen can always decide
   * whether to show the scan affordance.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const { supported } = await BarcodeScanner.isSupported();
      return supported;
    } catch {
      return false;
    }
  }

  /**
   * Request camera permission, open the scanner, and map the plugin outcome onto
   * the discriminated `QrScanResult`. Always resolves — a denied permission, a
   * cancelled scan, an oversized/non-ASCII payload (→ `invalid-payload`), or an
   * unexpected plugin error (→ `unavailable`) each become a structured `ok:false`,
   * never a throw.
   */
  async scan(): Promise<QrScanResult> {
    try {
      // Request camera permission BEFORE opening the camera UI. A denied result
      // must surface as a clean discriminated outcome, not a crash — and the
      // scanner must not be opened.
      const { camera } = await BarcodeScanner.requestPermissions();
      if (camera !== 'granted' && camera !== 'limited') {
        return { ok: false, reason: 'permission-denied' };
      }

      const { barcodes } = await BarcodeScanner.scan();
      const decoded = firstDecodedValue(barcodes);
      // An empty result means the user closed the scanner without decoding
      // anything — a cancellation, distinct from an error.
      if (decoded === null) {
        return { ok: false, reason: 'cancelled' };
      }

      // RR#5: bound the raw input (length + ASCII) so an adversarial multi-KB /
      // non-ASCII QR can never reach (and hang) the downstream classifier. This
      // is a DISTINCT outcome from `unavailable`: the scanner worked and decoded
      // something, it was just not a usable address — so the UI shows the same
      // "not a valid StoaChain address" feedback as a decoded-but-invalid k:.
      if (!isBoundedQrPayload(decoded)) {
        return { ok: false, reason: 'invalid-payload' };
      }

      return { ok: true, value: decoded };
    } catch {
      // A defeated/unsupported scanner or a bridge error degrades to a clean
      // unavailable outcome so the Send flow falls back to manual entry.
      return { ok: false, reason: 'unavailable' };
    }
  }
}

/**
 * The decoded string of the first barcode, preferring `rawValue` (the
 * machine-readable UTF-8 form) and falling back to `displayValue`. Returns null
 * when nothing was decoded so the caller can treat it as a cancellation.
 */
function firstDecodedValue(barcodes: Barcode[]): string | null {
  const first = barcodes[0];
  if (!first) {
    return null;
  }
  const value = first.rawValue ?? first.displayValue;
  return value && value.length > 0 ? value : null;
}
