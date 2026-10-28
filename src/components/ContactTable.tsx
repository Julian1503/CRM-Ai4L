'use client';

import React, { useRef } from 'react';
import styles from './ContactTable.module.css';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';

import { prefersReducedMotion } from '@/lib/motion';
import type { ContactStatus } from '@/lib/db/types';

type ActiveContactStatus = Exclude<ContactStatus, 'archived'>;

/** Tags shown per row before the rest collapse into a "+N" summary. */
export const VISIBLE_ROW_TAGS = 2;

function RowTags({ tags }: { tags: { id: string; name: string }[] }) {
  if (tags.length === 0) return null;

  const visible = tags.slice(0, VISIBLE_ROW_TAGS);
  const hidden = tags.slice(VISIBLE_ROW_TAGS);

  return (
    <ul className={styles.tagList} aria-label="Tags">
      {visible.map((tag) => (
        <li key={tag.id} className={styles.tagChip}>
          {tag.name}
        </li>
      ))}
      {hidden.length > 0 && (
        <li
          className={`${styles.tagChip} ${styles.tagMore}`}
          title={hidden.map((tag) => tag.name).join(', ')}
          aria-label={`${hidden.length} more: ${hidden.map((tag) => tag.name).join(', ')}`}
        >
          +{hidden.length}
        </li>
      )}
    </ul>
  );
}

/** Shared empty set, so an unselectable table does not allocate one per render. */
const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>();

export interface TableContact {
  id: string;
  firstName: string;
  lastName: string;
  preferredName?: string;
  email: string;
  mobileNumber?: string;
  workPhone?: string;
  address?: string;
  suburb?: string;
  state?: string;
  postcode?: string;
  country?: string;
  department?: string;
  position?: string;
  /** Canonical CRM lifecycle status. `isCustomer` remains for legacy call sites. */
  status?: ActiveContactStatus;
  isCustomer: boolean;
  subscribedToNewsletter: boolean;
  subscribedToPrograms: boolean;
  /** FK to job_types; drives the job-type filter and segmentation. */
  jobTypeId?: string | null;
  organisation?: { name: string } | null;
  notes?: string;
  servicesBought?: string[];
  /** The row's revision when loaded; an edit is refused if it has moved on (H8). */
  revision?: number;
  /** CRM tags on the contact, as returned by the contacts API. */
  tags?: { id: string; name: string }[];
}

interface ContactTableProps {
  contacts: TableContact[];
  onSelectContact: (contact: TableContact) => void;
  onSort: (key: string) => void;
  sortKey: string;
  sortDir: 'asc' | 'desc';
  isLoading?: boolean;
  /**
   * Ids currently ticked, including ones on other pages.
   *
   * Row selection is opt-in: the checkbox column appears only when `onToggleRow` is
   * supplied, so a screen that has nothing to do with a selection does not grow a column
   * of controls that lead nowhere.
   */
  selectedIds?: ReadonlySet<string>;
  onToggleRow?: (id: string, selected: boolean) => void;
  /** Ticks or clears every row on the current page. */
  onTogglePage?: (ids: string[], selected: boolean) => void;
  /**
   * The last load failed (audit M2). The rows shown are the last ones that loaded, and
   * the empty state is never shown for a failure: "no contacts" and "could not load
   * contacts" are different facts.
   */
  loadError?: string | null;
  onRetry?: () => void;
  /**
   * Right-click (or the keyboard's context-menu key) on a row. When supplied the browser
   * menu is replaced by the page's own quick actions.
   */
  onRowContextMenu?: (contact: TableContact, position: { x: number; y: number }) => void;
}

export default function ContactTable({
  contacts,
  onSelectContact,
  onSort,
  sortKey,
  sortDir,
  isLoading = false,
  selectedIds,
  onToggleRow,
  onTogglePage,
  loadError = null,
  onRetry,
  onRowContextMenu,
}: ContactTableProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  /** The row a Shift-click extends from: the last one ticked or unticked by hand. */
  const anchorIdRef = useRef<string | null>(null);

  const isSelectable = typeof onToggleRow === 'function';
  const selection = selectedIds ?? EMPTY_SELECTION;
  const pageIds = contacts.map((contact) => contact.id);
  const isSelecting = isSelectable && selection.size > 0;

  const toggleRow = (id: string, selected: boolean) => {
    anchorIdRef.current = id;
    onToggleRow?.(id, selected);
  };

  /**
   * A row click opens the contact — until something is ticked. From then on the list is
   * in selection mode, as in a mail client: clicks add and remove rows, Shift-click ticks
   * the run from the last row touched, and Open lives in the right-click menu. Ctrl/⌘-click
   * selects without opening even before anything is ticked.
   */
  const handleRowClick = (event: React.MouseEvent, contact: TableContact) => {
    const wantsSelection = isSelecting || event.ctrlKey || event.metaKey || event.shiftKey;
    if (!isSelectable || !wantsSelection) {
      onSelectContact(contact);
      return;
    }

    const anchorIndex = anchorIdRef.current ? pageIds.indexOf(anchorIdRef.current) : -1;
    if (event.shiftKey && anchorIndex !== -1) {
      // Shift-click would otherwise also select the text between the two rows.
      window.getSelection?.()?.removeAllRanges();
      const index = pageIds.indexOf(contact.id);
      const [start, end] = index < anchorIndex ? [index, anchorIndex] : [anchorIndex, index];
      onTogglePage?.(pageIds.slice(start, end + 1), true);
      return;
    }

    toggleRow(contact.id, !selection.has(contact.id));
  };
  const selectedOnPage = pageIds.filter((id) => selection.has(id)).length;
  const isPageFullySelected = pageIds.length > 0 && selectedOnPage === pageIds.length;
  const isPagePartiallySelected = selectedOnPage > 0 && !isPageFullySelected;
  // Name, organisation, position, status, newsletter, courses (+ the checkbox column).
  const columnCount = isSelectable ? 7 : 6;

  // `indeterminate` has no HTML attribute — it exists only on the DOM node, so a
  // "some rows on this page are ticked" header checkbox has to be set imperatively.
  React.useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = isPagePartiallySelected;
    }
  }, [isPagePartiallySelected]);

  useGSAP(() => {
    if (prefersReducedMotion()) return;
    if (isLoading || contacts.length === 0) return;

    gsap.fromTo(
      `.${styles.tr}`,
      { opacity: 0, y: 12 },
      {
        opacity: 1,
        y: 0,
        duration: 0.35,
        stagger: 0.03,
        ease: 'power2.out',
        clearProps: 'transform,opacity',
      }
    );
  }, { dependencies: [contacts, isLoading], scope: containerRef });

  const renderSortIndicator = (key: string) => {
    if (sortKey !== key) return null;
    return <span className={styles.sortIcon}>{sortDir === 'asc' ? '▲' : '▼'}</span>;
  };

  const handleKeyDown = (e: React.KeyboardEvent, key: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSort(key);
    }
  };

  const getAriaSort = (key: string) => {
    if (sortKey !== key) return 'none';
    return sortDir === 'asc' ? 'ascending' : 'descending';
  };

  const getContactStatus = (contact: TableContact): ActiveContactStatus =>
    contact.status ?? (contact.isCustomer ? 'customer' : 'prospect');

  return (
    <div ref={containerRef} className={styles.tableShell}>
      {loadError && (
        <div className={styles.loadError} role="alert" data-testid="contacts-load-error">
          <span>
            {loadError}
            {contacts.length > 0 ? ' Showing the last contacts that loaded.' : ''}
          </span>
          {onRetry && (
            <button type="button" className={styles.retryButton} onClick={onRetry} disabled={isLoading}>
              Try again
            </button>
          )}
        </div>
      )}
      <div className={styles.tableContainer}>
        <table className={styles.table}>
          <thead className={styles.thead}>
            <tr>
              {isSelectable && (
                <th className={`${styles.th} ${styles.checkboxCell}`} role="columnheader">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    className={styles.checkbox}
                    data-testid="select-all-contacts"
                    aria-label={
                      isPageFullySelected ? 'Clear selection on this page' : 'Select all on this page'
                    }
                    checked={isPageFullySelected}
                    disabled={isLoading || pageIds.length === 0}
                    onChange={(event) => onTogglePage?.(pageIds, event.target.checked)}
                  />
                </th>
              )}
              <th 
                className={`${styles.th} ${styles.sortable}`} 
                onClick={() => onSort('name')}
                onKeyDown={(e) => handleKeyDown(e, 'name')}
                tabIndex={0}
                role="columnheader"
                aria-sort={getAriaSort('name')}
              >
                Name {renderSortIndicator('name')}
              </th>
              <th 
                className={`${styles.th} ${styles.sortable}`} 
                onClick={() => onSort('organisation')}
                onKeyDown={(e) => handleKeyDown(e, 'organisation')}
                tabIndex={0}
                role="columnheader"
                aria-sort={getAriaSort('organisation')}
              >
                Organisation {renderSortIndicator('organisation')}
              </th>
              <th className={styles.th} role="columnheader">Position / Title</th>
              <th 
                className={`${styles.th} ${styles.sortable}`} 
                onClick={() => onSort('status')}
                onKeyDown={(e) => handleKeyDown(e, 'status')}
                tabIndex={0}
                role="columnheader"
                aria-sort={getAriaSort('status')}
              >
                Status {renderSortIndicator('status')}
              </th>
              <th 
                className={`${styles.th} ${styles.sortable}`} 
                onClick={() => onSort('newsletter')}
                onKeyDown={(e) => handleKeyDown(e, 'newsletter')}
                tabIndex={0}
                role="columnheader"
                aria-sort={getAriaSort('newsletter')}
              >
                Newsletter {renderSortIndicator('newsletter')}
              </th>
              <th 
                className={`${styles.th} ${styles.sortable}`} 
                onClick={() => onSort('programs')}
                onKeyDown={(e) => handleKeyDown(e, 'programs')}
                tabIndex={0}
                role="columnheader"
                aria-sort={getAriaSort('programs')}
              >
                Courses {renderSortIndicator('programs')}
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 3 }).map((_, idx) => (
                <tr key={`skeleton-${idx}`} className={styles.trSkeleton}>
                  {isSelectable && (
                    <td className={`${styles.td} ${styles.checkboxCell}`}>
                      <span className="skeleton" style={{ width: '16px', height: '16px', display: 'block' }} />
                    </td>
                  )}
                  <td className={styles.td}>
                    <div className={styles.nameCell}>
                      <span className="skeleton" style={{ width: '120px', height: '14px', marginBottom: '6px' }} />
                      <span className="skeleton" style={{ width: '160px', height: '10px' }} />
                    </div>
                  </td>
                  <td className={styles.td}>
                    <span className="skeleton" style={{ width: '100px', height: '14px' }} />
                  </td>
                  <td className={styles.td}>
                    <span className="skeleton" style={{ width: '80px', height: '14px' }} />
                  </td>
                  <td className={styles.td}>
                    <span className="skeleton" style={{ width: '70px', height: '22px', borderRadius: 'var(--radius-full)' }} />
                  </td>
                  <td className={styles.td}>
                    <span className="skeleton" style={{ width: '75px', height: '22px', borderRadius: 'var(--radius-full)' }} />
                  </td>
                </tr>
              ))
            ) : contacts.map((contact) => {
              const status = getContactStatus(contact);
              const isRowSelected = selection.has(contact.id);
              const statusClass =
                status === 'customer'
                  ? styles.statusCustomer
                  : status === 'lead'
                    ? styles.statusLead
                    : styles.statusProspect;

              return (
              <tr 
                key={contact.id} 
                className={`${styles.tr} ${isRowSelected ? styles.trSelected : ''} ${isSelecting ? styles.trSelecting : ''}`}
                data-selected={isRowSelected ? 'true' : undefined}
                onClick={(event) => handleRowClick(event, contact)}
                onContextMenu={
                  onRowContextMenu
                    ? (event) => {
                        event.preventDefault();
                        // The keyboard's menu key reports 0,0; open beside the row instead.
                        const box = event.currentTarget.getBoundingClientRect();
                        const fromKeyboard = event.clientX === 0 && event.clientY === 0;
                        onRowContextMenu(contact, {
                          x: fromKeyboard ? box.left + 24 : event.clientX,
                          y: fromKeyboard ? box.bottom : event.clientY,
                        });
                      }
                    : undefined
                }
              >
                {isSelectable && (
                  // The whole cell ticks, not just the 16px box, and the click stops here:
                  // ticking a row must never also open it.
                  <td
                    className={`${styles.td} ${styles.checkboxCell}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (event.target === event.currentTarget) toggleRow(contact.id, !isRowSelected);
                    }}
                  >
                    <input
                      type="checkbox"
                      className={styles.checkbox}
                      data-testid={`select-contact-${contact.id}`}
                      aria-label={`Select ${contact.firstName} ${contact.lastName}`}
                      checked={isRowSelected}
                      onChange={(event) => toggleRow(contact.id, event.target.checked)}
                    />
                  </td>
                )}
                <td className={styles.td}>
                  <div className={styles.nameCell}>
                    <span className={styles.fullName}>
                      {contact.firstName} {contact.lastName}
                      {contact.preferredName ? ` (${contact.preferredName})` : ''}
                    </span>
                    <span className={styles.emailSubtext}>{contact.email}</span>
                    {contact.tags && <RowTags tags={contact.tags} />}
                  </div>
                </td>
                <td className={styles.td}>
                  {contact.organisation?.name || <span style={{ color: 'var(--text-muted)' }}>—</span>}
                </td>
                <td className={styles.td}>
                  {contact.position || <span style={{ color: 'var(--text-muted)' }}>—</span>}
                </td>
                <td className={styles.td}>
                  <span className={`${styles.statusPill} ${statusClass}`}>
                    <span className={styles.pulseDot} />
                    {status === 'customer' ? 'Customer' : status === 'lead' ? 'Lead' : 'Prospect'}
                  </span>
                </td>
                <td className={styles.td}>
                  <span className={`${styles.statusPill} ${contact.subscribedToNewsletter ? styles.statusSubscribed : styles.statusUnsubscribed}`}>
                    <span className={styles.pulseDot} />
                    {contact.subscribedToNewsletter ? 'Subscribed' : 'Unsubscribed'}
                  </span>
                </td>
                <td className={styles.td}>
                  <span className={`${styles.statusPill} ${contact.subscribedToPrograms ? styles.statusSubscribed : styles.statusUnsubscribed}`}>
                    <span className={styles.pulseDot} />
                    {contact.subscribedToPrograms ? 'Subscribed' : 'Unsubscribed'}
                  </span>
                </td>
              </tr>
              );
            })}
            {!isLoading && !loadError && contacts.length === 0 && (
              <tr>
                <td colSpan={columnCount} className={styles.td} style={{ padding: '0' }}>
                  <div className={styles.emptyStateContainer}>
                    <div className={styles.emptyIconWrapper}>
                      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <circle cx="12" cy="12" r="10" />
                        <path d="M8 12h8" />
                        <path d="M12 8v8" />
                      </svg>
                    </div>
                    <h4 className={styles.emptyTitle}>No contacts registered</h4>
                    <p className={styles.emptySubtitle}>
                      Your system directories are currently empty. Create a new profile manually or import spreadsheet records.
                    </p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
