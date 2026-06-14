# StoaWallet — Security Posture (framing / clickjacking)

Wallet-class framing and clickjacking posture for the StoaWallet MV3 extension and
every web-served surface it will grow. This document records binding requirements;
some are enforced today by the MV3 manifest, others are forwarded to the phase that
builds the surface they protect.

## 1. The extension popup is not clickjacking-exposed

The MV3 action popup (`action.default_popup` → `index.html`) is rendered by the
browser chrome, not embedded in a web page. A hostile page cannot place the popup
in an `<iframe>` the way it could frame a web app, so classic clickjacking — a
transparent overlay tricking the user into clicking a "Send" button — does **not**
apply to the popup. No `frame-ancestors` directive is needed for the popup itself
because the page DOM can never reach it.

The manifest CSP covers the extension pages:

```
script-src 'self'; object-src 'self'
```

This blocks remote and inline script in the popup (and any future extension page),
which is the script-injection half of the wallet-class threat model. Store-readiness
of this CSP is enforced by the `auditStoreReadiness` validator
(`src/security/storeReadiness.ts`).

## 2. Binding requirements for ANY web-served surface

The popup's immunity does **not** extend to surfaces served over `http(s)` — an
options/onboarding page hosted on the web, or the Phase-9 dApp-provider page. Those
are real web documents and ARE frameable. Every such surface MUST set, via response
header or equivalent meta/CSP:

1. **`Content-Security-Policy: frame-ancestors 'none'`** — the modern
   X-Frame-Options equivalent. It denies all embedding, so no page can frame the
   surface to stage a clickjacking overlay. (Use `'self'` only if the surface has a
   concrete, documented need to be framed by itself; default is `'none'`.)
2. **A `Permissions-Policy` that locks down powerful sensors**, e.g.:

   ```
   Permissions-Policy: camera=(), microphone=(), geolocation=(), usb=(), hid=(), serial=(), accelerometer=(), gyroscope=(), magnetometer=(), payment=()
   ```

   A wallet surface has no reason to access these; denying them removes a whole
   class of side-channel and physical-device attacks even if the page is somehow
   embedded or compromised.

These two headers are mandatory for every web-served surface and are part of that
surface's definition-of-done.

## 3. Phase-9 dApp-provider page — THE framing-sensitive surface

The **Phase-9 dApp-provider page** is the highest-risk web-served surface in the
product: it is the bridge a dApp talks to in order to request signatures, so a
successful clickjack or sensor leak there maps directly to unauthorized signing.
It is explicitly flagged here as **the** framing-sensitive surface that inherits the
Section 2 requirements:

- It MUST ship `frame-ancestors 'none'` and the sensor-locking `Permissions-Policy`.
- It MUST NOT be added to `externally_connectable` or `content_scripts` until that
  phase deliberately scopes them (see XP-17 / the `EXPECTED_CONTENT_SCRIPTS`
  relaxation point in `src/security/storeReadiness.ts`).

Phase 7 documents this requirement. **Phase 9 enforces it** on the actual
approval surface (`src/approval/approval.html`): the page ships a `<meta>` CSP
with `frame-ancestors 'none'` plus a sensor-locking `Permissions-Policy`
(`camera=(), microphone=(), geolocation=(), usb=()…`), both machine-asserted by
`auditStoreReadiness` (`src/security/storeReadiness.ts`) and the dApp-manifest
build suite. The signing prompt cannot be iframed, and powerful sensors are denied.

## 5. Phase-9 dApp injection surface — what shipped (RR#4 / RR#5 / RR#6 / RR#8)

The dApp provider is wired as TWO `content_scripts`, both at `run_at:
"document_start"` (RR#5) and scoped to the StoaChain dApp-origin allow-list
`https://*.stoachain.com/*` (RR#6 — never `<all_urls>`):

1. A `world: "MAIN"` script (`src/dapp/inpageEntry.ts`) installs `window.stoa` in
   the page's own JS context (Chrome 111+, the pinned target). This REPLACES the
   old `<script src=…>` injection, so there is no self-injected provider tag.
2. An ISOLATED-world relay (`src/dapp/contentScriptEntry.ts`) is the only world
   with `chrome.runtime` — the single hop a page has to the background SW.

`externally_connectable` stays **absent** (RR#8): a page reaches the SW only via
the relay hop.

**RR#4 — web_accessible_resources (accepted, scoped deviation):** the ideal RR#4
outcome is NO `web_accessible_resources` entry for the inpage provider, and the
`world:"MAIN"` registration did remove the `<script>`-injection mechanism that
would otherwise require one. However, @crxjs 2.6.1's content-script emitter ships
EVERY content script as a tiny loader that `import()`s the real ESM chunk, and that
dynamic import requires the chunk be web-accessible (true for MAIN and ISOLATED
scripts alike). This is intrinsic to @crxjs, not a `<script>` injection we control.
The anti-fingerprinting intent of RR#4 is preserved by **scoping** the auto-emitted
entry to `https://*.stoachain.com/*` — arbitrary origins cannot probe the
`chrome-extension://` resources. The store-readiness validator FAILS any
`web_accessible_resources` matched against `<all_urls>` / `*://*/*`.

**`tabs` permission (RR#11 event delivery):** dApp events are pushed via
`chrome.tabs.sendMessage`. On the pinned Chrome target, messaging a tab the
extension has an active content script in (a host-match grant) needs NO `tabs`
permission, so `tabs` stays OUT of the manifest (least privilege).

## 4. Scope summary

| Surface | Frameable? | Required control | Enforced where |
| --- | --- | --- | --- |
| MV3 action popup | No (browser chrome) | manifest CSP `script-src 'self'` | Phase 7 manifest + `auditStoreReadiness` |
| Web options/onboarding page (if any) | Yes | `frame-ancestors 'none'` + `Permissions-Policy` | The phase that serves it |
| Phase-9 dApp-provider page | Yes (highest risk) | `frame-ancestors 'none'` + `Permissions-Policy` | Phase 9 (documented here) |
