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

import React, { useState, useEffect, useRef, useCallback } from 'react';
import styles from './page.module.css';
import statsStyles from '@/components/DashboardStats.module.css';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';

import { prefersReducedMotion } from '@/lib/motion';
import Sidebar, { ACTIVE_VIEWS, ActiveView } from '@/components/Sidebar';
import DashboardStats from '@/components/DashboardStats';
import ContactTable, { TableContact } from '@/components/ContactTable';
import ContactDrawer from '@/components/ContactDrawer';
import { getSupabaseClient, hasSupabaseConfig } from '@/lib/supabaseClient';
import { mapAndValidateRows } from '@/lib/excelParser';
import {
  analyseHeaders,
  emptyColumnMapping,
  isMappingComplete,
  type AmbiguousHeader,
  type ColumnMapping,
} from '@/lib/contacts/columnMapping';
import { CRM_FIELDS } from '@/lib/contacts/importFields';
import { importContacts, previewContactImport } from '@/lib/contacts/import';
import ImportChangePreview from '@/components/import/ImportChangePreview';
import ImportRequirements from '@/components/import/ImportRequirements';
import ImportMappingStatus from '@/components/import/ImportMappingStatus';
import ImportCommonTags from '@/components/import/ImportCommonTags';
import FilterBar, { type StatusFilter } from '@/components/contacts/FilterBar';
import BulkTagActions from '@/components/contacts/BulkTagActions';
import type { TagOption } from '@/components/contacts/TagPicker';
import type { OrganisationOption } from '@/components/contacts/OrganisationPicker';
import MarketingView from '@/components/marketing/MarketingView';
import EmailTemplateRegistry from '@/components/marketing/EmailTemplateRegistry';
import NewsletterSchedules from '@/components/marketing/NewsletterSchedules';
import ArchiveHub from '@/components/archive/ArchiveHub';
import ContentStudioView from '@/components/content-studio/ContentStudioView';
import { requestLifecycle } from '@/lib/lifecycle/client';
import BookingsView from '@/components/bookings/BookingsView';
import OperationsPanel from '@/components/operations/OperationsPanel';
import Pagination from '@/components/ui/Pagination';
import EmailOctopusSettings, { type EmailOctopusStatus } from '@/components/settings/EmailOctopusSettings';
import JobTypesSettings from '@/components/settings/JobTypesSettings';
import SocialConnectionsSettings from '@/components/settings/SocialConnectionsSettings';
import BrandProfileSettings from '@/components/settings/BrandProfileSettings';
import JobTypesDialog from '@/components/settings/JobTypesDialog';
import OrganisationSettings from '@/components/settings/OrganisationSettings';
import type { ContactStatus } from '@/lib/db/types';

type ServiceOption = { id: string; name: string };
type SyncLog = { id: string; event_text: string; status: string; created_at: string };
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
  status?: ContactStatus | null;
  is_customer: boolean | null;
  subscribed_to_newsletter: boolean | null;
  subscribed_to_programs: boolean | null;
  job_type_id: string | null;
  organisation: { name: string } | null;
  tags?: { id: string; name: string }[] | null;
  revision?: number;
};
type ContactSavePayload = Partial<TableContact> & {
  organisationName?: string;
};
type EmailOctopusHealth =
  | { status: 'unchecked' | 'checking' | 'not_configured' | 'error'; missing: string[] }
  | { status: 'ready' | 'needs_fields'; missing: string[] };
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
    status:
      contact.status && contact.status !== 'archived'
        ? contact.status
        : (contact.is_customer ? 'customer' : 'prospect'),
    isCustomer: contact.status
      ? contact.status === 'customer'
      : Boolean(contact.is_customer),
    subscribedToNewsletter: Boolean(contact.subscribed_to_newsletter),
    subscribedToPrograms: Boolean(contact.subscribed_to_programs),
    jobTypeId: contact.job_type_id || null,
    organisation: contact.organisation || null,
    servicesBought: contactServices,
    tags: contact.tags ?? [],
    revision: contact.revision,
  };
}

/**
 * Ceiling on the reference tables that feed dropdowns (services, job types,
 * credentials). They must load whole rather than by page, but still need a bound:
 * PostgREST caps a read at 1000 rows and reports nothing when it does, so an unbounded
 * query silently returns a prefix instead of failing.
 */
const REFERENCE_LIMIT = 200;

/**
 * Job types for the dropdowns, through the catalogue API so the page and the settings
 * screen read the same list with the same rules.
 */
async function fetchJobTypes(): Promise<ServiceOption[]> {
  const response = await fetch(`/api/job-types?pageSize=${REFERENCE_LIMIT}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `Could not load job types (HTTP ${response.status})`);
  }
  return ((body.jobTypes ?? []) as ServiceOption[]).map((jobType) => ({ id: jobType.id, name: jobType.name }));
}

/** Sync log entries per page. Short: it is a sidebar timeline, not a report. */
const SYNC_LOG_PAGE_SIZE = 20;

/**
 * Service IDs for the contacts on screen, keyed by contact.
 *
 * Scoped to the given IDs rather than reading the whole join table, which was the other
 * unbounded query behind this page.
 */
async function fetchServicesForContacts(contactIds: string[]): Promise<Map<string, string[]>> {
  const byContact = new Map<string, string[]>();

  if (contactIds.length === 0 || !hasSupabaseConfig) {
    return byContact;
  }

  const { data, error } = await getSupabaseClient()
    .from('contact_services')
    .select('contact_id, service_id')
    .in('contact_id', contactIds);

  if (error) throw error;

  for (const join of (data || []) as ContactServiceJoin[]) {
    const existing = byContact.get(join.contact_id);

    if (existing) {
      existing.push(join.service_id);
    } else {
      byContact.set(join.contact_id, [join.service_id]);
    }
  }

  return byContact;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown error';
}

export default function App() {
  const [currentView, setCurrentView] = useState<ActiveView>('contacts');
  // A campaign drafted from the Content Studio opens directly in Campaigns.
  const [campaignToOpen, setCampaignToOpen] = useState<string | undefined>(undefined);
  const [awaitingApproval, setAwaitingApproval] = useState(0);
  const mainContentRef = useRef<HTMLElement>(null);

  // `?view=campaigns` opens that workspace directly — it is where the newsletter review
  // email links. Read once on mount; the tabs are not otherwise kept in the URL.
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('view');

    if (requested && (ACTIVE_VIEWS as readonly string[]).includes(requested)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCurrentView(requested as ActiveView);
    }
  }, []);

  // Campaigns waiting for approval, for the sidebar badge. Re-read on every tab change
  // so approving one and moving on clears it. A failure leaves the last count: the badge
  // is a nudge, and an error here must not disturb the rest of the dashboard.
  useEffect(() => {
    let cancelled = false;

    fetch('/api/campaigns?status=in_review&pageSize=1')
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!cancelled && body && typeof body.total === 'number') setAwaitingApproval(body.total);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [currentView]);

  useGSAP(() => {
    // Decorative entrance only. Skipping it leaves the panes at their final rendered
    // state, which is what "instant transition" means -- see src/lib/motion.ts.
    if (prefersReducedMotion()) return;
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
  // Any of these tags (tagIds); the full options are kept so the chips keep their names.
  const [tagFilter, setTagFilter] = useState<TagOption[]>([]);
  const [organisationFilter, setOrganisationFilter] = useState<OrganisationOption | null>(null);
  const [industryFilter, setIndustryFilter] = useState('');
  // Bumped after an industry edit so the filter reloads its server-side options.
  const [filterOptionsVersion, setFilterOptionsVersion] = useState(0);
  // The job type catalogue, opened over the drawer without unmounting its draft.
  const [isJobTypesOpen, setIsJobTypesOpen] = useState(false);
  const [jobTypes, setJobTypes] = useState<ServiceOption[]>([]);
  const [sortKey, setSortKey] = useState('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  
  const [contactsPage, setContactsPage] = useState(1);
  const [contactsPageSize, setContactsPageSize] = useState(50);
  const [contactsTotal, setContactsTotal] = useState(0);

  /**
   * Rows the user has ticked for a partial export.
   *
   * Held as ids rather than contacts because only one page is in memory at a time — a
   * selection has to survive paging, and the export resolves the ids server-side anyway.
   */
  const [selectedContactIds, setSelectedContactIds] = useState<ReadonlySet<string>>(
    () => new Set<string>()
  );
  const [isContactsLoading, setIsContactsLoading] = useState(true);

  // Counted in the database rather than over the loaded rows: with the list paginated,
  // counting what is in memory would report the size of the current page.
  const [stats, setStats] = useState({
    total: 0,
    customers: 0,
    prospects: 0,
    subscribers: 0,
    programSubscribers: 0,
  });

  const [isDatabaseConnected, setIsDatabaseConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Spreadsheet Importer states
  const [importFile, setImportFile] = useState<{ name: string; size: number } | null>(null);
  const [importProgress, setImportProgress] = useState(0);
  const [isImporting, setIsImporting] = useState(false);
  const [isFileDragActive, setIsFileDragActive] = useState(false);
  const [isMapped, setIsMapped] = useState(false);
  const [rawHeaders, setRawHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<Record<string, string>[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const [columnMapping, setColumnMapping] = useState<ColumnMapping>(emptyColumnMapping());
  // Headers such as "Industry" that could mean more than one field; never auto-mapped.
  const [ambiguousHeaders, setAmbiguousHeaders] = useState<AmbiguousHeader[]>([]);
  // Tags added to every accepted row, on top of each row's own Tags cell.
  const [commonTags, setCommonTags] = useState<string[]>([]);

  // EmailOctopus integrations state
  // Connection status only: the saved API key never reaches the browser (audit H1).
  const [emailOctopusStatus, setEmailOctopusStatus] = useState<EmailOctopusStatus | null>(null);
  const [syncLogs, setSyncLogs] = useState<SyncLog[]>([]);
  const [syncLogsPage, setSyncLogsPage] = useState(1);
  const [syncLogsTotal, setSyncLogsTotal] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isPreparingEmailOctopus, setIsPreparingEmailOctopus] = useState(false);
  const [emailOctopusHealth, setEmailOctopusHealth] = useState<EmailOctopusHealth>({
    status: 'unchecked',
    missing: [],
  });
  const isEmailOctopusConfigured = Boolean(emailOctopusStatus?.configured);
  const isEmailOctopusReachable =
    emailOctopusHealth.status === 'ready' || emailOctopusHealth.status === 'needs_fields';

  const fileInputRef = useRef<HTMLInputElement>(null);

  // The single description of "what the user is looking at", serialised with the
  // parameter names src/lib/contacts/query.ts parses. Filtering and sorting run in the
  // database now that only one page of contacts is in memory — and the export reuses
  // the same string, so "export" still means "export what I am looking at" rather than
  // a second, drifting query path.
  const contactQuery = React.useMemo(() => {
    const params = new URLSearchParams();
    if (searchQuery.trim()) params.set('q', searchQuery.trim());
    if (jobTypeFilter) params.set('jobTypeId', jobTypeFilter);
    if (stateFilter) params.set('state', stateFilter);
    if (tagFilter.length > 0) params.set('tagIds', tagFilter.map((tag) => tag.id).join(','));
    if (organisationFilter) params.set('organisationId', organisationFilter.id);
    if (industryFilter) params.set('industry', industryFilter);
    if (statusFilter === 'lead') params.set('status', 'lead');
    if (statusFilter === 'customer') params.set('status', 'customer');
    if (statusFilter === 'prospect') params.set('status', 'prospect');
    if (statusFilter === 'newsletter') params.set('subscribed', 'true');
    if (statusFilter === 'programs') params.set('programs', 'true');
    params.set('sort', sortKey);
    params.set('dir', sortDir);
    return params.toString();
  }, [
    searchQuery,
    jobTypeFilter,
    stateFilter,
    tagFilter,
    organisationFilter,
    industryFilter,
    statusFilter,
    sortKey,
    sortDir,
  ]);

  const exportQuery = contactQuery ? `&${contactQuery}` : '';

  /**
   * Reference data: services, job types and the integration connection status.
   *
   * Contacts, the dashboard counters and the sync log each load separately below — they
   * are paginated and re-fetch on their own schedule, while this is the small, whole
   * data the rest of the screen is built from.
   */
  const loadLiveData = React.useCallback(async () => {
    if (!hasSupabaseConfig) {
      setServices([]);
      setJobTypes([]);
      setEmailOctopusStatus(null);
      setIsDatabaseConnected(false);
      setConnectionError('Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to load CRM data.');
      return;
    }

    try {
      const db = getSupabaseClient();

      // These feed dropdowns, so they load whole rather than by page — but still
      // bounded, because an unbounded read stops at PostgREST's cap in silence.
      const { data: serviceData, error: serviceError } = await db
        .from('services')
        .select('*')
        .order('name')
        .limit(REFERENCE_LIMIT);
      if (serviceError) throw serviceError;

      const jobTypeData = await fetchJobTypes();

      const statusResponse = await fetch('/api/integrations/emailoctopus/credentials');
      const statusBody = await statusResponse.json().catch(() => ({}));
      if (!statusResponse.ok) {
        throw new Error(statusBody.error || `Could not read integration settings (HTTP ${statusResponse.status})`);
      }

      setServices(((serviceData || []) as ServiceOption[]).map((service) => ({ id: service.id, name: service.name })));
      setJobTypes(jobTypeData);
      setEmailOctopusStatus(statusBody as EmailOctopusStatus);
      setIsDatabaseConnected(true);
      setConnectionError(null);
    } catch (error) {
      const message = getErrorMessage(error);
      setServices([]);
      setJobTypes([]);
      setIsDatabaseConnected(false);
      setConnectionError(`Supabase connection failed: ${message}`);
      console.error('Supabase connection failed:', error);
    }
  }, []);

  /**
   * Re-reads only the job types, after the catalogue changes. The drawer, the filter and
   * the marketing view all read this list, so a rename shows up everywhere at once.
   */
  const reloadJobTypes = React.useCallback(async () => {
    if (!hasSupabaseConfig) return;
    try {
      setJobTypes(await fetchJobTypes());
    } catch (error) {
      console.error('Failed to reload job types', error);
    }
  }, []);

  /**
   * Dashboard counters, counted in the database.
   *
   * `head: true` asks for the count without the rows, so this stays cheap however large
   * the table grows.
   */
  const loadStats = React.useCallback(async () => {
    if (!hasSupabaseConfig) {
      setStats({ total: 0, customers: 0, prospects: 0, subscribers: 0, programSubscribers: 0 });
      return;
    }

    try {
      const db = getSupabaseClient();

      const [totalResult, customerResult, subscriberResult, programResult] = await Promise.all([
        db.from('active_contacts').select('id', { count: 'exact', head: true }),
        db.from('active_contacts').select('id', { count: 'exact', head: true }).eq('is_customer', true),
        db.from('active_contacts').select('id', { count: 'exact', head: true }).eq('subscribed_to_newsletter', true),
        // Counted rather than derived from the newsletter figure: the two consents
        // overlap but neither contains the other.
        db.from('active_contacts').select('id', { count: 'exact', head: true }).eq('subscribed_to_programs', true),
      ]);

      const total = totalResult.count ?? 0;
      const customers = customerResult.count ?? 0;

      setStats({
        total,
        customers,
        // Derived rather than counted separately: a prospect is defined as "not a
        // customer", so a third query could disagree with the first two.
        prospects: Math.max(0, total - customers),
        subscribers: subscriberResult.count ?? 0,
        programSubscribers: programResult.count ?? 0,
      });
    } catch (error) {
      console.error('Failed to load contact counts', error);
    }
  }, []);

  /** One page of the sync activity timeline, newest first. */
  const loadSyncLogs = React.useCallback(async () => {
    if (!hasSupabaseConfig) {
      setSyncLogs([]);
      setSyncLogsTotal(0);
      return;
    }

    try {
      const db = getSupabaseClient();
      const from = (syncLogsPage - 1) * SYNC_LOG_PAGE_SIZE;

      const { data, error, count } = await db
        .from('sync_logs')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, from + SYNC_LOG_PAGE_SIZE - 1);

      if (error) throw error;

      setSyncLogs(((data || []) as SyncLog[]).map((log) => ({
        id: log.id,
        event_text: log.event_text,
        status: log.status,
        created_at: log.created_at,
      })));
      setSyncLogsTotal(count ?? 0);
    } catch (error) {
      console.error('Failed to load sync logs', error);
    }
  }, [syncLogsPage]);

  /**
   * One page of contacts, filtered and sorted by the database.
   *
   * Goes through /api/contacts rather than querying Supabase from the browser, because
   * that route already parses and whitelists every filter, sort key and page bound.
   */
  const loadContacts = React.useCallback(async () => {
    if (!hasSupabaseConfig) {
      setContacts([]);
      setContactsTotal(0);
      setIsContactsLoading(false);
      return;
    }

    setIsContactsLoading(true);

    try {
      const params = new URLSearchParams(contactQuery);
      params.set('page', String(contactsPage));
      params.set('pageSize', String(contactsPageSize));

      const response = await fetch(`/api/contacts?${params.toString()}`);

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Could not load contacts (HTTP ${response.status})`);
      }

      const body = await response.json();
      const rows = (body.contacts ?? []) as DbContact[];
      const servicesByContact = await fetchServicesForContacts(rows.map((row) => row.id));

      setContacts(rows.map((row) => formatContactFromDatabase(row, servicesByContact.get(row.id) ?? [])));
      setContactsTotal(body.total ?? 0);
    } catch (error) {
      console.error('Failed to load contacts', error);
      setContacts([]);
      setContactsTotal(0);
      setConnectionError(`Could not load contacts: ${getErrorMessage(error)}`);
    } finally {
      setIsContactsLoading(false);
    }
  }, [contactQuery, contactsPage, contactsPageSize]);

  /** Re-reads everything a write can have changed. */
  const refreshData = React.useCallback(async () => {
    await Promise.all([loadLiveData(), loadContacts(), loadStats(), loadSyncLogs()]);
  }, [loadLiveData, loadContacts, loadStats, loadSyncLogs]);

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

    setSyncLogsTotal((prev) => prev + 1);

    // Only the first page shows the newest entry; prepending onto a later page would
    // put a row on a page it does not belong to.
    if (syncLogsPage === 1) {
      setSyncLogs((prev) => [log, ...prev].slice(0, SYNC_LOG_PAGE_SIZE));
    }

    return log;
  }, [syncLogsPage]);

  const processImportFile = async (file: File) => {

    setImportFile({ name: file.name, size: file.size });
    setIsImporting(true);
    setImportProgress(0);
    setIsMapped(false);
    setShowPreview(false);
    setAmbiguousHeaders([]);
    setCommonTags([]);

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

      // First guess only -- the mapping screen below is where it gets confirmed.
      const { mapping, ambiguous } = analyseHeaders(data.headers);
      setColumnMapping(mapping);
      setAmbiguousHeaders(ambiguous);
      setIsMapped(true);
    } catch (err) {
      alert(`Error parsing spreadsheet: ${getErrorMessage(err)}`);
      setImportFile(null);
    } finally {
      setIsImporting(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await processImportFile(file);
    e.target.value = '';
  };

  // Mapped once per mapping change, so the change preview below is not re-requested on
  // every render.
  // Common tags are part of the input: changing them yields a new previewImport, which
  // ImportChangePreview treats as "the import changed" and re-previews.
  const mappedImportRows = React.useMemo(
    () => mapAndValidateRows(rawRows, columnMapping, { commonTags }),
    [rawRows, columnMapping, commonTags]
  );

  /** What the import would change, computed by the database without writing (P3). */
  const previewImport = useCallback(
    () => previewContactImport(getSupabaseClient(), mappedImportRows),
    [mappedImportRows]
  );

  /**
   * Commits the import against the preview the operator just read. Errors are rethrown
   * for the preview panel, which keeps the upload and mapping in place and, for a stale
   * preview, shows a fresh one.
   */
  const commitImport = useCallback(
    async (previewToken: string) => {
      const result = await importContacts(getSupabaseClient(), mappedImportRows, previewToken);

      await refreshData();

      const summary = [
        `${result.inserted} added`,
        `${result.updated} updated`,
        result.skipped > 0 ? `${result.skipped} skipped` : null,
        (result.duplicates ?? 0) > 0 ? `${result.duplicates} repeated in the file` : null,
        // Named rather than folded into "skipped": these rows were understood and
        // deliberately held back, and somebody has to go and look at them.
        result.archived_collisions > 0 ? `${result.archived_collisions} already archived` : null,
      ]
        .filter(Boolean)
        .join(', ');

      alert(
        result.archived_collisions > 0
          ? `Import complete: ${summary}.

${result.archived_collisions} row(s) match a contact in the archive and were not imported — importing them would create a duplicate and restore email consent they had withdrawn. Restore them from Archive if they should come back.`
          : `Import complete: ${summary}.`
      );

      setImportFile(null);
      setRawHeaders([]);
      setRawRows([]);
      setShowPreview(false);
      setIsMapped(false);
      setAmbiguousHeaders([]);
      setCommonTags([]);
      setCurrentView('contacts');
    },
    [mappedImportRows, refreshData]
  );

  // Fetch Database Entities
  useEffect(() => {
    // Initial load synchronizes the client shell with Supabase on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadLiveData();
  }, [loadLiveData]);

  // Each of these re-runs on its own dependencies — the contact list when a filter,
  // sort or page changes, the timeline when its page does — so paging one does not
  // re-fetch the rest of the screen.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadContacts();
  }, [loadContacts]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadStats();
  }, [loadStats]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadSyncLogs();
  }, [loadSyncLogs]);

  // Dashboard Totals — counted in the database by loadStats. Counting the loaded rows
  // would report the size of the current page rather than of the CRM.
  const {
    total: totalContactsCount,
    customers: customersCount,
    prospects: prospectsCount,
    subscribers: newsletterSubscribersCount,
    programSubscribers: programSubscribersCount,
  } = stats;

  // Sorting Handler
  const handleSort = (key: string) => {
    setSortDir((prev) => (sortKey === key && prev === 'asc' ? 'desc' : 'asc'));
    setSortKey(key);
    setContactsPage(1);
  };

  // Selection handlers. New sets rather than mutation, so React sees the change.
  const clearContactSelection = useCallback(() => {
    setSelectedContactIds((prev) => (prev.size === 0 ? prev : new Set<string>()));
  }, []);

  const handleToggleContact = useCallback((id: string, selected: boolean) => {
    setSelectedContactIds((prev) => {
      const next = new Set(prev);
      if (selected) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const handleTogglePage = useCallback((ids: string[], selected: boolean) => {
    setSelectedContactIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => (selected ? next.add(id) : next.delete(id)));
      return next;
    });
  }, []);

  // Ordered for the export form; the Set is what the table renders from.
  const selectedContactIdList = React.useMemo(
    () => [...selectedContactIds],
    [selectedContactIds]
  );

  // Filter handlers. Each returns to page 1: a filter applied while on page 7 would
  // otherwise request a page the narrowed result set may not have. Each also drops the
  // selection, because the export applies the active filters — a row ticked under the
  // old filters would silently not be exported under the new ones.
  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    setContactsPage(1);
    clearContactSelection();
  };

  const handleStatusChange = (value: StatusFilter) => {
    setStatusFilter(value);
    setContactsPage(1);
    clearContactSelection();
  };

  const handleJobTypeChange = (value: string) => {
    setJobTypeFilter(value);
    setContactsPage(1);
    clearContactSelection();
  };

  const handleStateChange = (value: string) => {
    setStateFilter(value);
    setContactsPage(1);
    clearContactSelection();
  };

  const handleTagFilterChange = (tags: TagOption[]) => {
    setTagFilter(tags);
    setContactsPage(1);
    clearContactSelection();
  };

  const handleOrganisationFilterChange = (organisation: OrganisationOption | null) => {
    setOrganisationFilter(organisation);
    setContactsPage(1);
    clearContactSelection();
  };

  const handleIndustryFilterChange = (value: string) => {
    setIndustryFilter(value);
    setContactsPage(1);
    clearContactSelection();
  };

  // Save / Update / Insert Contact Handler
  /**
   * Saves through one server call that commits the contact, its organisation and its
   * services together, or nothing at all (audit H8). An update names the revision it
   * was edited from, so a concurrent edit is refused rather than overwritten. Errors are
   * rethrown for the drawer, which keeps the draft open and shows the message.
   */
  const handleSaveContact = async (data: ContactSavePayload) => {
    const { id, revision, ...fields } = data;
    const response = await fetch(id ? `/api/contacts/${id}` : '/api/contacts', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...fields, ...(id ? { expectedRevision: revision } : {}) }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Could not save this contact (HTTP ${response.status}).`);
    }

    await refreshData();
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

      await refreshData();
    } catch (err) {
      console.error('Failed to archive contact', err);
      alert(`Failed to archive contact: ${getErrorMessage(err)}`);
      throw err;
    }
  };

  // Remove Contact Handler
  //
  // A soft delete as well: the contact is archived and hidden everywhere, the archive
  // included, but the row and its history stay. Errors are rethrown for the drawer's
  // confirmation dialog to show, rather than alerted.
  const handleRemoveContact = async (id: string) => {
    await requestLifecycle(`/api/contacts/${id}`, 'remove');
    await refreshData();
  };

  const handleManualSync = async () => {
    setIsSyncing(true);
    try {
      // No contact list: the browser only holds the page on screen, so the route reads
      // the full book server-side. Sending contacts.map(...) here would have quietly
      // synced one page and reported it as a complete run.
      let offset = 0;
      let syncedCount = 0;
      let errorsCount = 0;

      let syncCompleted = false;

      for (let chunk = 0; chunk < 1000; chunk += 1) {
        const response = await fetch('/api/integrations/emailoctopus/sync', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ offset }),
        });

        const result = await response.json();

        if (!response.ok || !result.success) {
          throw new Error(result.message || result.error || 'Unknown error');
        }

        syncedCount += Number(result.syncedCount) || 0;
        errorsCount += Number(result.errorsCount) || 0;

        if (!result.hasMore) {
          syncCompleted = true;
          break;
        }
        if (!Number.isInteger(result.nextOffset) || result.nextOffset <= offset) {
          throw new Error('EmailOctopus sync returned an invalid continuation cursor.');
        }
        offset = result.nextOffset;
      }

      if (!syncCompleted) {
        throw new Error('EmailOctopus sync exceeded the maximum number of chunks.');
      }

      await recordSyncLog(
        `Sync completed: ${syncedCount} subscribers synced${errorsCount ? `, ${errorsCount} failed` : ''}`,
        errorsCount ? 'failed' : 'success'
      );
      alert(errorsCount ? 'Sync completed with some failures.' : 'Sync completed successfully!');
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

  const checkEmailOctopus = useCallback(async () => {
    setEmailOctopusHealth({ status: 'checking', missing: [] });

    try {
      const response = await fetch('/api/integrations/emailoctopus/fields');
      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || 'Could not validate the EmailOctopus list.');
      }

      const missing = Array.isArray(result.missing) ? result.missing : [];
      setEmailOctopusHealth({
        status: result.ready ? 'ready' : 'needs_fields',
        missing,
      });
    } catch (error) {
      console.error('EmailOctopus connection check failed:', error);
      setEmailOctopusHealth({ status: 'error', missing: [] });
    }
  }, []);

  useEffect(() => {
    if (currentView !== 'integrations') return;

    if (!isEmailOctopusConfigured) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void checkEmailOctopus();
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [checkEmailOctopus, currentView, isEmailOctopusConfigured]);

  const prepareEmailOctopusFields = async () => {
    setIsPreparingEmailOctopus(true);

    try {
      const response = await fetch('/api/integrations/emailoctopus/fields', { method: 'POST' });
      const result = await response.json().catch(() => ({}));

      if (!response.ok || (Array.isArray(result.failed) && result.failed.length > 0)) {
        throw new Error(result.error || 'Some EmailOctopus fields could not be created.');
      }

      await checkEmailOctopus();
    } catch (error) {
      console.error('EmailOctopus field setup failed:', error);
      alert(`Field setup failed: ${getErrorMessage(error)}`);
    } finally {
      setIsPreparingEmailOctopus(false);
    }
  };

  return (
    <div className={styles.appContainer}>
      <div className={styles.gridOverlay} />
      <div className={styles.ambientBlur1} />
      <div className={styles.ambientBlur2} />
      <div className={styles.ambientBlur3} />
      
      {/* Navigation Sidebar */}
      <Sidebar
        currentView={currentView}
        onViewChange={(view) => {
          // A campaign handed over by the Content Studio opens once; navigating by hand
          // afterwards must not reopen it.
          setCampaignToOpen(undefined);
          setCurrentView(view);
        }}
        badges={{ campaigns: awaitingApproval }}
      />

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
                  status: 'prospect',
                  isCustomer: false,
                  subscribedToNewsletter: false,
                  subscribedToPrograms: false,
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
              programSubscribers={programSubscribersCount}
            />

            <FilterBar
              searchQuery={searchQuery}
              onSearchChange={handleSearchChange}
              statusFilter={statusFilter}
              onStatusChange={handleStatusChange}
              jobTypes={jobTypes}
              jobTypeFilter={jobTypeFilter}
              onJobTypeChange={handleJobTypeChange}
              stateFilter={stateFilter}
              onStateChange={handleStateChange}
              exportQuery={exportQuery}
              resultCount={contactsTotal}
              selectedIds={selectedContactIdList}
              onClearSelection={clearContactSelection}
              tagFilter={tagFilter}
              onTagFilterChange={handleTagFilterChange}
              organisationFilter={organisationFilter}
              onOrganisationFilterChange={handleOrganisationFilterChange}
              industryFilter={industryFilter}
              onIndustryFilterChange={handleIndustryFilterChange}
              filterOptionsVersion={filterOptionsVersion}
            />

            {/* The selection is kept after tagging: the user may add a second set of
                tags to the same people, and clearing it is one click away. */}
            <BulkTagActions selectedIds={selectedContactIdList} onApplied={() => void refreshData()} />

            {/* Contacts Table layout */}
            <ContactTable
              contacts={contacts}
              onSelectContact={setSelectedContact}
              onSort={handleSort}
              sortKey={sortKey}
              sortDir={sortDir}
              isLoading={isContactsLoading}
              selectedIds={selectedContactIds}
              onToggleRow={handleToggleContact}
              onTogglePage={handleTogglePage}
            />

            <Pagination
              page={contactsPage}
              pageSize={contactsPageSize}
              total={contactsTotal}
              shown={contacts.length}
              onPageChange={setContactsPage}
              onPageSizeChange={(size) => {
                setContactsPageSize(size);
                setContactsPage(1);
              }}
              label="contacts"
              isLoading={isContactsLoading}
              testId="contacts-pagination"
            />

          </>
        )}

        {currentView === 'archive' && (
          <>
            <header className={styles.headerSection}>
              <div className={styles.titleGroup}>
                <div className={styles.eyebrow}>
                  <span className={styles.eyebrowDot} />
                  Retained Records
                </div>
                <h1 className={styles.pageTitle}>Archive</h1>
                <span className={styles.pageSubtitle}>
                  Archived records are kept and can be restored. Removing one takes it out of the
                  CRM for good, but nothing is ever deleted.
                </span>
              </div>
            </header>

            <ArchiveHub />
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

            <MarketingView jobTypes={jobTypes} initialCampaignId={campaignToOpen} />
            <NewsletterSchedules />
          </>
        )}

        {currentView === 'content' && (
          <>
            <header className={styles.headerSection}>
              <div className={styles.titleGroup}>
                <div className={styles.eyebrow}>
                  <span className={styles.eyebrowDot} />
                  Content
                </div>
                <h1 className={styles.pageTitle}>Content Studio</h1>
                <span className={styles.pageSubtitle}>
                  Write once for social and email. Every channel is reviewed and approved on its own.
                </span>
              </div>
            </header>

            <ContentStudioView
              onOpenSettings={() => setCurrentView('settings')}
              onOpenCampaign={(campaignId) => {
                setCampaignToOpen(campaignId);
                setCurrentView('campaigns');
              }}
            />
          </>
        )}

        {currentView === 'bookings' && (
          <>
            <header className={styles.headerSection}>
              <div className={styles.titleGroup}>
                <div className={styles.eyebrow}>
                  <span className={styles.eyebrowDot} />
                  Consultations
                </div>
                <h1 className={styles.pageTitle}>Consultation bookings</h1>
                <span className={styles.pageSubtitle}>
                  Every booking link a campaign sent, and how far each one got — from
                  the $500 consultation claimed at $0 through to a scheduled time.
                </span>
              </div>
            </header>

            <BookingsView />
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
                <h1 className={styles.pageTitle}>Spreadsheet importer</h1>
                <span className={styles.pageSubtitle}>Upload client list files to ingest data records into the database.</span>
              </div>
            </header>

            <div className={styles.splitLayout}>
              <div className={styles.sectionIntro} style={{ padding: '12px' }}>
                <h3 className={styles.sectionIntroTitle}>Data Ingestion Panel</h3>
                <p className={styles.sectionIntroDesc}>
                  Upload spreadsheets (`.xls`, `.xlsx`, `.csv` or Apple `.numbers`) to import contact profiles, resolve company associations, and sync newsletter subscriptions.
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
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        fileInputRef.current?.click();
                      }
                    }}
                    onDragEnter={(event) => {
                      event.preventDefault();
                      setIsFileDragActive(true);
                    }}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'copy';
                      setIsFileDragActive(true);
                    }}
                    onDragLeave={(event) => {
                      if (event.currentTarget === event.target) setIsFileDragActive(false);
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      setIsFileDragActive(false);
                      const file = event.dataTransfer.files?.[0];
                      if (file) void processImportFile(file);
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label="Choose or drop a spreadsheet file"
                    data-drag-active={isFileDragActive ? 'true' : 'false'}
                    style={{
                      cursor: 'pointer',
                      outline: isFileDragActive ? '2px solid var(--primary)' : undefined,
                      outlineOffset: isFileDragActive ? '4px' : undefined,
                    }}
                  >
                    <input 
                      data-testid="excel-file-input"
                      type="file" 
                      ref={fileInputRef} 
                      style={{ display: 'none' }} 
                      accept=".xlsx,.xlsm,.xls,.csv,.tsv,.numbers"
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
                        <h4 style={{ color: 'var(--text-primary)', marginBottom: '6px', fontSize: '1rem', fontWeight: 600 }}>Drag and drop a spreadsheet here</h4>
                        <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>Excel (.xls, .xlsx), CSV or Apple Numbers (.numbers)</span>
                      </div>
                    </div>
                  </div>
                )}

                {!importFile && !isImporting && <ImportRequirements label="Which columns do I need?" />}

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
                          <ImportRequirements />
                        </div>
                        <button 
                          style={{ fontSize: '0.8rem', color: 'var(--danger)', fontWeight: 600, border: 'none', background: 'none', cursor: 'pointer' }}
                          onClick={() => {
                            setImportFile(null);
                            setIsMapped(false);
                            setAmbiguousHeaders([]);
                            setCommonTags([]);
                          }}
                        >
                          Reset File
                        </button>
                      </div>

                      <ImportMappingStatus
                        mapping={columnMapping}
                        ambiguous={ambiguousHeaders}
                        onMapColumn={(field, header) =>
                          setColumnMapping((prev) => ({ ...prev, [field]: header }))
                        }
                      />

                      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '20px' }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid var(--border)' }}>
                            <th style={{ textAlign: 'left', padding: '8px 12px', fontSize: '0.72rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>CRM field</th>
                            <th style={{ textAlign: 'left', padding: '8px 12px', fontSize: '0.72rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Spreadsheet column</th>
                          </tr>
                        </thead>
                        <tbody>
                          {CRM_FIELDS.map((field) => (
                            <tr key={field.key} style={{ borderBottom: '1px solid rgba(34, 38, 43, 0.05)' }}>
                              <td style={{ padding: '12px' }}>
                                <div style={{ fontSize: '0.88rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                                  {field.label}
                                  {field.requirement && (
                                    <span className={styles.requirementBadge}>{field.requirement}</span>
                                  )}
                                </div>
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

                      <ImportCommonTags value={commonTags} onChange={setCommonTags} />

                      <button 
                        className={styles.actionButton} 
                        style={{ width: '100%', justifyContent: 'center' }}
                        disabled={!isMappingComplete(columnMapping)}
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
                        const mapped = mappedImportRows;
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

                            {validRows.length > 0 ? (
                              <ImportChangePreview
                                rows={mapped}
                                onPreview={previewImport}
                                onCommit={commitImport}
                              />
                            ) : (
                              <p className={styles.settingDescription}>No valid rows to import.</p>
                            )}
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
                    <div className={`${styles.statusDot} ${emailOctopusHealth.status === 'ready' ? styles.statusActive : styles.statusIdle}`} />
                  </div>
                  <span className={statsStyles.value} style={{ fontSize: '1.8rem' }}>
                    {emailOctopusHealth.status === 'ready'
                      ? 'Ready'
                      : emailOctopusHealth.status === 'needs_fields'
                        ? 'Setup required'
                        : emailOctopusHealth.status === 'checking'
                          ? 'Checking'
                          : isEmailOctopusConfigured
                            ? 'Connection failed'
                            : 'Not configured'}
                  </span>
                  <div className={statsStyles.trend}>
                    <span className={emailOctopusHealth.status === 'ready' ? statsStyles.trendPositive : statsStyles.trendNeutral}>
                      {emailOctopusHealth.status === 'ready'
                        ? 'List and campaign merge fields verified'
                        : emailOctopusHealth.status === 'needs_fields'
                          ? `${emailOctopusHealth.missing.length} required merge fields missing`
                          : isEmailOctopusConfigured
                            ? 'Saved credentials could not validate the list'
                            : 'Requires API key and list ID'}
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
                  On-demand sync pushes newsletter contacts to EmailOctopus. Subscriber webhooks import new website signups when the website and EmailOctopus are configured to call this CRM.
                </p>
                <div className={styles.statusCard} style={{ marginTop: '12px' }}>
                  <div className={styles.statusHeader}>
                    <span className={`${styles.statusDot} ${emailOctopusHealth.status === 'ready' ? styles.statusActive : styles.statusIdle}`} />
                    <span className={styles.settingLabel} style={{ marginBottom: 0 }}>Sync Engine Status</span>
                  </div>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', lineHeight: '1.5' }}>
                    {emailOctopusHealth.status === 'ready'
                      ? 'Ready. The list exists and every campaign merge field is available.'
                      : emailOctopusHealth.status === 'needs_fields'
                        ? `Connected, but missing: ${emailOctopusHealth.missing.join(', ')}.`
                        : emailOctopusHealth.status === 'checking'
                          ? 'Validating the saved API key, list and merge fields.'
                          : isEmailOctopusConfigured
                            ? 'The saved API key or list ID could not be validated.'
                            : 'Configure the API key and list ID in Settings.'}
                  </p>
                  {emailOctopusHealth.status === 'needs_fields' && (
                    <button
                      className={styles.actionButton}
                      style={{ marginTop: '16px', width: '100%', justifyContent: 'center' }}
                      onClick={prepareEmailOctopusFields}
                      disabled={isPreparingEmailOctopus}
                    >
                      {isPreparingEmailOctopus ? 'Creating fields...' : 'Create missing fields'}
                    </button>
                  )}
                  <button 
                    className={styles.actionButton} 
                    style={{ marginTop: '16px', width: '100%', justifyContent: 'center' }}
                    onClick={() => {
                      if (!isEmailOctopusReachable) {
                        alert('Validate the EmailOctopus API key and List ID before syncing.');
                        return;
                      }
                      handleManualSync();
                    }}
                    disabled={isSyncing || !isEmailOctopusReachable}
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

                  <Pagination
                    page={syncLogsPage}
                    pageSize={SYNC_LOG_PAGE_SIZE}
                    total={syncLogsTotal}
                    shown={syncLogs.length}
                    onPageChange={setSyncLogsPage}
                    label="sync events"
                    testId="sync-logs-pagination"
                  />
                </div>
              </div>
            </div>

            {/* Named automations. EmailOctopus publishes no endpoint that lists them,
                so this registry is the only place a name can come from. */}
            <div style={{ marginTop: '32px' }}>
              <EmailTemplateRegistry />
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
                <OperationsPanel />

                {/* Database Config Card */}
                <div className="outerShell">
                  <div className="innerCore" style={{ padding: '24px' }}>
                    <div className={styles.sectionTitle} style={{ margin: 0, borderBottom: '1px dashed var(--border)', paddingBottom: '12px', marginBottom: '20px' }}>Database Config</div>
                    
                    <div className={styles.settingGroup}>
                      <label className={styles.settingLabel} htmlFor="supabase-endpoint">Supabase Endpoint URL</label>
                      <input 
                        type="text" 
                        className={styles.searchInput} 
                        style={{ maxWidth: '100%', marginTop: '6px' }}
                        placeholder="https://your-project-id.supabase.co" 
                        id="supabase-endpoint"
                        defaultValue={process.env.NEXT_PUBLIC_SUPABASE_URL || ''}
                        readOnly
                      />
                      <span className={styles.settingDescription}>Read from NEXT_PUBLIC_SUPABASE_URL.</span>
                    </div>

                    <div className={styles.settingGroup} style={{ marginBottom: 0 }}>
                      <label className={styles.settingLabel} htmlFor="supabase-anon-key">Supabase Anon Key</label>
                      <input 
                        type="password" 
                        className={styles.searchInput} 
                        style={{ maxWidth: '100%', marginTop: '6px' }}
                        placeholder="your-supabase-anon-key" 
                        id="supabase-anon-key"
                        defaultValue={process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? 'Configured in environment' : 'Not configured'}
                        readOnly
                      />
                      <span className={styles.settingDescription}>Read from NEXT_PUBLIC_SUPABASE_ANON_KEY.</span>
                    </div>
                  </div>
                </div>

                {/* Email Marketing Card */}
                <EmailOctopusSettings status={emailOctopusStatus} onSaved={setEmailOctopusStatus} />

                {/* Connect/disconnect is admin-only on the server; the component shows the reason if refused. */}
                <SocialConnectionsSettings allowMock={process.env.NODE_ENV !== 'production'} />

                {/* Grounds every Content Studio generation; admin-only edits, enforced in the database. */}
                <BrandProfileSettings />

                <JobTypesSettings onChanged={() => void reloadJobTypes()} />

                <OrganisationSettings
                  onChanged={() => {
                    setFilterOptionsVersion((version) => version + 1);
                    void loadContacts();
                  }}
                />
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
        onRemove={handleRemoveContact}
        availableServices={services}
        jobTypes={jobTypes}
        onManageJobTypes={() => setIsJobTypesOpen(true)}
        isSuspended={isJobTypesOpen}
      />

      {isJobTypesOpen && (
        <JobTypesDialog
          onClose={() => setIsJobTypesOpen(false)}
          onChanged={() => void reloadJobTypes()}
        />
      )}
    </div>
  );
}
