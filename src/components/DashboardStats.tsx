'use client';

import React, { useRef } from 'react';
import styles from './DashboardStats.module.css';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';

interface DashboardStatsProps {
  totalContacts: number;
  customers: number;
  prospects: number;
  newsletterSubscribers: number;
}

export default function DashboardStats({
  totalContacts,
  customers,
  prospects,
  newsletterSubscribers,
}: DashboardStatsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const totalRef = useRef<HTMLSpanElement>(null);
  const customersRef = useRef<HTMLSpanElement>(null);
  const prospectsRef = useRef<HTMLSpanElement>(null);
  const newsletterRef = useRef<HTMLSpanElement>(null);

  const prevValues = useRef({
    total: 0,
    customers: 0,
    prospects: 0,
    newsletter: 0,
  });

  useGSAP(() => {
    // 1. Stagger animate the card wrappers entering on mount
    gsap.fromTo(
      `.${styles.cardShell}`,
      { opacity: 0, y: 20, scale: 0.98 },
      {
        opacity: 1,
        y: 0,
        scale: 1,
        duration: 0.5,
        stagger: 0.08,
        ease: 'power2.out',
      }
    );

    // 2. Animate the counts smoothly from previous value to new target
    const counts = [
      { ref: totalRef, target: totalContacts, start: prevValues.current.total },
      { ref: customersRef, target: customers, start: prevValues.current.customers },
      { ref: prospectsRef, target: prospects, start: prevValues.current.prospects },
      { ref: newsletterRef, target: newsletterSubscribers, start: prevValues.current.newsletter },
    ];

    counts.forEach(({ ref, target, start }) => {
      if (!ref.current) return;
      const obj = { val: start };
      gsap.to(obj, {
        val: target,
        duration: 1.2,
        ease: 'power3.out',
        onUpdate: () => {
          if (ref.current) {
            ref.current.innerText = Math.floor(obj.val).toLocaleString();
          }
        },
      });
    });

    // Store current values for the next update transition
    prevValues.current = {
      total: totalContacts,
      customers,
      prospects,
      newsletter: newsletterSubscribers,
    };
  }, { dependencies: [totalContacts, customers, prospects, newsletterSubscribers], scope: containerRef });

  // SVGs for the dashboard cards
  const icons = {
    contacts: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
    customer: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
      </svg>
    ),
    prospect: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
        <line x1="11" y1="8" x2="11" y2="14" />
        <line x1="8" y1="11" x2="14" y2="11" />
      </svg>
    ),
    newsletter: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
        <polyline points="22,6 12,13 2,6" />
      </svg>
    ),
  };

  return (
    <div ref={containerRef} className={styles.statsGrid}>
      <div className={styles.cardShell}>
        <div className={styles.cardInner}>
          <div className={styles.header}>
            <span className={styles.label}>Total Contacts</span>
            <div className={`${styles.iconWrapper} ${styles.contactsIcon}`}>{icons.contacts}</div>
          </div>
          <span ref={totalRef} className={styles.value}>{totalContacts}</span>
          <div className={styles.trend}>
            <span className={styles.trendNeutral}>Database capacity active</span>
          </div>
        </div>
      </div>

      <div className={styles.cardShell}>
        <div className={styles.cardInner}>
          <div className={styles.header}>
            <span className={styles.label}>Customers</span>
            <div className={`${styles.iconWrapper} ${styles.customerIcon}`}>{icons.customer}</div>
          </div>
          <span ref={customersRef} className={styles.value}>{customers}</span>
          <div className={styles.trend}>
            <span className={styles.trendPositive}>
              {totalContacts > 0 ? Math.round((customers / totalContacts) * 100) : 0}% conversion rate
            </span>
          </div>
        </div>
      </div>

      <div className={styles.cardShell}>
        <div className={styles.cardInner}>
          <div className={styles.header}>
            <span className={styles.label}>Prospects</span>
            <div className={`${styles.iconWrapper} ${styles.prospectIcon}`}>{icons.prospect}</div>
          </div>
          <span ref={prospectsRef} className={styles.value}>{prospects}</span>
          <div className={styles.trend}>
            <span className={styles.trendNeutral}>
              {totalContacts > 0 ? Math.round((prospects / totalContacts) * 100) : 0}% active leads
            </span>
          </div>
        </div>
      </div>

      <div className={styles.cardShell}>
        <div className={styles.cardInner}>
          <div className={styles.header}>
            <span className={styles.label}>Newsletter</span>
            <div className={`${styles.iconWrapper} ${styles.newsletterIcon}`}>{icons.newsletter}</div>
          </div>
          <span ref={newsletterRef} className={styles.value}>{newsletterSubscribers}</span>
          <div className={styles.trend}>
            <span className={styles.trendPositive}>
              {totalContacts > 0 ? Math.round((newsletterSubscribers / totalContacts) * 100) : 0}% subscriber density
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
