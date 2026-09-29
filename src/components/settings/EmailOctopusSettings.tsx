'use client';

import React, { useState } from 'react';

import styles from '@/app/page.module.css';

/**
 * EmailOctopus connection settings (audit H1).
 *
 * The saved API key never reaches the browser. The field is write-only: left blank it
 * keeps the saved key, filled it replaces it, and clearing is a separate explicit
 * action. Only administrators may save; everyone else sees the connection state.
 */

export type EmailOctopusStatus = {
  apiKeyConfigured: boolean;
  listId: string;
  configured: boolean;
  canEdit: boolean;
};

type Props = {
  status: EmailOctopusStatus | null;
  onSaved: (status: EmailOctopusStatus) => void;
};

type ApiKeyAction = 'unchanged' | 'replace' | 'clear';

export default function EmailOctopusSettings({ status, onSaved }: Props) {
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [listIdDraft, setListIdDraft] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const listId = listIdDraft ?? status?.listId ?? '';
  const canEdit = Boolean(status?.canEdit);

  const save = async () => {
    const action: ApiKeyAction = clearKey ? 'clear' : apiKeyDraft.trim() ? 'replace' : 'unchanged';
    setIsSaving(true);
    setMessage(null);

    try {
      const response = await fetch('/api/integrations/emailoctopus/credentials', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: action === 'replace' ? { action, value: apiKeyDraft } : { action },
          listId,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Save failed (HTTP ${response.status})`);

      setApiKeyDraft('');
      setClearKey(false);
      setListIdDraft(null);
      onSaved(body as EmailOctopusStatus);
      setMessage({ kind: 'success', text: 'EmailOctopus settings saved.' });
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Save failed.' });
    } finally {
      setIsSaving(false);
    }
  };

  const keyPlaceholder = status?.apiKeyConfigured
    ? 'Saved — leave blank to keep the current key'
    : 'Paste the EmailOctopus API key';

  return (
    <>
      <div className="outerShell">
        <div className="innerCore" style={{ padding: '24px' }}>
          <div className={styles.sectionTitle} style={{ margin: 0, borderBottom: '1px dashed var(--border)', paddingBottom: '12px', marginBottom: '20px' }}>Email Marketing Keys</div>

          {status && !canEdit && (
            <p className={styles.settingDescription} data-testid="credentials-read-only">
              Only an administrator can change these settings.
            </p>
          )}

          <div className={styles.settingGroup}>
            <label className={styles.settingLabel} htmlFor="emailoctopus-api-key">EmailOctopus API Key</label>
            <input
              type="password"
              autoComplete="off"
              className={styles.searchInput}
              style={{ maxWidth: '100%', marginTop: '6px' }}
              placeholder={keyPlaceholder}
              id="emailoctopus-api-key"
              value={apiKeyDraft}
              disabled={!canEdit || clearKey}
              onChange={(e) => setApiKeyDraft(e.target.value)}
              aria-describedby="emailoctopus-api-key-state"
            />
            <span className={styles.settingDescription} id="emailoctopus-api-key-state" data-testid="api-key-state">
              {status === null
                ? 'Checking the saved key…'
                : status.apiKeyConfigured
                  ? 'A key is saved. It is never shown again; enter a new one to replace it.'
                  : 'No key is saved.'}
            </span>
            {canEdit && status?.apiKeyConfigured && (
              <label className={styles.settingDescription} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={clearKey}
                  onChange={(e) => {
                    setClearKey(e.target.checked);
                    if (e.target.checked) setApiKeyDraft('');
                  }}
                />
                Remove the saved key (disconnects EmailOctopus)
              </label>
            )}
          </div>

          <div className={styles.settingGroup} style={{ marginBottom: 0 }}>
            <label className={styles.settingLabel} htmlFor="emailoctopus-list-id">EmailOctopus List ID</label>
            <input
              type="text"
              className={styles.searchInput}
              style={{ maxWidth: '100%', marginTop: '6px' }}
              placeholder="your-emailoctopus-list-id"
              id="emailoctopus-list-id"
              value={listId}
              disabled={!canEdit}
              onChange={(e) => setListIdDraft(e.target.value)}
            />
            <span className={styles.settingDescription}>EmailOctopus campaigns subscriber list ID.</span>
          </div>
        </div>
      </div>

      {message && (
        <p role={message.kind === 'error' ? 'alert' : 'status'} className={styles.settingDescription}>
          {message.text}
        </p>
      )}

      <button
        className={styles.actionButton}
        style={{ width: '100%', justifyContent: 'center' }}
        onClick={save}
        disabled={!canEdit || isSaving}
      >
        {isSaving ? 'Saving…' : 'Save Config Options'}
      </button>
    </>
  );
}
