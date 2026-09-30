'use client';

import React from 'react';

import {
  describeMissingRequirements,
  type AmbiguousHeader,
  type ColumnMapping,
  type CrmFieldKey,
} from '@/lib/contacts/columnMapping';
import { fieldLabel } from '@/lib/contacts/importFields';

import styles from './ImportPanels.module.css';

/**
 * Mapping-screen status: which concrete requirement is still missing, and which columns
 * the importer refused to guess (Industry/Sector) with a way to choose for them.
 *
 * Missing requirements come from describeMissingRequirements(), the same rules the
 * "Which columns do I need?" help lists.
 */

type Props = {
  mapping: ColumnMapping;
  /** From analyseHeaders(headers).ambiguous. */
  ambiguous?: AmbiguousHeader[];
  /** Maps `header` to `field`; the same update the mapping select makes. */
  onMapColumn?: (field: CrmFieldKey, header: string) => void;
};

export default function ImportMappingStatus({ mapping, ambiguous = [], onMapColumn }: Props) {
  const missing = describeMissingRequirements(mapping);

  return (
    <div className={styles.stack} data-testid="import-mapping-status">
      <div
        role="status"
        className={missing.length > 0 ? styles.warning : styles.ok}
        data-testid="import-missing-requirements"
      >
        {missing.length > 0 ? (
          <>
            <p className={styles.title}>Before you can preview this import:</p>
            <ul className={styles.list}>
              {missing.map((requirement) => (
                <li key={requirement.message}>{requirement.message}</li>
              ))}
            </ul>
          </>
        ) : (
          <p className={styles.title}>Required columns are mapped.</p>
        )}
      </div>

      {ambiguous.length > 0 && (
        <div className={styles.notice} data-testid="import-ambiguous-columns">
          <p className={styles.title}>Columns that need your choice</p>
          <ul className={styles.list}>
            {ambiguous.map((item) => {
              const chosen = item.candidates.find((field) => mapping[field] === item.header);

              return (
                <li key={item.header} className={styles.ambiguousItem}>
                  <span>
                    <strong>&ldquo;{item.header}&rdquo;</strong>{' '}
                    {chosen
                      ? `is mapped to ${fieldLabel(chosen)} by your choice.`
                      : 'was not mapped automatically and will be ignored unless you map it.'}
                  </span>
                  <span className={styles.muted}>{item.reason}</span>
                  {!chosen && onMapColumn && (
                    <span className={styles.actions}>
                      {item.candidates.map((field) => (
                        <button
                          key={field}
                          type="button"
                          className={styles.secondaryButton}
                          onClick={() => onMapColumn(field, item.header)}
                        >
                          Use &ldquo;{item.header}&rdquo; as {fieldLabel(field)}
                        </button>
                      ))}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
