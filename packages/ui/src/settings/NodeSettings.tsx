import type { ApplyFailureReason, NodePreference } from '@stoawallet/core';
import { useState, type ReactNode } from 'react';

import { useSettings } from './SettingsContext';
import { useNodeApply } from './useNodeApply';
import styles from './NodeSettings.module.css';

/**
 * The node-endpoint Settings section: a three-option selector (Default / Node2 /
 * Custom), an Apply action driven by the {@link useNodeApply} validation state
 * machine, a one-click Revert-to-default, the current active node, per-reason
 * validation feedback, and a trust warning shown only for Custom.
 *
 * It composes the injected applier through {@link useSettings} — no `chrome.*`/
 * Capacitor here. The custom URL is never logged; failures surface a reason code
 * mapped to a distinct human message, never the raw URL.
 */

type NodeChoice = 'default' | 'node2' | 'custom';

/** Each discriminated apply-failure reason → its OWN distinct user message. */
const REASON_MESSAGE: Record<ApplyFailureReason, string> = {
  'malformed-url': 'Enter a valid URL',
  'insecure-scheme': 'The node URL must use https',
  unreachable: 'Could not reach that node',
  'wrong-network': 'That node is not a StoaChain ("stoa") node',
};

export function NodeSettings(): ReactNode {
  const { nodeStatus, recoveredFromCorrupt, dismissResetNotice, revert } =
    useSettings();
  const { state, result, isValidating, apply } = useNodeApply();

  const [choice, setChoice] = useState<NodeChoice>('default');
  const [customUrl, setCustomUrl] = useState('');

  function onApply(): void {
    const pref: NodePreference =
      choice === 'custom'
        ? { kind: 'custom', customUrl }
        : { kind: choice };
    void apply(pref);
  }

  const feedback =
    state === 'invalid' && result !== null && result.ok === false
      ? REASON_MESSAGE[result.reason]
      : null;

  return (
    <section className={styles.section} aria-labelledby="node-settings-heading">
      <h2 id="node-settings-heading" className={styles.heading}>
        Network &amp; Node
      </h2>

      {recoveredFromCorrupt && (
        <div className={styles.notice} role="status" data-testid="reset-notice">
          <span>Your node setting was reset to default.</span>
          <button
            type="button"
            className={styles.dismiss}
            onClick={dismissResetNotice}
          >
            Dismiss
          </button>
        </div>
      )}

      <p className={styles.activeNode}>
        Connected to{' '}
        <span className={styles.activeNodeValue} data-testid="active-node">
          {nodeStatus.active}
        </span>
        {!nodeStatus.isOnPrimary && (
          <span className={styles.fallbackTag}> (on fallback)</span>
        )}
      </p>

      <fieldset className={styles.options}>
        <legend className={styles.legend}>Node endpoint</legend>

        <label className={styles.option}>
          <input
            type="radio"
            name="node-choice"
            aria-label="Default"
            checked={choice === 'default'}
            onChange={() => setChoice('default')}
          />
          <span>Default (node1 primary, node2 fallback)</span>
        </label>

        <label className={styles.option}>
          <input
            type="radio"
            name="node-choice"
            aria-label="Node2"
            checked={choice === 'node2'}
            onChange={() => setChoice('node2')}
          />
          <span>Node2</span>
        </label>

        <label className={styles.option}>
          <input
            type="radio"
            name="node-choice"
            aria-label="Custom"
            checked={choice === 'custom'}
            onChange={() => setChoice('custom')}
          />
          <span>Use a custom node</span>
        </label>
      </fieldset>

      {choice === 'custom' && (
        <div className={styles.customBlock}>
          <label className={styles.urlLabel} htmlFor="custom-node-url">
            Node URL
          </label>
          <input
            id="custom-node-url"
            type="url"
            className={styles.urlInput}
            placeholder="https://your-node.example.com"
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
          />

          <div
            className={styles.trustWarning}
            role="alert"
            data-testid="node-trust-warning"
          >
            <strong>Trust warning.</strong> A custom node can see the addresses
            and transactions this wallet queries, and could return false data
            (such as wrong balances) or withhold/delay your transactions. It{' '}
            <strong>cannot steal your funds</strong> — signing happens locally
            and every transaction is explicitly approved by you. A custom node
            also has no node1/node2 failover: if it goes down, the wallet does
            not silently fall back to the default nodes.
          </div>
        </div>
      )}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.apply}
          onClick={onApply}
          disabled={isValidating}
        >
          {isValidating ? 'Checking node…' : 'Apply'}
        </button>
        <button
          type="button"
          className={styles.revert}
          onClick={() => void revert()}
        >
          Revert to default
        </button>
      </div>

      {feedback !== null && (
        <p className={styles.feedback} role="alert" data-testid="node-feedback">
          {feedback}
        </p>
      )}
    </section>
  );
}
