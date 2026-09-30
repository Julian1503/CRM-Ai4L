'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

import styles from '@/app/page.module.css';
import type { ImportPreview } from '@/lib/db/types';
import type { MappedContactRow } from '@/lib/excelParser';

import panelStyles from './ImportPanels.module.css';

/**
 * What an import will change, before it changes anything (audit P3).
 *
 * The counts come from the database, computed with the import's own rules, so the
 * preview and the import cannot disagree about what "unchanged" means. Status and
 * consent changes are called out on their own because they are the consequential ones.
 * The import then commits with the preview's token and is refused if any matched
 * contact changed in between — the operator is shown a fresh preview instead.
 *
 * A preview belongs to the `onPreview` that produced it. The parent recreates
 * `onPreview` whenever what would be imported changes (mapping, common tags), so a new
 * function means the shown preview no longer describes the import: it is dropped, a
 * fresh one is requested, and a late answer to an older request is ignored.
 */

const MAX_LISTED_NEW_TAGS = 10;

type Props = {
  rows: MappedContactRow[];
  /** Recreate it whenever the rows to import change; that is what invalidates the preview. */
  onPreview: () => Promise<ImportPreview>;
  /** Resolves with a result message; rejects with `stale` true when the preview expired. */
  onCommit: (token: string) => Promise<void>;
};

function rejectedRowsCsv(rows: MappedContactRow[]): string {
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const lines = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => !row.isValid)
    .map(({ row, index }) => `${index + 1},${escape((row.errors ?? []).join('; '))}`);
  return ['row,problems', ...lines].join('\n');
}

export default function ImportChangePreview({ rows, onPreview, onCommit }: Props) {
  const [loaded, setLoaded] = useState<{ preview: ImportPreview; source: Props['onPreview'] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isCommitting, setIsCommitting] = useState(false);
  const latestRequest = useRef(0);

  // Only a preview of the current rows may be shown or committed.
  const preview = loaded && loaded.source === onPreview ? loaded.preview : null;

  const load = useCallback(async () => {
    const request = ++latestRequest.current;
    setIsLoading(true);
    setError(null);
    try {
      const next = await onPreview();
      if (request === latestRequest.current) setLoaded({ preview: next, source: onPreview });
    } catch (loadError) {
      if (request === latestRequest.current) {
        setError(loadError instanceof Error ? loadError.message : 'Could not preview the import.');
      }
    } finally {
      if (request === latestRequest.current) setIsLoading(false);
    }
  }, [onPreview]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const commit = async () => {
    if (!preview) return;
    setIsCommitting(true);
    setError(null);
    try {
      await onCommit(preview.token);
    } catch (commitError) {
      const stale = commitError instanceof Error && commitError.name === 'ImportPreviewStaleError';
      // Reload first: loading clears the error, and this message must survive it.
      if (stale) await load();
      setError(
        stale
          ? 'Some of these contacts changed after this preview was made. Here is an updated preview — check it before importing.'
          : commitError instanceof Error
            ? commitError.message
            : 'The import failed. Nothing was changed.'
      );
    } finally {
      setIsCommitting(false);
    }
  };

  const invalidCount = rows.filter((row) => !row.isValid).length;
  const rejectedHref = invalidCount > 0
    ? `data:text/csv;charset=utf-8,${encodeURIComponent(rejectedRowsCsv(rows))}`
    : null;
  const importable = preview ? preview.new + preview.changed + preview.unchanged : 0;
  const newTags = preview?.tags_created ?? [];

  return (
    <section aria-labelledby="import-changes-heading" data-testid="import-change-preview">
      <h5 id="import-changes-heading" style={{ color: 'var(--text-primary)', marginBottom: '8px', fontWeight: 600 }}>
        What this import will change
      </h5>

      {isLoading && <p className={styles.settingDescription} role="status">Checking these rows against your contacts…</p>}

      {error && (
        <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.85rem' }} data-testid="import-preview-error">
          {error}{' '}
          {!preview && (
            <button type="button" onClick={() => void load()} style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', fontWeight: 600 }}>
              Try again
            </button>
          )}
        </p>
      )}

      {preview && !isLoading && (
        <>
          <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '8px', marginBottom: '12px' }} data-testid="import-preview-counts">
            <li><strong>{preview.new}</strong> new</li>
            <li><strong>{preview.changed}</strong> updated</li>
            <li><strong>{preview.unchanged}</strong> unchanged</li>
            <li><strong>{preview.rejected}</strong> rejected</li>
            {preview.duplicates > 0 && <li><strong>{preview.duplicates}</strong> repeated in file (first row used)</li>}
            {preview.held_back > 0 && <li><strong>{preview.held_back}</strong> held back (archived)</li>}
          </ul>

          <ul style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '12px' }} data-testid="import-preview-consequences">
            {!preview.customer_column_present && (
              <li>No customer column is mapped: existing contacts keep their status; new contacts start as prospects.</li>
            )}
            {preview.becoming_customers > 0 && <li><strong>{preview.becoming_customers}</strong> existing contact(s) will become customers.</li>}
            {preview.leaving_customers > 0 && <li><strong>{preview.leaving_customers}</strong> existing customer(s) will become prospects.</li>}
            {preview.withdrawing_newsletter > 0 && <li><strong>{preview.withdrawing_newsletter}</strong> contact(s) will lose newsletter consent.</li>}
            {preview.withdrawing_programs > 0 && <li><strong>{preview.withdrawing_programs}</strong> contact(s) will lose courses consent.</li>}
            {(preview.tags_assigned ?? 0) > 0 && (
              <li data-testid="import-preview-tags-assigned">
                <strong>{preview.tags_assigned}</strong> contact(s) will receive new tags; tags they already have are kept.
              </li>
            )}
            {(preview.tags_only_changed ?? 0) > 0 && (
              <li data-testid="import-preview-tags-only">
                <strong>{preview.tags_only_changed}</strong> of the updated contacts change only by receiving tags.
              </li>
            )}
            {newTags.length > 0 && (
              <li data-testid="import-preview-tags-created">
                <strong>{newTags.length}</strong> new tag(s) will be created:{' '}
                {newTags.slice(0, MAX_LISTED_NEW_TAGS).join(', ')}
                {newTags.length > MAX_LISTED_NEW_TAGS && ` and ${newTags.length - MAX_LISTED_NEW_TAGS} more`}.
              </li>
            )}
            <li>Blank or unmapped cells never erase existing details, and an import never re-grants consent someone withdrew.</li>
          </ul>

          {preview.samples.length > 0 && (
            <div style={{ maxHeight: '180px', overflowY: 'auto', marginBottom: '12px', border: '1px solid var(--border)', borderRadius: '8px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                <caption className={panelStyles.srOnly}>Examples of what will change</caption>
                <thead>
                  <tr>
                    <th scope="col" style={{ textAlign: 'left', padding: '6px 12px' }}>Email</th>
                    <th scope="col" style={{ textAlign: 'left', padding: '6px 12px' }}>Outcome</th>
                    <th scope="col" style={{ textAlign: 'left', padding: '6px 12px' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.samples.map((sample) => (
                    <tr key={sample.email}>
                      <td style={{ padding: '6px 12px' }}>{sample.email}</td>
                      <td style={{ padding: '6px 12px' }}>{sample.outcome === 'held_back' ? 'held back' : sample.outcome}</td>
                      <td style={{ padding: '6px 12px' }}>
                        {sample.previous_status && sample.previous_status !== sample.status
                          ? `${sample.previous_status} → ${sample.status}`
                          : sample.status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {rejectedHref && (
            <p style={{ fontSize: '0.82rem', marginBottom: '12px' }}>
              <a href={rejectedHref} download="import-rejected-rows.csv" data-testid="download-rejected">
                Download the {invalidCount} rejected row(s) with reasons
              </a>
            </p>
          )}

          <button
            className={styles.actionButton}
            style={{ width: '100%', justifyContent: 'center' }}
            onClick={() => void commit()}
            disabled={isCommitting || importable === 0}
            data-testid="confirm-import"
          >
            {isCommitting ? 'Importing…' : `Import ${importable} contact${importable === 1 ? '' : 's'}`}
          </button>
        </>
      )}
    </section>
  );
}
