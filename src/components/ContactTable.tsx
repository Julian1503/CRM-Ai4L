'use client';

import React, { useRef } from 'react';
import styles from './ContactTable.module.css';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';

import { prefersReducedMotion } from '@/lib/motion';
import type { ContactStatus } from '@/lib/db/types';

type ActiveContactStatus = Exclude<ContactStatus, 'archived'>;

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
}: ContactTableProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);

  const isSelectable = typeof onToggleRow === 'function';
  const selection = selectedIds ?? EMPTY_SELECTION;
  const pageIds = contacts.map((contact) => contact.id);
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
                className={`${styles.tr} ${isRowSelected ? styles.trSelected : ''}`}
                data-selected={isRowSelected ? 'true' : undefined}
                onClick={() => onSelectContact(contact)}
              >
                {isSelectable && (
                  // Stops at the cell: ticking a row is a different intent from opening
                  // it, and the row's own click handler opens the drawer.
                  <td
                    className={`${styles.td} ${styles.checkboxCell}`}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      className={styles.checkbox}
                      data-testid={`select-contact-${contact.id}`}
                      aria-label={`Select ${contact.firstName} ${contact.lastName}`}
                      checked={isRowSelected}
                      onChange={(event) => onToggleRow?.(contact.id, event.target.checked)}
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
            {!isLoading && contacts.length === 0 && (
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
