'use client';

import React, { useRef } from 'react';
import styles from './ContactTable.module.css';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';

import { prefersReducedMotion } from '@/lib/motion';
import type { ContactStatus } from '@/lib/db/types';

type ActiveContactStatus = Exclude<ContactStatus, 'archived'>;

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
}

export default function ContactTable({
  contacts,
  onSelectContact,
  onSort,
  sortKey,
  sortDir,
  isLoading = false,
}: ContactTableProps) {
  const containerRef = useRef<HTMLDivElement>(null);

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
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 3 }).map((_, idx) => (
                <tr key={`skeleton-${idx}`} className={styles.trSkeleton}>
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
              const statusClass =
                status === 'customer'
                  ? styles.statusCustomer
                  : status === 'lead'
                    ? styles.statusLead
                    : styles.statusProspect;

              return (
              <tr 
                key={contact.id} 
                className={styles.tr} 
                onClick={() => onSelectContact(contact)}
              >
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
              </tr>
              );
            })}
            {!isLoading && contacts.length === 0 && (
              <tr>
                <td colSpan={5} className={styles.td} style={{ padding: '0' }}>
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
