import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  useWallet,
  type RemoteWalletSummary,
  type RemotePureKeypair,
  type RemoteImportCodexResult,
} from '../context/WalletContext';
import { seedTypeChipStyle } from '../app/seedTypeConfig';
import { PasswordInput } from '../components/PasswordInput';
import styles from './AdvancedTab.module.css';

export interface AdvancedTabProps {
  /** Routed to surface a re-unlock when an op reports the wallet is locked. */
  readonly onRequireUnlock?: () => void;
}

/** Middle-truncate a `k:` address (gold ends kept by the caller's styling). */
function shortAddress(account: string): string {
  if (account.length <= 18) return account;
  return `${account.slice(0, 10)}…${account.slice(-6)}`;
}

/** Read a picked file as text — `File.text()` where available, else `FileReader`
 * (so it works in browsers AND the jsdom test environment). */
function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/**
 * The ADVANCED tab — account & seed management.
 *
 * Two modes, toggled by a switch (the user's design):
 *   - STANDARD (default): just the active seed — its accounts, add a consecutive
 *     OR a specific-index account, switch the active account. One Koala seed, no
 *     multi-seed/codex complexity in sight.
 *   - ADVANCED: every seed in the vault (any type), switch the active seed, add
 *     accounts per seed, and IMPORT an Ouronet Codex export (file + codex
 *     password) — which brings all its seeds + accounts + pure keys in. The codex
 *     password transits to the background only; secrets never reach this view.
 *
 * Holds NO key material — every mutation goes through the context (which routes to
 * the background in the extension). The seed list is the public `listWallets`
 * summary (no phrases, no keys).
 */
export function AdvancedTab({ onRequireUnlock }: AdvancedTabProps): ReactNode {
  const {
    listWallets,
    switchWallet,
    setSeedActiveAccount,
    addAccount,
    addAccountAtIndex,
    removeAccount,
    renameWallet,
    importCodex,
    listPureKeypairs,
  } = useWallet();

  const [advanced, setAdvanced] = useState(false);
  const [wallets, setWallets] = useState<readonly RemoteWalletSummary[]>([]);
  const [pureKeys, setPureKeys] = useState<readonly RemotePureKeypair[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const [w, k] = await Promise.all([listWallets(), listPureKeypairs()]);
    setWallets(w);
    setPureKeys(k);
  }, [listWallets, listPureKeypairs]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const active = wallets.find((w) => w.isActive) ?? wallets[0];

  /** Run a seed/account mutation: switch to the seed first (so it's the unlocked
   * one), perform the op, refresh, and surface a `locked` outcome to unlock. */
  const run = useCallback(
    async (
      walletId: string,
      op: () => Promise<{ ok: boolean; reason?: string }>,
    ): Promise<void> => {
      if (busy) return;
      setBusy(true);
      setNotice(null);
      try {
        const switched = await switchWallet(walletId);
        if (!switched.ok) {
          if (switched.reason === 'locked') onRequireUnlock?.();
          return;
        }
        const res = await op();
        if (!res.ok && res.reason === 'locked') onRequireUnlock?.();
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [busy, switchWallet, refresh, onRequireUnlock],
  );

  /** Run a mutation that does NOT need the seed to be active (rename / remove
   * account touch non-secret vault metadata). Unlike `run`, it never switches the
   * active seed — renaming a non-active seed must not yank the user onto it. */
  const mutate = useCallback(
    async (op: () => Promise<{ ok: boolean; reason?: string }>): Promise<void> => {
      if (busy) return;
      setBusy(true);
      setNotice(null);
      try {
        const res = await op();
        if (!res.ok && res.reason === 'locked') onRequireUnlock?.();
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh, onRequireUnlock],
  );

  const onImport = useCallback(
    async (json: string, codexPassword: string): Promise<RemoteImportCodexResult> => {
      setBusy(true);
      setNotice(null);
      try {
        const result = await importCodex(json, codexPassword);
        if (result.ok) {
          const { seedsImported, accountsImported, keysImported } = result.summary;
          const parts: string[] = [];
          if (seedsImported > 0) parts.push(`${seedsImported} seed(s)`);
          if (accountsImported > 0) parts.push(`${accountsImported} account(s)`);
          if (keysImported > 0) parts.push(`${keysImported} key(s)`);
          setNotice(
            parts.length === 0
              ? 'Nothing new to import — those seeds/keys are already here.'
              : `Imported ${parts.join(', ')}.`,
          );
          await refresh();
        } else if (result.reason === 'locked') {
          onRequireUnlock?.();
        }
        return result;
      } finally {
        setBusy(false);
      }
    },
    [importCodex, refresh, onRequireUnlock],
  );

  return (
    <section className={styles.tab} data-testid="advanced-tab">
      <header className={styles.head}>
        <h1 className={styles.heading}>Accounts &amp; Seeds</h1>
        <label className={styles.modeSwitch}>
          <span>Advanced</span>
          <input
            type="checkbox"
            data-testid="advanced-mode-toggle"
            checked={advanced}
            onChange={(e) => setAdvanced(e.target.checked)}
          />
        </label>
      </header>

      {notice !== null && (
        <p className={styles.notice} role="status" data-testid="advanced-notice">
          {notice}
        </p>
      )}

      {!advanced ? (
        active === undefined ? (
          <p className={styles.empty}>No wallet yet.</p>
        ) : (
          <SeedCard
            wallet={active}
            busy={busy}
            showSwitch={false}
            onAddAccount={() => run(active.id, addAccount)}
            onAddAtIndex={(i) => run(active.id, () => addAccountAtIndex(active.id, i))}
            onUseSeed={() => undefined}
            onSelectAccount={(idx) =>
              mutate(() => setSeedActiveAccount(active.id, idx))
            }
            onRemoveAccount={(idx) => mutate(() => removeAccount(active.id, idx))}
            onRename={(name) => mutate(() => renameWallet(active.id, name))}
          />
        )
      ) : (
        <div className={styles.advancedBody}>
          <p className={styles.help}>
            Every seed in this wallet. Switch the active seed, add accounts, or
            import an Ouronet Codex to bring in more seeds, accounts and keys.
          </p>
          {wallets.map((w) => (
            <SeedCard
              key={w.id}
              wallet={w}
              busy={busy}
              showSwitch
              onAddAccount={() => run(w.id, addAccount)}
              onAddAtIndex={(i) => run(w.id, () => addAccountAtIndex(w.id, i))}
              onUseSeed={() => run(w.id, async () => ({ ok: true }))}
              onSelectAccount={(idx) =>
                mutate(() => setSeedActiveAccount(w.id, idx))
              }
              onRemoveAccount={(idx) => mutate(() => removeAccount(w.id, idx))}
              onRename={(name) => mutate(() => renameWallet(w.id, name))}
            />
          ))}
          {pureKeys.length > 0 && <PureKeysPanel keys={pureKeys} />}
          <ImportCodexPanel busy={busy} onImport={onImport} />
        </div>
      )}
    </section>
  );
}

/** One seed: its type chip, active badge, accounts, and account-add controls. */
function SeedCard({
  wallet,
  busy,
  showSwitch,
  onAddAccount,
  onAddAtIndex,
  onUseSeed,
  onSelectAccount,
  onRemoveAccount,
  onRename,
}: {
  readonly wallet: RemoteWalletSummary;
  readonly busy: boolean;
  readonly showSwitch: boolean;
  readonly onAddAccount: () => void;
  readonly onAddAtIndex: (index: number) => void;
  readonly onUseSeed: () => void;
  readonly onSelectAccount: (index: number) => void;
  readonly onRemoveAccount: (index: number) => void;
  readonly onRename: (name: string) => void;
}): ReactNode {
  const chip = seedTypeChipStyle(wallet.seedType);
  const [indexInput, setIndexInput] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(wallet.name);

  const commitRename = (): void => {
    const next = nameDraft.trim();
    if (next !== '' && next !== wallet.name) onRename(next);
    setEditingName(false);
  };

  return (
    <div className={styles.seedCard} data-testid={`seed-${wallet.id}`}>
      <div className={styles.seedHead}>
        {editingName ? (
          <span className={styles.renameRow}>
            <input
              className={styles.renameInput}
              data-testid={`rename-input-${wallet.id}`}
              aria-label="Seed name"
              value={nameDraft}
              disabled={busy}
              autoFocus
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') {
                  setNameDraft(wallet.name);
                  setEditingName(false);
                }
              }}
            />
            <button
              type="button"
              className={styles.renameSave}
              data-testid={`rename-save-${wallet.id}`}
              disabled={busy || nameDraft.trim() === ''}
              onClick={commitRename}
            >
              Save
            </button>
            <button
              type="button"
              className={styles.renameCancel}
              data-testid={`rename-cancel-${wallet.id}`}
              disabled={busy}
              onClick={() => {
                setNameDraft(wallet.name);
                setEditingName(false);
              }}
            >
              Cancel
            </button>
          </span>
        ) : (
          <>
            <span className={styles.seedName} data-testid={`seed-name-${wallet.id}`}>
              {wallet.name}
            </span>
            <button
              type="button"
              className={styles.renameButton}
              data-testid={`rename-${wallet.id}`}
              aria-label="Rename seed"
              title="Rename seed"
              disabled={busy}
              onClick={() => {
                setNameDraft(wallet.name);
                setEditingName(true);
              }}
            >
              ✎
            </button>
          </>
        )}
        <span
          className={styles.seedChip}
          style={{ color: chip.color, background: chip.background }}
        >
          {chip.label}
        </span>
        {wallet.isActive && (
          <span className={styles.activeBadge} data-testid="seed-active">
            Active
          </span>
        )}
        {showSwitch && !wallet.isActive && (
          <button
            type="button"
            className={styles.useSeed}
            data-testid={`use-seed-${wallet.id}`}
            disabled={busy}
            onClick={onUseSeed}
          >
            Use this seed
          </button>
        )}
      </div>

      <ul className={styles.accountList}>
        {wallet.accounts.map((a) => {
          // Two-tier selection:
          //  • selectedInSeed — this seed's own chosen account (every seed has one;
          //    gold ✓). Picking another updates only THIS seed's pointer.
          //  • inService — the ONE account actually used for operations: the active
          //    seed's selected account. Rendered ORANGE so it's unmistakable which
          //    account is live, distinct from each seed's local selection.
          const selectedInSeed = a.index === wallet.activeAccountIndex;
          const inService = wallet.isActive && selectedInSeed;
          const rowClass = inService
            ? styles.accountInService
            : selectedInSeed
              ? styles.accountSelected
              : '';
          return (
          <li key={a.index} className={styles.accountItem}>
            <button
              type="button"
              data-testid={`account-${wallet.id}-${a.index}`}
              data-in-service={inService ? 'true' : undefined}
              className={`${styles.accountRow} ${rowClass}`}
              disabled={busy}
              onClick={() => onSelectAccount(a.index)}
              title={
                inService
                  ? `In service: ${a.account}`
                  : `Select ${a.account} in this seed`
              }
            >
              <span className={styles.accountIndex}>#{a.index}</span>
              <span className={styles.accountAddr}>{shortAddress(a.account)}</span>
              {inService ? (
                <span
                  className={styles.accountServiceTag}
                  data-testid={`account-inservice-${wallet.id}-${a.index}`}
                >
                  ● in service
                </span>
              ) : selectedInSeed ? (
                <span className={styles.accountActiveTick} aria-hidden="true">
                  ✓
                </span>
              ) : null}
            </button>
            {a.index !== 0 && (
              <button
                type="button"
                className={styles.removeAccount}
                data-testid={`remove-account-${wallet.id}-${a.index}`}
                aria-label={`Remove account #${a.index}`}
                title={`Remove account #${a.index}`}
                disabled={busy}
                onClick={() => onRemoveAccount(a.index)}
              >
                ✕
              </button>
            )}
          </li>
          );
        })}
      </ul>

      <div className={styles.addRow}>
        <button
          type="button"
          className={styles.addButton}
          data-testid={`add-account-${wallet.id}`}
          disabled={busy}
          onClick={onAddAccount}
        >
          + Add next account
        </button>
        <div className={styles.atIndexRow}>
          <input
            type="number"
            min={0}
            className={styles.indexInput}
            data-testid={`add-index-input-${wallet.id}`}
            placeholder="index"
            value={indexInput}
            onChange={(e) => setIndexInput(e.target.value)}
            disabled={busy}
          />
          <button
            type="button"
            className={styles.addButton}
            data-testid={`add-at-index-${wallet.id}`}
            disabled={busy || indexInput.trim() === ''}
            onClick={() => {
              const n = Number(indexInput);
              if (Number.isInteger(n) && n >= 0) {
                onAddAtIndex(n);
                setIndexInput('');
              }
            }}
          >
            Add at index
          </button>
        </div>
      </div>
    </div>
  );
}

/** The vault's pure (raw `-g`) keypairs — label + `k:` address, read-only. These
 * arrive via a Codex import (or a future paste); they sign through the advanced-
 * account path, so this section just surfaces them so they're visible + usable. */
function PureKeysPanel({
  keys,
}: {
  readonly keys: readonly RemotePureKeypair[];
}): ReactNode {
  return (
    <div className={styles.pureKeysPanel} data-testid="pure-keys-panel">
      <h2 className={styles.pureKeysHeading}>Pure keys</h2>
      <p className={styles.pureKeysHelp}>
        Raw keypairs in this wallet (not derived from a seed). They sign via
        advanced accounts.
      </p>
      <ul className={styles.pureKeyList}>
        {keys.map((k) => (
          <li
            key={k.id}
            className={styles.pureKeyRow}
            data-testid={`pure-key-${k.publicKey}`}
          >
            <span className={styles.pureKeyLabel}>{k.label ?? 'Pure key'}</span>
            <span className={styles.pureKeyAddr} title={k.account}>
              {shortAddress(k.account)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The Codex import panel: a JSON file picker + the codex password + import. */
function ImportCodexPanel({
  busy,
  onImport,
}: {
  readonly busy: boolean;
  readonly onImport: (
    json: string,
    codexPassword: string,
  ) => Promise<RemoteImportCodexResult>;
}): ReactNode {
  const [json, setJson] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const onFile = async (file: File | undefined): Promise<void> => {
    setError(null);
    if (file === undefined) return;
    setFileName(file.name);
    setJson(await readFileText(file));
  };

  const onSubmit = async (): Promise<void> => {
    if (json === null || password === '') return;
    const result = await onImport(json, password);
    if (!result.ok) {
      setError(IMPORT_REASON_TEXT[result.reason] ?? 'Import failed.');
      return;
    }
    // Success — clear the sensitive password + the staged file.
    setPassword('');
    setJson(null);
    setFileName(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className={styles.importPanel} data-testid="import-codex-panel">
      <h2 className={styles.importHeading}>Import an Ouronet Codex</h2>
      <p className={styles.importHelp}>
        Brings in all the codex&apos;s seeds, accounts and keys. The codex password
        is used only to decrypt — it never leaves the wallet.
      </p>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        data-testid="codex-file"
        className={styles.fileInput}
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      {fileName !== null && (
        <p className={styles.fileName}>Selected: {fileName}</p>
      )}
      <div data-testid="codex-password-field">
        <PasswordInput
          id="codex-password"
          label="Codex password"
          value={password}
          onChange={setPassword}
          autoComplete="off"
          placeholder="Codex password"
        />
      </div>
      {error !== null && (
        <p className={styles.importError} role="alert" data-testid="import-error">
          {error}
        </p>
      )}
      <button
        type="button"
        className={styles.importButton}
        data-testid="codex-import-submit"
        disabled={busy || json === null || password === ''}
        onClick={() => void onSubmit()}
      >
        {busy ? 'Importing…' : 'Import Codex'}
      </button>
    </div>
  );
}

/** Human text for each import failure reason (secret-free). */
const IMPORT_REASON_TEXT: Record<string, string> = {
  'invalid-json': "That file isn't a valid Codex export.",
  'unsupported-version': 'That Codex version is not supported (expected 1.2).',
  'wrong-codex-password': 'Wrong codex password — could not decrypt.',
  'no-importable-content': 'Nothing new to import — already in this wallet.',
  locked: 'Unlock the wallet first, then import.',
};
