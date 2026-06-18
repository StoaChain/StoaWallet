# StoaWallet — Privacy Policy

**Publisher:** AncientHoldings GmbH
**Last updated:** 2026-06-17

StoaWallet is a **self-custody** crypto wallet for the StoaChain network, shipped
as a Chrome extension and as Android/iOS apps. This policy explains exactly what
the app does and does not do with your data. In short: **your keys and your data
stay on your device.**

## What we collect

**Nothing.** AncientHoldings GmbH operates **no servers that receive your data**,
runs **no analytics or telemetry**, sets **no tracking identifiers**, and shows
**no ads**. We do not have accounts, sign-ups, or logins with us.

## What stays on your device

- **Your recovery phrase and private keys** are generated on your device and stored
  **encrypted with your password** — in the browser extension's local storage, or
  in the Android Keystore / iOS Keychain on mobile. They are **never transmitted**
  to us or to any third party. We cannot see, recover, or reset them.
- **Your settings and address book** (named `k:` addresses you choose to save) are
  stored locally only.

If you uninstall the app or clear its data, this local data is deleted. Your only
backup is the 24-word recovery phrase you wrote down (and, for imported seeds, the
original Ouronet Codex file).

## Network connections

To function as a wallet, the app talks **directly from your device** to public
StoaChain infrastructure — there is no AncientHoldings server in between:

- **StoaChain RPC nodes** (`node1.stoachain.com`, `node2.stoachain.com`) — to
  submit and confirm transactions.
- **StoaChain read/explorer host** (`apiexplorer.stoachain.com`) — to read public
  balances and supply figures.
- **Block explorer links** (`explorer.stoachain.com`) — opened only when you tap a
  "View on explorer" link.

These requests necessarily reveal public blockchain data (e.g. the account
addresses and transactions you query/submit) to those endpoints and your network
provider, as any blockchain interaction does. They never include your private keys
or password.

## Device permissions

- **Storage** — persist the encrypted vault and settings locally.
- **Camera** (mobile, optional) — only when you choose to scan a recipient QR code.
  No images are stored or transmitted.
- **Idle state** (extension) — only to auto-lock the wallet after inactivity.

## Children

StoaWallet is not directed to children under 13.

## Changes

Updates to this policy will be posted at this URL with a new "Last updated" date.

## Contact

Questions: **privacy@ancientholdings.example** (replace with the real support
address before publishing).
