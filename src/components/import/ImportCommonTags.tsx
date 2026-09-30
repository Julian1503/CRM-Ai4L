'use client';

import React, { useId, useState } from 'react';

import { describeTagError, mergeTagNames, parseTagList, tagKey } from '@/lib/contacts/tags';
import { TAGS_FORMAT_EXAMPLE } from '@/lib/contacts/importFields';
import { MAX_TAGS_PER_CONTACT, TAG_SEPARATOR } from '@/lib/db/types';

import styles from './ImportPanels.module.css';

/**
 * Tags added to every contact the import accepts, on top of each row's own `Tags` cell.
 *
 * Works with tag *names*, not catalog ids: new names are created by import_contacts when
 * the import commits, never while previewing, so nothing here calls the tag API. The
 * parent passes the list to mapAndValidateRows({ commonTags }); changing it changes the
 * validated rows, which is what re-runs the change preview.
 */

type Props = {
  value: readonly string[];
  onChange: (names: string[]) => void;
  disabled?: boolean;
};

export default function ImportCommonTags({ value, onChange, disabled = false }: Props) {
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    const parsed = parseTagList(draft);
    const merged = mergeTagNames(value, parsed.names);
    const problems = [...parsed.errors, ...merged.errors];

    if (problems.length > 0) {
      setError(problems.map(describeTagError).join(' '));
      return;
    }
    if (parsed.names.length === 0) return;

    setError(null);
    setDraft('');
    onChange(merged.names);
  };

  const remove = (name: string) => {
    onChange(value.filter((existing) => tagKey(existing) !== tagKey(name)));
  };

  return (
    <fieldset className={styles.fieldset} disabled={disabled} data-testid="import-common-tags">
      <legend className={styles.legend}>Tags for every imported contact (optional)</legend>
      <p id={hintId} className={styles.hint}>
        Added on top of the file&apos;s Tags column; existing tags are kept. Separate several with
        &ldquo;{TAG_SEPARATOR}&rdquo;, e.g. {TAGS_FORMAT_EXAMPLE}. A contact can have at most{' '}
        {MAX_TAGS_PER_CONTACT} tags.
      </p>
      <div className={styles.inputRow}>
        <label htmlFor={inputId} className={styles.srOnly}>
          Common tags
        </label>
        <input
          id={inputId}
          className={styles.input}
          value={draft}
          placeholder={TAGS_FORMAT_EXAMPLE}
          aria-describedby={error ? `${hintId} ${errorId}` : hintId}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
          data-testid="import-common-tags-input"
        />
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={add}
          disabled={draft.trim() === ''}
        >
          Add
        </button>
      </div>
      {error && (
        <p id={errorId} role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {value.length > 0 && (
        <ul className={styles.chips} aria-label="Common tags">
          {value.map((name) => (
            <li key={tagKey(name)} className={styles.chip}>
              {name}
              <button
                type="button"
                className={styles.chipRemove}
                aria-label={`Remove ${name}`}
                onClick={() => remove(name)}
              >
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
