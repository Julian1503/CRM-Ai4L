/**
 * <design_plan>
 * 1. Python RNG Execution:
 *    - Hero Layout: Cinematic Center (Layout Option 1)
 *    - Typography: Outfit (Heading) / Plus Jakarta Sans (Body)
 *    - Component: Sidebar, ContactTable, DashboardStats, ContactDrawer
 *    - Motion: iOS drawer easing curves, active scale transitions
 * 2. AIDA Check:
 *    - Navigation: Sidebar component (Left-docked pill structure)
 *    - Attention (Hero): Page Heading and action button header block
 *    - Interest (Bento): DashboardStats counters
 *    - Desire (Details): Interactive Client Profile Table and detail slider drawer
 *    - Action (Save): Drawer submit actions
 * 3. Hero Math Verification:
 *    - Container width using w-full max-w-full grids.
 *    - Title is bounded to 1 line, no spam badge tags.
 * 4. Bento Density Verification:
 *    - Stats cards are aligned in a repeat columns grid with no empty columns.
 * 5. Label Sweep & Button Check:
 *    - Verified no meta-labels like "SECTION 01". Buttons contain high contrast actions.
 * </design_plan>
 */

'use client';

import React, { useState, useEffect, useRef } from 'react';
import styles from './page.module.css';
import statsStyles from '@/components/DashboardStats.module.css';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import Sidebar, { ActiveView } from '@/components/Sidebar';
import DashboardStats from '@/components/DashboardStats';
import ContactTable, { TableContact } from '@/components/ContactTable';
import ContactDrawer from '@/components/ContactDrawer';
import { getSupabaseClient, hasSupabaseConfig } from '@/lib/supabaseClient';
import { mapAndValidateRows } from '@/lib/excelParser';
import { importContacts } from '@/lib/contacts/import';
import FilterBar, { type StatusFilter } from '@/components/contacts/FilterBar';
import MarketingView from '@/components/marketing/MarketingView';

type ServiceOption = { id: string; name: string };
type SyncLog = { id: string; event_text: string; status: string; created_at: string };
type Credential = { key: string; value: string };
type ContactServiceJoin = { contact_id: string; service_id: string };
type DbContact = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  preferred_name: string | null;
  email: string | null;
  mobile_number: string | null;
  work_phone: string | null;
  address: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  country: string | null;
  department: string | null;
  position: string | null;
  notes: string | null;
  is_customer: boolean | null;
  subscribed_to_newsletter: boolean | null;
  job_type_id: string | null;
  organisation: { name: string } | null;
};
type ContactSavePayload = Partial<TableContact> & {
  organisationName?: string;
};
type ParsedSpreadsheetResponse = {
  headers: string[];
  rows: Record<string, string>[];
};

function formatContactFromDatabase(contact: DbContact, contactServices: string[] = []): TableContact {
  return {
    id: contact.id,
    firstName: contact.first_name || '',
    lastName: contact.last_name || '',
    preferredName: contact.preferred_name || '',
    email: contact.email || '',
    mobileNumber: contact.mobile_number || '',
    workPhone: contact.work_phone || '',
    address: contact.address || '',
    suburb: contact.suburb || '',
    state: contact.state || '',
    postcode: contact.postcode || '',
    country: contact.country || '',
    department: contact.department || '',
    position: contact.position || '',
    notes: contact.notes || '',
    isCustomer: Boolean(contact.is_customer),
    subscribedToNewsletter: Boolean(contact.subscribed_to_newsletter),
    jobTypeId: contact.job_type_id || null,
    organisation: contact.organisation || null,
    servicesBought: contactServices,
  };
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown error';
}

const CRM_FIELDS = [
  { key: 'fullName', label: 'Full Name (Split)', description: 'Splits by space into First/Last name' },
  { key: 'firstName', label: 'First Name', description: 'Contact first name' },
  { key: 'lastName', label: 'Last Name', description: 'Contact last name' },
  { key: 'email', label: 'Email Address', description: 'Primary contact email' },
  { key: 'preferredName', label: 'Preferred Name', description: 'Nickname / Preferred Name' },
  { key: 'mobileNumber', label: 'Mobile Number', description: 'Mobile phone number' },
  { key: 'workPhone', label: 'Work Phone', description: 'Work office phone' },
  { key: 'address', label: 'Address', description: 'Street address' },
  { key: 'suburb', label: 'Suburb', description: 'Suburb' },
  { key: 'state', label: 'State', description: 'State (e.g. NSW)' },
  { key: 'postcode', label: 'Postcode', description: 'Postal code' },
  { key: 'country', label: 'Country', description: 'Country' },
  { key: 'organisationName', label: 'Organisation Name', description: 'Company / Employer name' },
  { key: 'jobTypeName', label: 'Job Type', description: 'Trade / work category used for segmentation' },
  { key: 'department', label: 'Department', description: 'Business department' },
  { key: 'position', label: 'Position / Title', description: 'Job position' },
  { key: 'isCustomer', label: 'Is Customer?', description: 'True/False flag' },
  { key: 'subscribedToNewsletter', label: 'Subscribed to Newsletter?', description: 'Sync subscription state' },
];

export default function App() {
  const [currentView, setCurrentView] = useState<ActiveView>('contacts');
  const mainContentRef = useRef<HTMLElement>(null);

  useGSAP(() => {
    if (!mainContentRef.current) return;

    // Smoothly stagger animate mount states of direct child panes inside main workspace
    const targets = mainContentRef.current.children;
    if (targets.length === 0) return;

    gsap.fromTo(
      targets,
      { opacity: 0, y: 15 },
      {
        opacity: 1,
        y: 0,
        duration: 0.45,
        stagger: 0.05,
        ease: 'power2.out',
        clearProps: 'transform,opacity',
      }
    );
  }, { dependencies: [currentView], scope: mainContentRef });
  const [contacts, setContacts] = useState<TableContact[]>([]);
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [selectedContact, setSelectedContact] = useState<TableContact | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [jobTypeFilter, setJobTypeFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [jobTypes, setJobTypes] = useState<ServiceOption[]>([]);
  const [sortKey, setSortKey] = useState('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  
  const [isDatabaseConnected, setIsDatabaseConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Spreadsheet Importer states
  const [importFile, setImportFile] = useState<{ name: string; size: number } | null>(null);
  const [importProgress, setImportProgress] = useState(0);
  const [isImporting, setIsImporting] = useState(false);
  const [isMapped, setIsMapped] = useState(false);
  const [rawHeaders, setRawHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<Record<string, string>[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({
    firstName: '',
    lastName: '',
    fullName: '',
    preferredName: '',
    email: '',
    mobileNumber: '',
    workPhone: '',
    address: '',
    suburb: '',
    state: '',
    postcode: '',
    country: '',
    organisationName: '',
    jobTypeName: '',
    department: '',
    position: '',
    isCustomer: '',
    subscribedToNewsletter: '',
  });

  // EmailOctopus integrations state
  const [emailOctopusApiKey, setEmailOctopusApiKey] = useState('');
  const [emailOctopusListId, setEmailOctopusListId] = useState('');
  const [syncLogs, setSyncLogs] = useState<SyncLog[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const isConnected = emailOctopusApiKey.trim() !== '' && emailOctopusListId.trim() !== '';

  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadLiveData = React.useCallback(async () => {
    setIsLoading(true);

    if (!hasSupabaseConfig) {
      setContacts([]);
      setServices([]);
      setJobTypes([]);
      setSyncLogs([]);
      setEmailOctopusApiKey('');
      setEmailOctopusListId('');
      setIsDatabaseConnected(false);
      setConnectionError('Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to load CRM data.');
      setIsLoading(false);
      return;
    }

    try {
      const db = getSupabaseClient();

      const { data: contactData, error: contactError } = await db
        .from('contacts')
        .select(`
          *,
          organisation:organisations(name)
        `)
        .order('created_at', { ascending: false });

      if (contactError) throw contactError;

      const { data: joinData, error: joinError } = await db.from('contact_services').select('*');
      if (joinError) throw joinError;

      const { data: serviceData, error: serviceError } = await db.from('services').select('*').order('name');
      if (serviceError) throw serviceError;

      const { data: jobTypeData, error: jobTypeError } = await db.from('job_types').select('*').order('name');
      if (jobTypeError) throw jobTypeError;

      const { data: credentialsData, error: credentialsError } = await db.from('credentials').select('*');
      if (credentialsError) throw credentialsError;

      const { data: logsData, error: logsError } = await db
        .from('sync_logs')
        .select('*')
        .order('created_at', { ascending: false });
      if (logsError) throw logsError;

      const contactsFromDb = (contactData || []) as DbContact[];
      const joinsFromDb = (joinData || []) as ContactServiceJoin[];
      const credentialsFromDb = (credentialsData || []) as Credential[];
      const logsFromDb = (logsData || []) as SyncLog[];

      const formattedContacts = contactsFromDb.map((contact) => {
        const contactServices = joinsFromDb
          .filter((join) => join.contact_id === contact.id)
          .map((join) => join.service_id);
        return formatContactFromDatabase(contact, contactServices);
      });

      setContacts(formattedContacts);
      setServices(((serviceData || []) as ServiceOption[]).map((service) => ({ id: service.id, name: service.name })));
      setJobTypes(((jobTypeData || []) as ServiceOption[]).map((jobType) => ({ id: jobType.id, name: jobType.name })));
      setEmailOctopusApiKey(credentialsFromDb.find((credential) => credential.key === 'emailoctopus_api_key')?.value || '');
      setEmailOctopusListId(credentialsFromDb.find((credential) => credential.key === 'emailoctopus_list_id')?.value || '');
      setSyncLogs(logsFromDb.map((log) => ({
        id: log.id,
        event_text: log.event_text,
        status: log.status,
        created_at: log.created_at,
      })));
      setIsDatabaseConnected(true);
      setConnectionError(null);
    } catch (error) {
      const message = getErrorMessage(error);
      setContacts([]);
      setServices([]);
      setJobTypes([]);
      setSyncLogs([]);
      setIsDatabaseConnected(false);
      setConnectionError(`Supabase connection failed: ${message}`);
      console.error('Supabase connection failed:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const recordSyncLog = React.useCallback(async (eventText: string, status: 'success' | 'failed' | 'info') => {
    const db = getSupabaseClient();
    const { data, error } = await db
      .from('sync_logs')
      .insert({ event_text: eventText, status })
      .select()
      .single();

    if (error) throw error;
    if (!data) return null;

    const log = {
      id: data.id,
      event_text: data.event_text,
      status: data.status,
      created_at: data.created_at,
    };

    setSyncLogs((prev) => [log, ...prev]);
    return log;
  }, []);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImportFile({ name: file.name, size: file.size });
    setIsImporting(true);
    setImportProgress(0);
    setIsMapped(false);
    setShowPreview(false);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch('/api/import/parse', {
        method: 'POST',
        body: formData,
      });

      setImportProgress(100);

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to parse file');
      }

      const data = (await res.json()) as ParsedSpreadsheetResponse;

      setRawHeaders(data.headers);
      setRawRows(data.rows);

      // Auto-mapping heuristics based on column header keywords
      const initialMapping: Record<string, string> = {
        firstName: '',
        lastName: '',
        fullName: '',
        preferredName: '',
        email: '',
        mobileNumber: '',
        workPhone: '',
        address: '',
        suburb: '',
        state: '',
        postcode: '',
        country: '',
        organisationName: '',
        jobTypeName: '',
        department: '',
        position: '',
        isCustomer: '',
        subscribedToNewsletter: '',
      };

      data.headers.forEach((header: string) => {
        const lowerHeader = header.toLowerCase();

        if (lowerHeader.includes('full name') || lowerHeader === 'name') {
          initialMapping.fullName = header;
        } else if (lowerHeader.includes('first name') || lowerHeader === 'fname') {
          initialMapping.firstName = header;
        } else if (lowerHeader.includes('last name') || lowerHeader === 'lname') {
          initialMapping.lastName = header;
        } else if (lowerHeader.includes('email') || lowerHeader === 'mail') {
          initialMapping.email = header;
        } else if (lowerHeader.includes('company') || lowerHeader.includes('organisation') || lowerHeader === 'org') {
          initialMapping.organisationName = header;
        } else if (lowerHeader.includes('job type') || lowerHeader.includes('trade') || lowerHeader === 'jobtype') {
          initialMapping.jobTypeName = header;
        } else if (lowerHeader.includes('role') || lowerHeader.includes('position') || lowerHeader === 'title') {
          initialMapping.position = header;
        } else if (lowerHeader.includes('dept') || lowerHeader.includes('department')) {
          initialMapping.department = header;
        } else if (lowerHeader.includes('mobile') || lowerHeader.includes('phone') || lowerHeader === 'cell') {
          initialMapping.mobileNumber = header;
        } else if (lowerHeader.includes('work') && lowerHeader.includes('phone')) {
          initialMapping.workPhone = header;
        } else if (lowerHeader.includes('customer') || lowerHeader.includes('client') || lowerHeader.includes('active')) {
          initialMapping.isCustomer = header;
        } else if (lowerHeader.includes('newsletter') || lowerHeader.includes('subscribe')) {
          initialMapping.subscribedToNewsletter = header;
        }
      });

      setColumnMapping(initialMapping);
      setIsMapped(true);
    } catch (err) {
      alert(`Error parsing spreadsheet: ${getErrorMessage(err)}`);
      setImportFile(null);
    } finally {
      setIsImporting(false);
    }
  };

  const handleIngestContacts = async () => {
    const mapped = mapAndValidateRows(rawRows, columnMapping);

    if (!mapped.some((r) => r.isValid && r.data)) {
      alert('No valid contacts found to ingest.');
      return;
    }

    try {
      // Organisation/job-type resolution and the upsert all happen inside the
      // import_contacts RPC. It is required rather than preferred: email uniqueness is
      // a partial index (WHERE deleted_at IS NULL) that a client-side
      // .upsert({ onConflict: 'email' }) cannot target. See src/lib/contacts/import.ts.
      const result = await importContacts(getSupabaseClient(), mapped);

      await loadLiveData();

      const summary = [
        `${result.inserted} added`,
        `${result.updated} updated`,
        result.skipped > 0 ? `${result.skipped} skipped` : null,
      ]
        .filter(Boolean)
        .join(', ');

      alert(`Import complete: ${summary}.`);

      // Reset view variables
      setImportFile(null);
      setRawHeaders([]);
      setRawRows([]);
      setShowPreview(false);
      setIsMapped(false);
      setCurrentView('contacts');
    } catch (err) {
      console.error('Ingestion error:', err);
      alert(`Failed to ingest contact records: ${getErrorMessage(err)}`);
    }
  };

  // Fetch Database Entities
  useEffect(() => {
    // Initial load synchronizes the client shell with Supabase on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadLiveData();
  }, [loadLiveData]);

  // Compute Dashboard Totals
  const totalContactsCount = contacts.length;
  const customersCount = contacts.filter((c) => c.isCustomer).length;
  const prospectsCount = contacts.filter((c) => !c.isCustomer).length;
  const newsletterSubscribersCount = contacts.filter((c) => c.subscribedToNewsletter).length;

  // Sorting Handler
  const handleSort = (key: string) => {
    setSortDir((prev) => (sortKey === key && prev === 'asc' ? 'desc' : 'asc'));
    setSortKey(key);
  };

  // Save / Update / Insert Contact Handler
  const handleSaveContact = async (data: ContactSavePayload) => {
    try {
      const db = getSupabaseClient();
      let orgId: string | null = null;

      if (typeof data.organisationName === 'string' && data.organisationName.trim()) {
        const orgName = data.organisationName.trim();
        const { data: orgData, error: orgLookupError } = await db
          .from('organisations')
          .select('id')
          .eq('name', orgName)
          .maybeSingle();

        if (orgLookupError) throw orgLookupError;

        if (orgData?.id) {
          orgId = orgData.id;
        } else {
          const { data: newOrg, error: orgInsertError } = await db
            .from('organisations')
            .insert({ name: orgName })
            .select('id')
            .single();

          if (orgInsertError) throw orgInsertError;
          orgId = newOrg?.id || null;
        }
      }

      const dbContact = {
        first_name: data.firstName,
        last_name: data.lastName,
        preferred_name: data.preferredName || null,
        email: data.email,
        mobile_number: data.mobileNumber || null,
        work_phone: data.workPhone || null,
        address: data.address || null,
        suburb: data.suburb || null,
        state: data.state || null,
        postcode: data.postcode || null,
        country: data.country || null,
        organisation_id: orgId,
        department: data.department || null,
        position: data.position || null,
        notes: data.notes || null,
        is_customer: Boolean(data.isCustomer),
        subscribed_to_newsletter: Boolean(data.subscribedToNewsletter),
      };

      let contactId = data.id || null;

      if (contactId) {
        const { error: updateError } = await db.from('contacts').update(dbContact).eq('id', contactId);
        if (updateError) throw updateError;

        const { error: deleteJoinError } = await db.from('contact_services').delete().eq('contact_id', contactId);
        if (deleteJoinError) throw deleteJoinError;
      } else {
        const { data: insertedContact, error: insertError } = await db
          .from('contacts')
          .insert(dbContact)
          .select('id')
          .single();

        if (insertError) throw insertError;
        contactId = insertedContact?.id || null;
      }

      const servicesBought = Array.isArray(data.servicesBought) ? data.servicesBought : [];
      if (contactId && data.isCustomer && servicesBought.length > 0) {
        const joinRecords = servicesBought.map((serviceId: string) => ({
          contact_id: contactId,
          service_id: serviceId,
        }));
        const { error: joinInsertError } = await db.from('contact_services').insert(joinRecords);
        if (joinInsertError) throw joinInsertError;
      }

      await loadLiveData();

      if (emailOctopusApiKey.trim() !== '' && emailOctopusListId.trim() !== '') {
        fetch('/api/integrations/emailoctopus/sync', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            apiKey: emailOctopusApiKey,
            listId: emailOctopusListId,
            contacts: [
              {
                email: data.email,
                firstName: data.firstName || '',
                lastName: data.lastName || '',
                subscribedToNewsletter: data.subscribedToNewsletter,
              },
            ],
          }),
        }).catch((err) => console.error('Failed background single contact sync to EmailOctopus:', err));
      }
    } catch (err) {
      console.error('Error committing updates to Supabase database', err);
      throw err;
    }
  };

  // Archive Contact Handler
  //
  // Soft delete: the record is retained with deleted_at set, per the requirement that
  // records are archived rather than permanently removed. Goes through the API route so
  // the archive rules live in one place (src/lib/contacts/repository.ts) rather than
  // being duplicated in the browser.
  const handleArchiveContact = async (id: string) => {
    try {
      const response = await fetch(`/api/contacts/${id}`, { method: 'DELETE' });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Archive failed (HTTP ${response.status})`);
      }

      await loadLiveData();
    } catch (err) {
      console.error('Failed to archive contact', err);
      alert(`Failed to archive contact: ${getErrorMessage(err)}`);
      throw err;
    }
  };

  const handleSaveSettings = async () => {
    try {
      const db = getSupabaseClient();
      const { error } = await db.from('credentials').upsert(
        [
          { key: 'emailoctopus_api_key', value: emailOctopusApiKey },
          { key: 'emailoctopus_list_id', value: emailOctopusListId },
        ],
        { onConflict: 'key' }
      );

      if (error) throw error;
      await loadLiveData();
      alert('Settings saved successfully!');
    } catch (err) {
      console.error('Settings save error:', err);
      alert(`Failed to save settings: ${getErrorMessage(err)}`);
    }
  };

  const handleManualSync = async () => {
    setIsSyncing(true);
    try {
      const response = await fetch('/api/integrations/emailoctopus/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          apiKey: emailOctopusApiKey,
          listId: emailOctopusListId,
          contacts: contacts.map((contact) => ({
            email: contact.email,
            firstName: contact.firstName,
            lastName: contact.lastName,
            subscribedToNewsletter: contact.subscribedToNewsletter,
          })),
        }),
      });

      const result = await response.json();

      if (response.ok && result.success) {
        await recordSyncLog(`Sync completed: ${result.syncedCount} subscribers synced`, 'success');
        alert('Sync completed successfully!');
      } else {
        const errMessage = result.message || result.error || 'Unknown error';
        await recordSyncLog(`Sync failed: ${errMessage}`, 'failed').catch((logError) => {
          console.error('Failed to record sync failure:', logError);
        });
        alert(`Sync failed: ${errMessage}`);
      }
    } catch (err) {
      console.error('Sync error:', err);
      await recordSyncLog(`Sync failed: ${getErrorMessage(err)}`, 'failed').catch((logError) => {
        console.error('Failed to record sync failure:', logError);
      });
      alert(`Sync failed: ${getErrorMessage(err)}`);
    } finally {
      setIsSyncing(false);
    }
  };

  // Serialised with the same parameter names the export route parses
  // (src/lib/contacts/query.ts), so "export" always means "export what I am
  // looking at" rather than a second, drifting query path.
  const exportQuery = React.useMemo(() => {
    const params = new URLSearchParams();
    if (searchQuery.trim()) params.set('q', searchQuery.trim());
    if (jobTypeFilter) params.set('jobTypeId', jobTypeFilter);
    if (stateFilter) params.set('state', stateFilter);
    if (statusFilter === 'customer') params.set('status', 'customer');
    if (statusFilter === 'prospect') params.set('status', 'prospect');
    if (statusFilter === 'subscribed') params.set('subscribed', 'true');
    const query = params.toString();
    return query ? `&${query}` : '';
  }, [searchQuery, jobTypeFilter, stateFilter, statusFilter]);

  // Search & Filter Computation
  const filteredContacts = contacts
    .filter((contact) => {
      // 1. Search Query Match
      const searchStr = `${contact.firstName} ${contact.lastName} ${contact.preferredName} ${contact.email} ${contact.organisation?.name || ''} ${contact.position || ''}`.toLowerCase();
      if (!searchStr.includes(searchQuery.toLowerCase())) return false;

      // 2. Filter Tab Match
      if (statusFilter === 'customer' && !contact.isCustomer) return false;
      if (statusFilter === 'prospect' && contact.isCustomer) return false;
      if (statusFilter === 'subscribed' && !contact.subscribedToNewsletter) return false;

      // 3. Job type and location
      if (jobTypeFilter && contact.jobTypeId !== jobTypeFilter) return false;
      if (stateFilter && (contact.state || '').toUpperCase() !== stateFilter) return false;

      return true;
    })
    .sort((a, b) => {
      // 3. Sort Execution
      let valA = '';
      let valB = '';

      if (sortKey === 'name') {
        valA = `${a.firstName} ${a.lastName}`.toLowerCase();
        valB = `${b.firstName} ${b.lastName}`.toLowerCase();
      } else if (sortKey === 'organisation') {
        valA = (a.organisation?.name || '').toLowerCase();
        valB = (b.organisation?.name || '').toLowerCase();
      } else if (sortKey === 'status') {
        valA = a.isCustomer ? 'customer' : 'prospect';
        valB = b.isCustomer ? 'customer' : 'prospect';
      } else if (sortKey === 'newsletter') {
        valA = a.subscribedToNewsletter ? 'yes' : 'no';
        valB = b.subscribedToNewsletter ? 'yes' : 'no';
      }

      if (valA < valB) return sortDir === 'asc' ? -1 : 1;
      if (valA > valB) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });

  return (
    <div className={styles.appContainer}>
      <div className={styles.gridOverlay} />
      <div className={styles.ambientBlur1} />
      <div className={styles.ambientBlur2} />
      <div className={styles.ambientBlur3} />
      
      {/* Navigation Sidebar */}
      <Sidebar currentView={currentView} onViewChange={setCurrentView} />

      {/* Main View Area */}
      <main ref={mainContentRef} className={styles.mainContent}>
        
        {/* Connection Notice banner */}
        {!isDatabaseConnected && connectionError && currentView === 'contacts' && (
          <div className={styles.alertBanner}>
            <svg className={styles.alertIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span>
              <strong>Live database unavailable:</strong> {connectionError}
            </span>
          </div>
        )}

        {/* Render View Selection */}
        {currentView === 'contacts' && (
          <>
            <header className={styles.headerSection}>
              <div className={styles.titleGroup}>
                <div className={styles.eyebrow}>
                  <span className={styles.eyebrowDot} />
                  Workspace Overview
                </div>
                <h1 className={styles.pageTitle}>Dashboard overview</h1>
                <span className={styles.pageSubtitle}>Review and manage your system clients.</span>
              </div>
              <button 
                className={styles.actionButton}
                onClick={() => setSelectedContact({
                  id: '',
                  firstName: '',
                  lastName: '',
                  preferredName: '',
                  email: '',
                  mobileNumber: '',
                  workPhone: '',
                  address: '',
                  suburb: '',
                  state: '',
                  postcode: '',
                  country: 'Australia',
                  department: '',
                  position: '',
                  isCustomer: false,
                  subscribedToNewsletter: false,
                  organisation: null,
                })}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                <span>New Contact</span>
              </button>
            </header>

            {/* Dashboard stats cards */}
            <DashboardStats
              totalContacts={totalContactsCount}
              customers={customersCount}
              prospects={prospectsCount}
              newsletterSubscribers={newsletterSubscribersCount}
            />

            <FilterBar
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              statusFilter={statusFilter}
              onStatusChange={setStatusFilter}
              jobTypes={jobTypes}
              jobTypeFilter={jobTypeFilter}
              onJobTypeChange={setJobTypeFilter}
              stateFilter={stateFilter}
              onStateChange={setStateFilter}
              exportQuery={exportQuery}
              resultCount={filteredContacts.length}
            />

            {/* Contacts Table layout */}
            <ContactTable
              contacts={filteredContacts}
              onSelectContact={setSelectedContact}
              onSort={handleSort}
              sortKey={sortKey}
              sortDir={sortDir}
              isLoading={isLoading}
            />

          </>
        )}

        {currentView === 'campaigns' && (
          <>
            <header className={styles.headerSection}>
              <div className={styles.titleGroup}>
                <div className={styles.eyebrow}>
                  <span className={styles.eyebrowDot} />
                  Outreach
                </div>
                <h1 className={styles.pageTitle}>Segments and campaigns</h1>
                <span className={styles.pageSubtitle}>
                  Build an audience from the database, then approve and send.
                </span>
              </div>
            </header>

            <MarketingView jobTypes={jobTypes} />
          </>
        )}

        {currentView === 'imports' && (
          <>
            <header className={styles.headerSection}>
              <div className={styles.titleGroup}>
                <div className={styles.eyebrow}>
                  <span className={styles.eyebrowDot} />
                  Spreadsheet Tools
                </div>
                <h1 className={styles.pageTitle}>Excel spreadsheet importer</h1>
                <span className={styles.pageSubtitle}>Upload client list files to ingest data records into the database.</span>
              </div>
            </header>

            <div className={styles.splitLayout}>
              <div className={styles.sectionIntro} style={{ padding: '12px' }}>
                <h3 className={styles.sectionIntroTitle}>Data Ingestion Panel</h3>
                <p className={styles.sectionIntroDesc}>
                  Upload spreadsheets (`.xls`, `.xlsx`) to import contact profiles, resolve company associations, and sync newsletter subscriptions.
                </p>
                <div className={styles.checklist}>
                  <div className={styles.checklistItem}>
                    <span className={styles.checkIcon}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </span>
                    <span>Auto-creates Organisation profiles</span>
                  </div>
                  <div className={styles.checklistItem}>
                    <span className={styles.checkIcon}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </span>
                    <span>Identifies customer/prospect status</span>
                  </div>
                  <div className={styles.checklistItem}>
                    <span className={styles.checkIcon}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </span>
                    <span>Saves email list subscriptions</span>
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                {!importFile && !isImporting && (
                  <div 
                    className="outerShell"
                    onClick={() => fileInputRef.current?.click()}
                    style={{ cursor: 'pointer' }}
                  >
                    <input 
                      data-testid="excel-file-input"
                      type="file" 
                      ref={fileInputRef} 
                      style={{ display: 'none' }} 
                      accept=".xlsx,.xls,.csv" 
                      onChange={handleFileChange} 
                    />
                    <div className="innerCore" style={{ padding: '48px 24px' }}>
                      <div className={styles.dropzoneInner} style={{ background: 'transparent', padding: 0 }}>
                        <div className={styles.uploadIconSpot}>
                          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="17 8 12 3 7 8" />
                            <line x1="12" y1="3" x2="12" y2="15" />
                          </svg>
                        </div>
                        <h4 style={{ color: 'var(--text-primary)', marginBottom: '6px', fontSize: '1rem', fontWeight: 600 }}>Drag and drop XLS files here</h4>
                        <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>or click to browse local files</span>
                      </div>
                    </div>
                  </div>
                )}

                {isImporting && (
                  <div className="outerShell">
                    <div className="innerCore" style={{ padding: '32px 24px' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
                        <div className={styles.uploadIconSpot} style={{ animation: 'pulseDot 1.5s infinite alternate' }}>
                          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="17 8 12 3 7 8" />
                            <line x1="12" y1="3" x2="12" y2="15" />
                          </svg>
                        </div>
                        <h4 style={{ color: 'var(--text-primary)', fontSize: '1.05rem', fontWeight: 600 }}>Uploading {importFile?.name}...</h4>
                        <div style={{ width: '100%', height: '8px', background: 'rgba(0,0,0,0.06)', borderRadius: '4px', overflow: 'hidden' }}>
                          <div style={{ width: `${importProgress}%`, height: '100%', background: 'var(--primary)', transition: 'width 100ms ease-out' }} />
                        </div>
                        <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>{importProgress}% completed</span>
                      </div>
                    </div>
                  </div>
                )}

                {isMapped && !showPreview && importFile && (
                  <div className="outerShell">
                    <div className="innerCore" style={{ padding: '24px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', borderBottom: '1px dashed var(--border)', paddingBottom: '12px' }}>
                        <div>
                          <h4 style={{ color: 'var(--text-primary)', fontSize: '1.05rem', fontWeight: 600 }}>File Uploaded: {importFile.name}</h4>
                          <span style={{ color: 'var(--text-secondary)', fontSize: '0.78rem' }}>Map spreadsheet columns to CRM field items.</span>
                        </div>
                        <button 
                          style={{ fontSize: '0.8rem', color: 'var(--danger)', fontWeight: 600, border: 'none', background: 'none', cursor: 'pointer' }}
                          onClick={() => {
                            setImportFile(null);
                            setIsMapped(false);
                          }}
                        >
                          Reset File
                        </button>
                      </div>

                      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '20px' }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid var(--border)' }}>
                            <th style={{ textAlign: 'left', padding: '8px 12px', fontSize: '0.72rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Excel Column Header</th>
                            <th style={{ textAlign: 'left', padding: '8px 12px', fontSize: '0.72rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Maps to CRM Field</th>
                          </tr>
                        </thead>
                        <tbody>
                          {CRM_FIELDS.map((field) => (
                            <tr key={field.key} style={{ borderBottom: '1px solid rgba(34, 38, 43, 0.05)' }}>
                              <td style={{ padding: '12px' }}>
                                <div style={{ fontSize: '0.88rem', fontWeight: 600, color: 'var(--text-primary)' }}>{field.label}</div>
                                <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>{field.description}</div>
                              </td>
                              <td style={{ padding: '12px' }}>
                                <select 
                                  data-testid={`mapping-select-${field.key}`}
                                  className={styles.searchInput} 
                                  style={{ padding: '6px 12px', fontSize: '0.82rem', maxWidth: '240px' }} 
                                  value={columnMapping[field.key] || ''}
                                  onChange={(e) => {
                                    setColumnMapping(prev => ({
                                      ...prev,
                                      [field.key]: e.target.value
                                    }));
                                  }}
                                >
                                  <option value="">(Don&apos;t map this field)</option>
                                  {rawHeaders.map((h) => (
                                    <option key={h} value={h}>{h}</option>
                                  ))}
                                </select>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>

                      <button 
                        className={styles.actionButton} 
                        style={{ width: '100%', justifyContent: 'center' }}
                        onClick={() => setShowPreview(true)}
                      >
                        Preview Validation
                      </button>
                    </div>
                  </div>
                )}

                {isMapped && showPreview && importFile && (
                  <div className="outerShell">
                    <div className="innerCore" style={{ padding: '24px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', borderBottom: '1px dashed var(--border)', paddingBottom: '12px' }}>
                        <div>
                          <h4 style={{ color: 'var(--text-primary)', fontSize: '1.05rem', fontWeight: 600 }}>Validation Summary</h4>
                          <span style={{ color: 'var(--text-secondary)', fontSize: '0.78rem' }}>Check valid and invalid records before importing.</span>
                        </div>
                        <button 
                          style={{ fontSize: '0.8rem', color: 'var(--primary)', fontWeight: 600, border: 'none', background: 'none', cursor: 'pointer' }}
                          onClick={() => setShowPreview(false)}
                        >
                          Back to Mapping
                        </button>
                      </div>

                      {(() => {
                        const mapped = mapAndValidateRows(rawRows, columnMapping);
                        const validRows = mapped.filter(r => r.isValid);
                        const invalidRows = mapped.filter(r => !r.isValid);

                        return (
                          <div>
                            <div style={{ display: 'flex', gap: '16px', marginBottom: '20px' }}>
                              <div style={{ flex: 1, padding: '12px', background: 'rgba(1, 172, 219, 0.05)', borderRadius: '8px', border: '1px solid var(--glass-border)' }}>
                                <span style={{ fontSize: '0.72rem', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>Total Rows</span>
                                <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)' }}>{mapped.length}</div>
                              </div>
                              <div style={{ flex: 1, padding: '12px', background: 'rgba(40, 167, 69, 0.05)', borderRadius: '8px', border: '1px solid rgba(40, 167, 69, 0.2)' }}>
                                <span style={{ fontSize: '0.72rem', textTransform: 'uppercase', color: 'rgba(40, 167, 69, 0.8)' }}>Valid Rows</span>
                                <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#28a745' }}>{validRows.length}</div>
                              </div>
                              <div style={{ flex: 1, padding: '12px', background: 'rgba(220, 53, 69, 0.05)', borderRadius: '8px', border: '1px solid rgba(220, 53, 69, 0.2)' }}>
                                <span style={{ fontSize: '0.72rem', textTransform: 'uppercase', color: 'rgba(220, 53, 69, 0.8)' }}>Invalid Rows</span>
                                <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#dc3545' }}>{invalidRows.length}</div>
                              </div>
                            </div>

                            <h5 style={{ color: 'var(--text-primary)', marginBottom: '8px', fontWeight: 600 }}>Valid Contacts ({validRows.length})</h5>
                            <div style={{ maxHeight: '180px', overflowY: 'auto', marginBottom: '20px', border: '1px solid var(--border)', borderRadius: '8px' }}>
                              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <tbody>
                                  {validRows.length === 0 ? (
                                    <tr><td style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>No valid rows.</td></tr>
                                  ) : (
                                    validRows.map((r, i) => (
                                      <tr key={i} style={{ borderBottom: '1px solid rgba(0,0,0,0.05)' }}>
                                        <td style={{ padding: '8px 12px', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                                          {r.data?.firstName} {r.data?.lastName}
                                        </td>
                                        <td style={{ padding: '8px 12px', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{r.data?.email}</td>
                                        <td style={{ padding: '8px 12px', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{r.data?.organisationName || '-'}</td>
                                      </tr>
                                    ))
                                  )}
                                </tbody>
                              </table>
                            </div>

                            <h5 style={{ color: 'var(--text-primary)', marginBottom: '8px', fontWeight: 600 }}>Invalid Contacts ({invalidRows.length})</h5>
                            <div style={{ maxHeight: '180px', overflowY: 'auto', marginBottom: '20px', border: '1px solid var(--border)', borderRadius: '8px' }}>
                              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <tbody>
                                  {invalidRows.length === 0 ? (
                                    <tr><td style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>No invalid rows.</td></tr>
                                  ) : (
                                    invalidRows.map((r, i) => (
                                      <tr key={i} style={{ borderBottom: '1px solid rgba(0,0,0,0.05)' }}>
                                        <td style={{ padding: '8px 12px', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                                          Record #{i + 1}
                                        </td>
                                        <td style={{ padding: '8px 12px', fontSize: '0.82rem', color: 'var(--danger)', fontWeight: 500 }}>
                                          {r.errors?.join(', ')}
                                        </td>
                                      </tr>
                                    ))
                                  )}
                                </tbody>
                              </table>
                            </div>

                            <button 
                              className={styles.actionButton} 
                              style={{ width: '100%', justifyContent: 'center' }}
                              onClick={handleIngestContacts}
                              disabled={validRows.length === 0}
                            >
                              Ingest {validRows.length} Contacts
                            </button>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {currentView === 'integrations' && (
          <>
            <header className={styles.headerSection}>
              <div className={styles.titleGroup}>
                <div className={styles.eyebrow}>
                  <span className={styles.eyebrowDot} />
                  Mailing List Sync
                </div>
                <h1 className={styles.pageTitle}>EmailOctopus campaigns</h1>
                <span className={styles.pageSubtitle}>Review mailing lists sync status and activity timelines.</span>
              </div>
            </header>

            {/* Sync dashboard layout */}
            <div className={statsStyles.statsGrid} style={{ marginBottom: '32px' }}>
              <div className={statsStyles.cardShell} style={{ cursor: 'default' }}>
                <div className={statsStyles.cardInner}>
                  <div className={statsStyles.header}>
                    <span className={statsStyles.label}>Connection State</span>
                    <div className={`${styles.statusDot} ${isConnected ? styles.statusActive : styles.statusIdle}`} />
                  </div>
                  <span className={statsStyles.value} style={{ fontSize: '1.8rem' }}>
                    {isConnected ? 'Connected' : 'Disconnected'}
                  </span>
                  <div className={statsStyles.trend}>
                    <span className={isConnected ? statsStyles.trendPositive : statsStyles.trendNeutral}>
                      {isConnected ? 'EmailOctopus synchronization active' : 'Requires API token authentication'}
                    </span>
                  </div>
                </div>
              </div>

              <div className={statsStyles.cardShell} style={{ cursor: 'default' }}>
                <div className={statsStyles.cardInner}>
                  <div className={statsStyles.header}>
                    <span className={statsStyles.label}>Subscribers Synced</span>
                    <span style={{ color: 'var(--primary)', fontSize: '0.8rem', fontWeight: 600 }}>Total</span>
                  </div>
                  <span className={statsStyles.value} style={{ fontSize: '1.8rem' }}>{newsletterSubscribersCount} Contacts</span>
                  <div className={statsStyles.trend}>
                    <span className={statsStyles.trendPositive}>
                      {totalContactsCount > 0 ? Math.round((newsletterSubscribersCount / totalContactsCount) * 100) : 0}% list density
                    </span>
                  </div>
                </div>
              </div>

              <div className={statsStyles.cardShell} style={{ cursor: 'default' }}>
                <div className={statsStyles.cardInner}>
                  <div className={statsStyles.header}>
                    <span className={statsStyles.label}>Sync Frequency</span>
                    <span style={{ color: 'var(--accent)', fontSize: '0.8rem', fontWeight: 600 }}>Active</span>
                  </div>
                  <span className={statsStyles.value} style={{ fontSize: '1.8rem' }}>On-demand</span>
                  <div className={statsStyles.trend}>
                    <span className={statsStyles.trendNeutral}>Background replication disabled</span>
                  </div>
                </div>
              </div>
            </div>

            <div className={styles.splitLayoutEqual}>
              <div className={styles.sectionIntro} style={{ padding: '12px' }}>
                <h3 className={styles.sectionIntroTitle}>Sync Configurations</h3>
                <p className={styles.sectionIntroDesc}>
                  By connecting your API credentials, the CRM will perform automatic, bi-directional updates. Toggling newsletter subscriptions on client profiles will automatically propagate changes to your EmailOctopus campaigns list.
                </p>
                <div className={styles.statusCard} style={{ marginTop: '12px' }}>
                  <div className={styles.statusHeader}>
                    <span className={`${styles.statusDot} ${isConnected ? styles.statusActive : styles.statusIdle}`} />
                    <span className={styles.settingLabel} style={{ marginBottom: 0 }}>Sync Engine Status</span>
                  </div>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', lineHeight: '1.5' }}>
                    {isConnected ? 'Connected. EmailOctopus synchronization active.' : 'Idle. Configure your API token in the settings menu to enable live webhooks and automated background list replication.'}
                  </p>
                  <button 
                    className={styles.actionButton} 
                    style={{ marginTop: '16px', width: '100%', justifyContent: 'center' }}
                    onClick={() => {
                      if (!isConnected) {
                        alert('Please configure your EmailOctopus API Key and List ID in settings first.');
                        return;
                      }
                      handleManualSync();
                    }}
                    disabled={isSyncing}
                  >
                    {isSyncing ? 'Syncing...' : 'Sync Now'}
                  </button>
                </div>
              </div>

              <div className="outerShell">
                <div className="innerCore" style={{ padding: '24px' }}>
                  <h3 className={styles.sectionIntroTitle} style={{ marginBottom: '16px', borderBottom: '1px dashed var(--border)', paddingBottom: '12px' }}>Sync activity history</h3>
                  <div className={styles.timeline}>
                    {syncLogs.length === 0 ? (
                      <div className={styles.timelineItem}>
                        <span className={styles.timelineDot} />
                        <div className={styles.timelineContent}>
                          <span className={styles.timelineTime}>Now</span>
                          <span className={styles.timelineText}>No sync history. Configure credentials to start.</span>
                        </div>
                      </div>
                    ) : (
                      syncLogs.map((log) => (
                        <div key={log.id} className={styles.timelineItem}>
                          <span className={`${styles.timelineDot} ${log.status === 'failed' ? styles.timelineDotWarning : ''}`} />
                          <div className={styles.timelineContent}>
                            <span className={styles.timelineTime}>
                              {new Date(log.created_at).toLocaleString('en-US', {
                                month: 'short',
                                day: 'numeric',
                                hour: 'numeric',
                                minute: '2-digit',
                                hour12: true
                              })}
                            </span>
                            <span className={styles.timelineText}>{log.event_text}</span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {currentView === 'settings' && (
          <>
            <header className={styles.headerSection}>
              <div className={styles.titleGroup}>
                <div className={styles.eyebrow}>
                  <span className={styles.eyebrowDot} />
                  System Setup
                </div>
                <h1 className={styles.pageTitle}>System settings</h1>
                <span className={styles.pageSubtitle}>Configure backend Supabase endpoint URLs and email marketing credentials.</span>
              </div>
            </header>

            <div className={styles.splitLayout}>
              <div className={styles.sectionIntro} style={{ padding: '12px' }}>
                <h3 className={styles.sectionIntroTitle}>Configuration Console</h3>
                <p className={styles.sectionIntroDesc}>
                  Review the active Supabase endpoint and store EmailOctopus credentials for live marketing automations.
                </p>
                <p className={styles.sectionIntroDesc} style={{ fontSize: '0.8rem', opacity: 0.8 }}>
                  Supabase and Geoapify keys are read from environment variables. EmailOctopus keys are saved to the Supabase credentials table.
                </p>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                {/* Database Config Card */}
                <div className="outerShell">
                  <div className="innerCore" style={{ padding: '24px' }}>
                    <div className={styles.sectionTitle} style={{ margin: 0, borderBottom: '1px dashed var(--border)', paddingBottom: '12px', marginBottom: '20px' }}>Database Config</div>
                    
                    <div className={styles.settingGroup}>
                      <span className={styles.settingLabel}>Supabase Endpoint URL</span>
                      <input 
                        type="text" 
                        className={styles.searchInput} 
                        style={{ maxWidth: '100%', marginTop: '6px' }}
                        placeholder="https://your-project-id.supabase.co" 
                        defaultValue={process.env.NEXT_PUBLIC_SUPABASE_URL || ''}
                        readOnly
                      />
                      <span className={styles.settingDescription}>Read from NEXT_PUBLIC_SUPABASE_URL.</span>
                    </div>

                    <div className={styles.settingGroup} style={{ marginBottom: 0 }}>
                      <span className={styles.settingLabel}>Supabase Anon Key</span>
                      <input 
                        type="password" 
                        className={styles.searchInput} 
                        style={{ maxWidth: '100%', marginTop: '6px' }}
                        placeholder="your-supabase-anon-key" 
                        defaultValue={process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''}
                        readOnly
                      />
                      <span className={styles.settingDescription}>Read from NEXT_PUBLIC_SUPABASE_ANON_KEY.</span>
                    </div>
                  </div>
                </div>

                {/* Email Marketing Card */}
                <div className="outerShell">
                  <div className="innerCore" style={{ padding: '24px' }}>
                    <div className={styles.sectionTitle} style={{ margin: 0, borderBottom: '1px dashed var(--border)', paddingBottom: '12px', marginBottom: '20px' }}>Email Marketing Keys</div>

                    <div className={styles.settingGroup}>
                      <span className={styles.settingLabel}>EmailOctopus API Key</span>
                      <input 
                        type="password" 
                        className={styles.searchInput} 
                        style={{ maxWidth: '100%', marginTop: '6px' }}
                        placeholder="your-emailoctopus-api-key"
                        value={emailOctopusApiKey}
                        onChange={(e) => setEmailOctopusApiKey(e.target.value)}
                      />
                      <span className={styles.settingDescription}>Mailing lists campaign API key credentials.</span>
                    </div>

                    <div className={styles.settingGroup} style={{ marginBottom: 0 }}>
                      <span className={styles.settingLabel}>EmailOctopus List ID</span>
                      <input 
                        type="text" 
                        className={styles.searchInput} 
                        style={{ maxWidth: '100%', marginTop: '6px' }}
                        placeholder="your-emailoctopus-list-id"
                        value={emailOctopusListId}
                        onChange={(e) => setEmailOctopusListId(e.target.value)}
                      />
                      <span className={styles.settingDescription}>EmailOctopus campaigns subscriber list ID.</span>
                    </div>
                  </div>
                </div>
                
                <button className={styles.actionButton} style={{ width: '100%', justifyContent: 'center' }} onClick={handleSaveSettings}>
                  Save Config Options
                </button>
              </div>
            </div>
          </>
        )}
      </main>

      {/* Detailed Contact Drawer slider overlay */}
      <ContactDrawer
        contact={selectedContact}
        onClose={() => setSelectedContact(null)}
        onSave={handleSaveContact}
        onDelete={handleArchiveContact}
        availableServices={services}
      />
    </div>
  );
}
