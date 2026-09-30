'use client';

import React, { useEffect, useId, useRef, useState } from 'react';

import {
  BLANK_CELLS_RULE,
  IMPORT_REQUIREMENT_OPTIONS,
  TAGS_FORMAT_EXAMPLE,
  TAGS_FORMAT_RULES,
} from '@/lib/contacts/importFields';

import styles from './ImportRequirements.module.css';

/**
 * "Which columns do I need?" help for the importer, shown before upload and during
 * mapping. The requirement list is IMPORT_REQUIREMENT_OPTIONS, the same list the mapping
 * validation checks, so the help cannot drift from what is enforced.
 *
 * Opens on hover, keyboard focus and click/tap (touch screens have no hover); a second
 * click, Escape or a tap elsewhere closes it. The panel stays open while the pointer is
 * over it (WCAG 1.4.13) and is tied to its button with `aria-describedby`, never `title`.
 */

type Props = {
  /** Visible button text. */
  label?: string;
  className?: string;
};

export function ImportRequirementsDetails() {
  return (
    <>
      <p className={styles.heading}>Your file needs one of these column sets:</p>
      <ul className={styles.options}>
        {IMPORT_REQUIREMENT_OPTIONS.map((option) => (
          <li key={option.id}>
            <strong>{option.label}</strong>
            {option.note && <span className={styles.note}>{option.note}</span>}
          </li>
        ))}
      </ul>
      <p>
        Headers can be named anything — you match them to CRM fields after uploading. Every other
        column is optional.
      </p>
      <p>{BLANK_CELLS_RULE}</p>
      <p>
        <strong>Tags</strong> (optional): <code className={styles.code}>{TAGS_FORMAT_EXAMPLE}</code>.{' '}
        {TAGS_FORMAT_RULES}
      </p>
      <p>
        An <strong>Industry</strong> or <strong>Sector</strong> column is not matched automatically: it
        usually describes the organisation, not the contact&apos;s Job Type.
      </p>
    </>
  );
}

export default function ImportRequirements({ label = 'Which columns do I need?', className }: Props) {
  const tooltipId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);

  const isOpen = !isDismissed && (isHovered || isFocused || isPinned);

  const close = () => {
    setIsPinned(false);
    setIsDismissed(true);
  };

  // Escape anywhere closes it, and a tap outside releases a pinned panel.
  useEffect(() => {
    if (!isOpen) return;

    const dismiss = () => {
      setIsPinned(false);
      setIsDismissed(true);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) dismiss();
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [isOpen]);

  return (
    <div
      ref={wrapperRef}
      className={[styles.wrapper, className].filter(Boolean).join(' ')}
      onPointerEnter={(event) => {
        // Touch "hover" is emulated right before the click; let the click decide there.
        if (event.pointerType === 'touch') return;
        setIsDismissed(false);
        setIsHovered(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== 'touch') setIsHovered(false);
      }}
      data-testid="import-requirements"
    >
      <button
        type="button"
        className={styles.trigger}
        aria-describedby={tooltipId}
        aria-expanded={isOpen}
        aria-controls={tooltipId}
        onFocus={() => {
          setIsDismissed(false);
          setIsFocused(true);
        }}
        onBlur={(event) => {
          setIsFocused(false);
          if (!wrapperRef.current?.contains(event.relatedTarget as Node | null)) setIsPinned(false);
        }}
        onClick={() => {
          if (isPinned) {
            close();
          } else {
            setIsDismissed(false);
            setIsPinned(true);
          }
        }}
      >
        <span aria-hidden="true" className={styles.icon}>?</span>
        {label}
      </button>
      <div id={tooltipId} role="tooltip" className={styles.panel} hidden={!isOpen}>
        <ImportRequirementsDetails />
      </div>
    </div>
  );
}
