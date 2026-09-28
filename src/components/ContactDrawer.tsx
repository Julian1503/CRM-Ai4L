'use client';

import React, { useState, useEffect, useRef } from 'react';
import styles from './ContactDrawer.module.css';
import { TableContact } from './ContactTable';
import { validateContact } from '@/lib/contacts';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';

import { prefersReducedMotion } from '@/lib/motion';
import ConfirmDialog from '@/components/ui/ConfirmDialog';

interface ContactDrawerProps {
  contact: TableContact | null;
  onClose: () => void;
  onSave: (data: ContactFormData) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
  /**
   * Removes the contact for good from the application: a soft delete that hides it
   * everywhere, the archive included. Nothing is deleted from the database.
   */
  onRemove?: (id: string) => Promise<void>;
  availableServices: { id: string; name: string }[];
  /**
   * Job types available to assign.
   *
   * Job type is one of the contact fields the client filters and segments on, and until
   * now it could only be set by a spreadsheet import or the EmailOctopus tag-sync
   * script -- so a contact added by hand, or created by the newsletter webhook, was
   * permanently invisible to every job-type segment.
   */
  jobTypes: { id: string; name: string }[];
}

type ContactFormData = Partial<Omit<TableContact, 'organisation'>> & {
  organisationName?: string;
};

type ContactFormValue = string | boolean | string[] | undefined;

interface AddressSuggestion {
  display_name: string;
  address: {
    road?: string;
    suburb?: string;
    state?: string;
    postcode?: string;
    country?: string;
  };
}

export default function ContactDrawer({
  contact,
  onClose,
  onSave,
  onDelete,
  onRemove,
  availableServices,
  jobTypes,
}: ContactDrawerProps) {
  const [formData, setFormData] = useState<ContactFormData>({});
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const removeContact = async () => {
    const contactId = formData.id;
    if (!contactId || !onRemove) return;

    setIsRemoving(true);
    setRemoveError(null);

    try {
      await onRemove(contactId);
      setConfirmingRemove(false);
      onClose();
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : 'Could not remove this contact.');
    } finally {
      setIsRemoving(false);
    }
  };
  const scrollAreaRef = useRef<HTMLFormElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const [addressSuggestions, setAddressSuggestions] = useState<AddressSuggestion[]>([]);
  const [isSearchingAddress, setIsSearchingAddress] = useState(false);
  const [addressSearchError, setAddressSearchError] = useState('');
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const addressAbortRef = useRef<AbortController | null>(null);

  // Close suggestions on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node)) {
        setAddressSuggestions([]);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      addressAbortRef.current?.abort();
    };
  }, []);

  const searchAddress = async (query: string) => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    const trimmedQuery = query.trim();

    if (trimmedQuery.length < 3) {
      addressAbortRef.current?.abort();
      setAddressSuggestions([]);
      setAddressSearchError('');
      setIsSearchingAddress(false);
      return;
    }

    debounceTimerRef.current = setTimeout(async () => {
      addressAbortRef.current?.abort();
      const controller = new AbortController();
      addressAbortRef.current = controller;
      setIsSearchingAddress(true);
      setAddressSearchError('');

      try {
        const params = new URLSearchParams({ q: trimmedQuery });
        if (formData.country) {
          params.set('country', formData.country);
        }

        const res = await fetch(`/api/locations/autocomplete?${params.toString()}`, {
          signal: controller.signal,
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(data.error || 'Location lookup failed');
        }

        setAddressSuggestions(Array.isArray(data.suggestions) ? data.suggestions : []);
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          return;
        }
        console.error('Search address error:', err);
        setAddressSuggestions([]);
        setAddressSearchError('Location lookup unavailable');
      } finally {
        if (addressAbortRef.current === controller) {
          addressAbortRef.current = null;
          setIsSearchingAddress(false);
        }
      }
    }, 350);
  };

  const handleSelectSuggestion = (suggestion: AddressSuggestion) => {
    const addr = suggestion.address;
    setFormData((prev) => ({
      ...prev,
      address: addr.road || prev.address,
      suburb: addr.suburb || prev.suburb,
      state: addr.state || prev.state,
      postcode: addr.postcode || prev.postcode,
      country: addr.country || prev.country
    }));
    setAddressSuggestions([]);
  };

  useGSAP(() => {
    if (prefersReducedMotion()) return;
    if (!contact) return;

    // Stagger reveal of form sections and input fields when contact details load
    gsap.fromTo(
      `.${styles.sectionTitle}, .${styles.field}`,
      { opacity: 0, x: 12 },
      {
        opacity: 1,
        x: 0,
        duration: 0.35,
        stagger: 0.02,
        ease: 'power2.out',
        clearProps: 'all',
      }
    );
  }, { dependencies: [contact], scope: scrollAreaRef });

  // Sync state with selected contact
  useEffect(() => {
    if (contact) {
      // The drawer owns editable draft state derived from the selected table row.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFormData({
        id: contact.id,
        firstName: contact.firstName || '',
        lastName: contact.lastName || '',
        preferredName: contact.preferredName || '',
        email: contact.email || '',
        mobileNumber: contact.mobileNumber || '',
        workPhone: contact.workPhone || '',
        address: contact.address || '',
        suburb: contact.suburb || '',
        state: contact.state || '',
        postcode: contact.postcode || '',
        country: contact.country || 'Australia',
        organisationName: contact.organisation?.name || '',
        department: contact.department || '',
        position: contact.position || '',
        notes: contact.notes || '',
        // Must be seeded from the contact: without it an edit to any other field saves
        // jobTypeId as undefined and silently clears a classification the tag-sync
        // script had already assigned.
        jobTypeId: contact.jobTypeId || '',
        status: contact.status ?? (contact.isCustomer ? 'customer' : 'prospect'),
        isCustomer: contact.status
          ? contact.status === 'customer'
          : (contact.isCustomer ?? false),
        servicesBought: contact.servicesBought || [],
        subscribedToNewsletter: contact.subscribedToNewsletter ?? false,
        subscribedToPrograms: contact.subscribedToPrograms ?? false,
      });
      setValidationErrors({});
      setSaveError(null);
    }
  }, [contact]);

  useEffect(() => {
    if (!contact) return;

    const previousFocus = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (!isSubmitting) onClose();
        return;
      }

      if (event.key !== 'Tab') return;
      const focusable = drawerRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]'
      );
      if (!focusable || focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus?.();
    };
  }, [contact, isSubmitting, onClose]);

  if (!contact) return <div className={styles.overlay} />;

  const handleInputChange = (field: keyof ContactFormData, value: ContactFormValue) => {
    setFormData((prev) => {
      const updated = { ...prev, [field]: value };
      
      if (field === 'status') {
        updated.isCustomer = value === 'customer';
      }

      // Services are only meaningful for converted customers.
      if (field === 'status' && value !== 'customer') {
        updated.servicesBought = [];
      }
      
      return updated;
    });
    
    // Clear validation error when editing
    if (validationErrors[field]) {
      setValidationErrors((prev) => {
        const copy = { ...prev };
        delete copy[field];
        return copy;
      });
    }
  };

  const handleServiceToggle = (serviceId: string) => {
    setFormData((prev) => {
      const currentServices = prev.servicesBought || [];
      const updatedServices = currentServices.includes(serviceId)
        ? currentServices.filter((id: string) => id !== serviceId)
        : [...currentServices, serviceId];
      return { ...prev, servicesBought: updatedServices };
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Validate fields
    const validation = validateContact(formData);
    if (!validation.isValid) {
      setValidationErrors(validation.errors || {});
      return;
    }

    try {
      setIsSubmitting(true);
      setSaveError(null);
      await onSave(formData);
      onClose();
    } catch (err) {
      console.error('Failed to save contact:', err);
      setSaveError(err instanceof Error ? err.message : 'Could not save this contact. Try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <div 
        className={`${styles.overlay} ${contact ? styles.overlayActive : ''}`} 
        onClick={() => {
          if (!isSubmitting) onClose();
        }}
      />
      <div
        ref={drawerRef}
        className={`${styles.drawer} ${contact ? styles.drawerActive : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="contact-drawer-title"
      >
        <div className={styles.header}>
          <h2 id="contact-drawer-title" className={styles.title}>
            {formData.id ? 'Edit Contact' : 'New Contact'}
          </h2>
          <button ref={closeButtonRef} type="button" className={styles.closeButton} onClick={onClose} disabled={isSubmitting} aria-label="Close contact editor">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <form ref={scrollAreaRef} onSubmit={handleSubmit} className={styles.scrollArea}>
          {saveError && (
            <div className={styles.saveError} role="alert">
              {saveError}
            </div>
          )}
          {/* Section 1: Basic Information */}
          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>Basic Info</h3>
            <div className={styles.grid2}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="contact-first-name">First Name</label>
                <input id="contact-first-name"
                  type="text"
                  className={styles.input}
                  value={formData.firstName || ''}
                  onChange={(e) => handleInputChange('firstName', e.target.value)}
                />
                {validationErrors.firstName && (
                  <span style={{ color: 'var(--danger)', fontSize: '0.75rem' }}>{validationErrors.firstName}</span>
                )}
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="contact-last-name">Last Name</label>
                <input id="contact-last-name"
                  type="text"
                  className={styles.input}
                  value={formData.lastName || ''}
                  onChange={(e) => handleInputChange('lastName', e.target.value)}
                />
                {validationErrors.lastName && (
                  <span style={{ color: 'var(--danger)', fontSize: '0.75rem' }}>{validationErrors.lastName}</span>
                )}
              </div>
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="contact-preferred-name">Preferred Name</label>
              <input id="contact-preferred-name"
                type="text"
                className={styles.input}
                value={formData.preferredName || ''}
                onChange={(e) => handleInputChange('preferredName', e.target.value)}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="contact-email-address">Email Address</label>
              <input id="contact-email-address"
                type="email"
                className={styles.input}
                value={formData.email || ''}
                onChange={(e) => handleInputChange('email', e.target.value)}
              />
              {validationErrors.email && (
                <span style={{ color: 'var(--danger)', fontSize: '0.75rem' }}>{validationErrors.email}</span>
              )}
            </div>

            <div className={styles.grid2}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="contact-mobile-number">Mobile Number</label>
                <input id="contact-mobile-number"
                  type="text"
                  className={styles.input}
                  value={formData.mobileNumber || ''}
                  onChange={(e) => handleInputChange('mobileNumber', e.target.value)}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="contact-work-phone">Work Phone</label>
                <input id="contact-work-phone"
                  type="text"
                  className={styles.input}
                  value={formData.workPhone || ''}
                  onChange={(e) => handleInputChange('workPhone', e.target.value)}
                />
              </div>
            </div>
          </div>

          {/* Section 2: Organisation */}
          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>Organisation</h3>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="contact-organisation-name">Organisation Name</label>
              <input id="contact-organisation-name"
                type="text"
                className={styles.input}
                value={formData.organisationName || ''}
                onChange={(e) => handleInputChange('organisationName', e.target.value)}
              />
            </div>
            <div className={styles.grid2}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="contact-department">Department</label>
                <input id="contact-department"
                  type="text"
                  className={styles.input}
                  value={formData.department || ''}
                  onChange={(e) => handleInputChange('department', e.target.value)}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="contact-position-title">Position / Title</label>
                <input id="contact-position-title"
                  type="text"
                  className={styles.input}
                  value={formData.position || ''}
                  onChange={(e) => handleInputChange('position', e.target.value)}
                />
              </div>
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="contact-job-type">Job Type</label>
              <select id="contact-job-type"
                className={styles.input}
                value={formData.jobTypeId || ''}
                onChange={(e) => handleInputChange('jobTypeId', e.target.value)}
                data-testid="contact-job-type"
              >
                <option value="">Not set</option>
                {jobTypes.map((jobType) => (
                  <option key={jobType.id} value={jobType.id}>
                    {jobType.name}
                  </option>
                ))}
              </select>
              <span className={styles.hint}>
                Drives the job-type filter and every segment built on it.
              </span>
            </div>
          </div>

          {/* Section 3: Address */}
          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>Location</h3>
            <div className={styles.field} style={{ position: 'relative' }} ref={suggestionsRef}>
              <label className={styles.label} htmlFor="contact-address">Address</label>
              <input id="contact-address"
                type="text"
                className={styles.input}
                value={formData.address || ''}
                onChange={(e) => {
                  handleInputChange('address', e.target.value);
                  searchAddress(e.target.value);
                }}
                placeholder="Start typing street address..."
              />
              
              {isSearchingAddress && (
                <div className={styles.searchingIndicator}>Searching...</div>
              )}

              {!isSearchingAddress && addressSearchError && (
                <div className={styles.searchingIndicator}>{addressSearchError}</div>
              )}

              {addressSuggestions.length > 0 && (
                <ul className={styles.suggestionsList}>
                  {addressSuggestions.map((suggestion, idx) => (
                    <li 
                      key={idx} 
                      className={styles.suggestionItem}
                      onClick={() => handleSelectSuggestion(suggestion)}
                    >
                      {suggestion.display_name}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            
            <div className={styles.grid2}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="contact-suburb">Suburb</label>
                <input id="contact-suburb"
                  type="text"
                  className={styles.input}
                  value={formData.suburb || ''}
                  onChange={(e) => handleInputChange('suburb', e.target.value)}
                />
              </div>
              <div className={styles.field} style={{ position: 'relative' }}>
                <label className={styles.label} htmlFor="contact-state">State</label>
                {(formData.country || 'Australia').toLowerCase() === 'australia' ? (
                  <>
                    <input id="contact-state"
                      type="text"
                      className={styles.input}
                      value={formData.state || ''}
                      onChange={(e) => handleInputChange('state', e.target.value)}
                      placeholder="Type or select state..."
                    />
                  </>
                ) : (
                  <input
                    type="text"
                    className={styles.input}
                    value={formData.state || ''}
                    onChange={(e) => handleInputChange('state', e.target.value)}
                    placeholder="State / Region"
                  />
                )}
              </div>
            </div>
            
            <div className={styles.grid2}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="contact-postcode">Postcode</label>
                <input id="contact-postcode"
                  type="text"
                  className={styles.input}
                  value={formData.postcode || ''}
                  onChange={(e) => handleInputChange('postcode', e.target.value)}
                />
              </div>
              <div className={styles.field} style={{ position: 'relative' }} >
                <label className={styles.label} htmlFor="contact-country">Country</label>
                <input id="contact-country"
                  type="text"
                  className={styles.input}
                  value={formData.country || ''}
                  onChange={(e) => handleInputChange('country', e.target.value)}
                  placeholder="Type or select country..."
                />
              </div>
            </div>
          </div>

          {/* Section 4: CRM Details & Integration */}
          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>Status & Sync</h3>
            
            <div className={styles.field}>
              <label className={styles.label} htmlFor="contact-status">Client Status</label>
              <select
                id="contact-status"
                className={styles.input}
                value={formData.status || 'prospect'}
                onChange={(e) => handleInputChange('status', e.target.value)}
              >
                <option value="lead">Lead</option>
                <option value="prospect">Prospect</option>
                <option value="customer">Customer</option>
              </select>
              <span className={styles.hint}>
                Drives client-status filters and marketing segments.
              </span>
            </div>

            {formData.status === 'customer' && (
              <fieldset className={styles.field} style={{ marginTop: '14px' }}>
                <legend className={styles.label}>Services Bought</legend>
                <div className={styles.servicesGrid}>
                  {availableServices.map((service) => (
                    <label key={service.id} className={styles.serviceItem}>
                      <input
                        type="checkbox"
                        className={styles.checkbox}
                        checked={(formData.servicesBought || []).includes(service.id)}
                        onChange={() => handleServiceToggle(service.id)}
                      />
                      <span>{service.name}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            <label className={styles.checkboxContainer}>
              <input
                type="checkbox"
                className={styles.checkbox}
                checked={formData.subscribedToNewsletter || false}
                onChange={(e) =>
                  handleInputChange('subscribedToNewsletter', e.target.checked)
                }
              />
              <span className={styles.label}>Subscribed to Newsletter (Sync to EmailOctopus)</span>
            </label>

            <label className={styles.checkboxContainer}>
              <input
                type="checkbox"
                className={styles.checkbox}
                checked={formData.subscribedToPrograms || false}
                onChange={(e) =>
                  handleInputChange('subscribedToPrograms', e.target.checked)
                }
              />
              <span className={styles.label}>Subscribed to Courses &amp; training</span>
            </label>

            {!formData.subscribedToNewsletter && !formData.subscribedToPrograms && (
              // Saying so here is the whole reason this note exists: the archive is a
              // database rule, and without a warning the contact simply disappears from
              // the list on save with nothing on screen explaining why.
              <span className={styles.hint} role="status">
                With neither consent, saving moves this contact to the archive. Granting
                either one back brings them out again.
              </span>
            )}
          </div>

          {/* Section 5: Notes */}
          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>Notes</h3>
            <div className={styles.field}>
              <textarea
                className={styles.textarea}
                value={formData.notes || ''}
                placeholder="Write any special notes here..."
                onChange={(e) => handleInputChange('notes', e.target.value)}
              />
            </div>
          </div>
        </form>

        <div className={styles.footer}>
          {formData.id && onDelete && (
            <button
              type="button"
              className={`${styles.button} ${styles.deleteBtn}`}
              onClick={() => {
                const contactId = formData.id;
                if (
                  contactId &&
                  window.confirm(
                    'Archive this contact? The record is kept and can be restored later.'
                  )
                ) {
                  onDelete(contactId);
                  onClose();
                }
              }}
            >
              Archive
            </button>
          )}
          {formData.id && onRemove && (
            <button
              type="button"
              className={`${styles.button} ${styles.removeBtn}`}
              onClick={() => {
                setRemoveError(null);
                setConfirmingRemove(true);
              }}
              data-testid="remove-contact"
            >
              Remove
            </button>
          )}
          <button 
            type="button" 
            className={`${styles.button} ${styles.cancelBtn}`} 
            onClick={onClose}
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button 
            type="submit" 
            className={`${styles.button} ${styles.saveBtn}`}
            disabled={isSubmitting}
            onClick={handleSubmit}
          >
            {isSubmitting ? 'Saving...' : 'Save Contact'}
          </button>
        </div>
      </div>

      {confirmingRemove && (
        <ConfirmDialog
          title="Remove this contact?"
          subject={[formData.firstName, formData.lastName].filter(Boolean).join(' ') || formData.email}
          confirmLabel="Remove contact"
          busyLabel="Removing…"
          busy={isRemoving}
          error={removeError}
          onConfirm={() => void removeContact()}
          onClose={() => setConfirmingRemove(false)}
        >
          <p>
            They disappear from every list, segment and the archive, and cannot be brought
            back from here.
          </p>
          <p>
            Nothing is deleted: past sends, bookings and consent history stay on record. If the
            same address is imported later it starts a new contact, never with more consent than
            this one had.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
