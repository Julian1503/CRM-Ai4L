'use client';

import React, { useState, useRef, useEffect } from 'react';
import styles from './Sidebar.module.css';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';

export type ActiveView = 'contacts' | 'archive' | 'campaigns' | 'imports' | 'integrations' | 'settings';

interface SidebarProps {
  currentView: ActiveView;
  onViewChange: (view: ActiveView) => void;
}

export default function Sidebar({ currentView, onViewChange }: SidebarProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const logoSuffixRef = useRef<HTMLSpanElement>(null);
  const tlRef = useRef<gsap.core.Timeline | null>(null);

  const navItems = [
    {
      id: 'contacts' as ActiveView,
      label: 'Contacts',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      ),
    },
    {
      id: 'archive' as ActiveView,
      label: 'Archive',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 8v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8" />
          <rect x="1" y="3" width="22" height="5" rx="1" />
          <line x1="10" y1="12" x2="14" y2="12" />
        </svg>
      ),
    },
    {
      id: 'campaigns' as ActiveView,
      label: 'Campaigns',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 4h16v12H5.17L4 17.17V4z" />
          <line x1="8" y1="9" x2="16" y2="9" />
          <line x1="8" y1="13" x2="13" y2="13" />
        </svg>
      ),
    },
    {
      id: 'imports' as ActiveView,
      label: 'Excel Import',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
      ),
    },
    {
      id: 'integrations' as ActiveView,
      label: 'EmailOctopus',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22.54 6.42a2.78 2.78 0 0 0-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 0 0-1.94 2A29 29 0 0 0 1 11.75a29 29 0 0 0 .46 5.33A2.78 2.78 0 0 0 3.4 19c1.72.46 8.6.46 8.6.46s6.88 0 8.6-.46a2.78 2.78 0 0 0 1.94-2 29 29 0 0 0 .46-5.25 29 29 0 0 0-.46-5.33z" />
          <polygon points="9.75 15.02 15.5 11.75 9.75 8.48 9.75 15.02" />
        </svg>
      ),
    },
    {
      id: 'settings' as ActiveView,
      label: 'Settings',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      ),
    },
  ];

  useGSAP(() => {
    if (!containerRef.current) return;

    // 1. Create a single master timeline for expand/collapse transitions
    const tl = gsap.timeline({ paused: true });
    tlRef.current = tl;

    // Detect prefers-reduced-motion settings safely
    const prefersReducedMotion = typeof window !== 'undefined' && 
      window.matchMedia && 
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    
    // Smooth, confident transition values
    const totalDuration = prefersReducedMotion ? 0.05 : 0.65;
    const coreEase = prefersReducedMotion ? 'none' : 'expo.inOut';
    const staggerTime = prefersReducedMotion ? 0 : 0.035;

    // Construct the timeline tweens to transition from Expanded to Collapsed state
    tl.to(containerRef.current, {
      width: 78,
      paddingLeft: 12,
      paddingRight: 12,
      duration: totalDuration,
      ease: coreEase,
    }, 0)
    .to(`.${styles.brand}`, {
      marginTop: 48,
      paddingLeft: 4.5, // Centers logo title "Ai4L." inside collapsed layout space
      paddingRight: 0,
      duration: totalDuration,
      ease: coreEase,
    }, 0)
    .to(`.${styles.toggleBtn}`, {
      top: 20,
      right: 25, // Centers absolute toggle button inside collapsed width: (78 - 28)/2 = 25px
      duration: totalDuration,
      ease: coreEase,
    }, 0)
    .to('.toggleIcon', {
      rotate: 180,
      duration: totalDuration,
      ease: prefersReducedMotion ? 'none' : 'power3.out',
    }, 0)
    .to(logoSuffixRef.current, {
      width: 0,
      opacity: 0,
      duration: totalDuration * 0.7,
      ease: coreEase,
    }, 0)
    .to(`.${styles.logoLetter}`, {
      opacity: 0,
      y: -6,
      stagger: staggerTime,
      duration: totalDuration * 0.5,
      ease: coreEase,
    }, 0)
    .to(`.${styles.navItem}`, {
      paddingLeft: 18, // Centers the 18px wide icons inside 54px content area
      paddingRight: 18,
      gap: 0,
      duration: totalDuration,
      ease: coreEase,
    }, 0)
    .to(`.${styles.desktopLabel}`, {
      opacity: 0,
      width: 0,
      marginRight: 0,
      duration: totalDuration * 0.7,
      ease: coreEase,
    }, 0)
    .to(`.${styles.footer}`, {
      paddingLeft: 8, // Centers 38px avatar inside 54px content area: (54px - 38px)/2 = 8px
      gap: 0,
      duration: totalDuration,
      ease: coreEase,
    }, 0)
    .to(`.${styles.userInfo}`, {
      opacity: 0,
      width: 0,
      duration: totalDuration * 0.7,
      ease: coreEase,
    }, 0);

    // Initial sync based on starting state
    if (isCollapsed) {
      tl.progress(1);
    }

    return () => {
      tl.kill();
    };
  }, { scope: containerRef, dependencies: [] });

  // Play forward on collapse, reverse on expand
  useEffect(() => {
    const isDesktop = typeof window !== 'undefined' && window.innerWidth > 768;
    if (!isDesktop) return;

    if (tlRef.current) {
      if (isCollapsed) {
        tlRef.current.play();
      } else {
        tlRef.current.reverse();
      }
    }
  }, [isCollapsed]);

  // Handle window resizing safely (Clear inline styles on mobile viewports)
  useEffect(() => {
    const handleResize = () => {
      const isDesktop = typeof window !== 'undefined' && window.innerWidth > 768;
      if (!isDesktop && tlRef.current) {
        gsap.set([
          containerRef.current,
          logoSuffixRef.current,
          `.${styles.brand}`,
          `.${styles.toggleBtn}`,
          '.toggleIcon',
          `.${styles.logoLetter}`,
          `.${styles.navItem}`,
          `.${styles.desktopLabel}`,
          `.${styles.activeDot}`,
          `.${styles.footer}`,
          `.${styles.userInfo}`
        ], { clearProps: 'all' });
        tlRef.current.pause(0);
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', handleResize);
      handleResize();
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', handleResize);
      }
    };
  }, []);

  const handleToggle = () => {
    // Prevent double-click spam during active transition
    if (tlRef.current && tlRef.current.isActive()) return;
    setIsCollapsed((prev) => !prev);
  };

  return (
    <aside ref={containerRef} className={`${styles.sidebar} ${isCollapsed ? styles.collapsed : ''}`}>
      <button 
        className={styles.toggleBtn} 
        onClick={handleToggle}
        aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        type="button"
      >
        <svg className="toggleIcon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>

      <div>
        <div className={styles.brand}>
          <span className={styles.title}>
            <span>Ai4L</span>
            <span ref={logoSuffixRef} className={styles.logoSuffix}>
              <span className={styles.logoLetter}>C</span>
              <span className={styles.logoLetter}>R</span>
              <span className={styles.logoLetter}>M</span>
            </span>
            <span className={styles.dot}>.</span>
          </span>
        </div>
        <nav className={styles.nav}>
          {navItems.map((item) => (
            <button
              key={item.id}
              data-testid={`nav-item-${item.id}`}
              className={`${styles.navItem} ${currentView === item.id ? styles.activeItem : ''}`}
              onClick={() => onViewChange(item.id)}
              type="button"
            >
              <div className={styles.iconContainer}>
                {item.icon}
              </div>
              <span className={styles.desktopLabel}>{item.label}</span>
              <span className={styles.mobileLabel}>
                {item.id === 'imports' ? 'Import' : item.id === 'integrations' ? 'Sync' : item.id === 'campaigns' ? 'Send' : item.label}
              </span>
              {currentView === item.id && <span className={styles.activeDot} />}
            </button>
          ))}
        </nav>
      </div>

      <div className={styles.footer}>
        <div className={styles.avatar}>A</div>
        <div className={styles.userInfo}>
          <span className={styles.userName}>Administrator</span>
          <span className={styles.userRole}>Super User</span>
        </div>
        {/* Plain form post rather than a fetch, so sign-out still works if the
            client bundle fails to load. POST because a GET logout is CSRF-able. */}
        <form method="post" action="/auth/logout" className={styles.signOutForm}>
          <button type="submit" className={styles.signOutBtn} data-testid="sign-out" title="Sign out">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            <span className={styles.srOnly}>Sign out</span>
          </button>
        </form>
      </div>
    </aside>
  );
}
