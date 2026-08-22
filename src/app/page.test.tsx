import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Home from './page';

jest.mock('@/lib/supabaseClient', () => {
  let credentialsStore: Array<{ key: string; value: string }> = [];
  let syncLogs: Array<{ id: string; event_text: string; status: string; created_at: string }> = [];
  let logCounter = 0;

  // Three active contacts, so the dashboard counters have a value that cannot have
  // come from the (differently sized) page of contacts the API serves.
  const activeContacts = [
    { id: 'a1', subscribed_to_newsletter: true },
    { id: 'a2', subscribed_to_newsletter: true },
    { id: 'a3', subscribed_to_newsletter: true },
  ];

  const tableData = (table: string) => {
    if (table === 'credentials') return credentialsStore;
    if (table === 'sync_logs') return syncLogs;
    if (table === 'active_contacts') return activeContacts;
    return [];
  };

  /**
   * Chainable stand-in for a PostgREST query.
   *
   * Every list read is bounded now, so the double has to accept the bounding calls
   * (`range`, `limit`, `in`, `eq`) and still resolve like a response — including the
   * `count` the pagers read.
   */
  const queryResult = (data: unknown) => {
    const rows = Array.isArray(data) ? data : [];
    const result = { data, error: null, count: rows.length };

    const builder: Record<string, unknown> = {
      maybeSingle: jest.fn(() => Promise.resolve({ data: rows[0] ?? null, error: null })),
      single: jest.fn(() => Promise.resolve({ data: rows[0] ?? null, error: null })),
      then: (
        resolve: (value: { data: unknown; error: null; count: number }) => unknown,
        reject?: (reason: unknown) => unknown
      ) => Promise.resolve(result).then(resolve, reject),
    };

    ['eq', 'is', 'in', 'not', 'or', 'ilike', 'order', 'range', 'limit'].forEach((method) => {
      builder[method] = jest.fn(() => builder);
    });

    return builder;
  };

  const supabaseClient = {
    from: jest.fn((table: string) => ({
      select: jest.fn(() => queryResult(tableData(table))),
      upsert: jest.fn((records: Array<{ key: string; value: string }>) => {
        if (table === 'credentials') {
          records.forEach((record) => {
            credentialsStore = credentialsStore.filter((item) => item.key !== record.key);
            credentialsStore.push(record);
          });
        }
        return Promise.resolve({ data: null, error: null });
      }),
      insert: jest.fn((record: Record<string, unknown>) => ({
        select: jest.fn(() => ({
          single: jest.fn(() => {
            if (table === 'sync_logs') {
              const log = {
                id: `test-log-${++logCounter}`,
                event_text: String(record.event_text || ''),
                status: String(record.status || ''),
                created_at: new Date().toISOString(),
              };
              syncLogs = [log, ...syncLogs];
              return Promise.resolve({ data: log, error: null });
            }
            return Promise.resolve({ data: { id: 'test-id', ...record }, error: null });
          }),
        })),
      })),
      update: jest.fn(() => ({ eq: jest.fn(() => Promise.resolve({ data: null, error: null })) })),
      delete: jest.fn(() => ({ eq: jest.fn(() => Promise.resolve({ data: null, error: null })) })),
    })),
  };

  return {
    hasSupabaseConfig: true,
    getSupabaseClient: () => supabaseClient,
    __resetSupabaseMock: () => {
      credentialsStore = [];
      syncLogs = [];
      logCounter = 0;
      supabaseClient.from.mockClear();
    },
  };
});

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// Mock window.alert to prevent warnings/crashes in test run
global.alert = jest.fn();

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: () => Promise.resolve(body) };
}

const parsedSpreadsheet = {
  headers: ['Excel Full Name', 'Excel Email Address', 'Excel Company', 'Excel Role'],
  rows: [
    {
      'Excel Full Name': 'Emil Kowalski',
      'Excel Email Address': 'emil@kowalski.design',
      'Excel Company': 'Animations Dev',
      'Excel Role': 'Chief Architect',
    },
    {
      'Excel Full Name': 'Jane Doe',
      'Excel Email Address': 'invalid-email',
      'Excel Company': 'Beta Ltd',
      'Excel Role': 'Designer',
    },
  ],
};

/**
 * Serves each endpoint by URL, with per-test overrides.
 *
 * The page fetches its contact page on mount, so responses have to be addressed rather
 * than queued — a bare mockResolvedValueOnce would be swallowed by that first request.
 */
function routeFetch(overrides: Record<string, unknown> = {}) {
  mockFetch.mockImplementation(async (url: string) => {
    for (const [pattern, response] of Object.entries(overrides)) {
      if (String(url).startsWith(pattern)) return response;
    }

    if (String(url).startsWith('/api/contacts')) {
      return jsonResponse({ contacts: [], total: 0, page: 1, pageSize: 50, hasMore: false });
    }

    return jsonResponse(parsedSpreadsheet);
  });
}

describe('Home Page & Excel Importer UI Integration Tests', () => {
  const { __resetSupabaseMock } = jest.requireMock('@/lib/supabaseClient');

  beforeEach(() => {
    jest.clearAllMocks();
    __resetSupabaseMock();
    routeFetch();
  });

  it('renders dashboard overview by default', () => {
    render(<Home />);
    expect(screen.getByRole('heading', { name: /dashboard overview/i })).toBeInTheDocument();
  });

  it('navigates to spreadsheet import view and displays file dropzone', async () => {
    render(<Home />);
    
    // Click on Spreadsheet Tools / Excel Import tab
    const importTab = screen.getByTestId('nav-item-imports');
    fireEvent.click(importTab);

    // Verify Importer page heading
    expect(screen.getByText('Excel spreadsheet importer')).toBeInTheDocument();
    
    // Verify dropzone title
    expect(screen.getByText('Drag and drop XLS files here')).toBeInTheDocument();
  });

  it('simulates file upload, triggers API request, and displays column mapper with auto-selection heuristics', async () => {
    render(<Home />);
    
    // Go to import tab
    fireEvent.click(screen.getByTestId('nav-item-imports'));

    // Find the file input in the DOM
    const fileInput = screen.getByTestId('excel-file-input') as HTMLInputElement;
    
    // Create a mock file
    const file = new File(['mock-excel-binary-data'], 'Leads.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    // Fire file change event
    fireEvent.change(fileInput, { target: { files: [file] } });

    // Verify API is called with Form Data
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/import/parse', expect.any(Object));
    });

    // Verify Mapping UI headers and auto-mapping selections with waitFor
    await waitFor(() => {
      expect(screen.getByText('File Uploaded: Leads.xlsx')).toBeInTheDocument();
      expect(screen.getByText('Excel Column Header')).toBeInTheDocument();
      expect(screen.getByText('Maps to CRM Field')).toBeInTheDocument();
      
      const emailSelect = screen.getByTestId('mapping-select-email') as HTMLSelectElement;
      expect(emailSelect.value).toBe('Excel Email Address');

      const nameSelect = screen.getByTestId('mapping-select-fullName') as HTMLSelectElement;
      expect(nameSelect.value).toBe('Excel Full Name');
    });
  });

  it('renders validation preview dividing valid and invalid rows based on mapping', async () => {
    render(<Home />);
    
    // Go to import tab, select file
    fireEvent.click(screen.getByTestId('nav-item-imports'));
    const fileInput = screen.getByTestId('excel-file-input');
    const file = new File(['mock-data'], 'Leads.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    // Wait for mapping page
    await screen.findByText('File Uploaded: Leads.xlsx');

    // Click "Ingest Data Preview"
    const previewBtn = screen.getByRole('button', { name: /preview validation/i });
    fireEvent.click(previewBtn);

    // Verify Valid / Invalid section headers
    expect(screen.getByText('Validation Summary')).toBeInTheDocument();
    expect(screen.getByText('Valid Contacts (1)')).toBeInTheDocument();
    expect(screen.getByText('Invalid Contacts (1)')).toBeInTheDocument();

    // Verify errors are visually flagged
    expect(screen.getByText('Invalid Email address format')).toBeInTheDocument();
  });

  it('saves EmailOctopus credentials and triggers manual sync', async () => {
    routeFetch({
      '/api/integrations/emailoctopus/sync': jsonResponse({
        success: true,
        syncedCount: 3,
        errorsCount: 0,
      }),
    });

    render(<Home />);

    // 1. Go to settings
    fireEvent.click(screen.getByTestId('nav-item-settings'));
    expect(screen.getByRole('heading', { name: /system settings/i })).toBeInTheDocument();

    // 2. Input credentials
    const apiKeyInput = screen.getByPlaceholderText('your-emailoctopus-api-key') as HTMLInputElement;
    const listIdInput = screen.getByPlaceholderText('your-emailoctopus-list-id') as HTMLInputElement;
    
    fireEvent.change(apiKeyInput, { target: { value: 'key-123' } });
    fireEvent.change(listIdInput, { target: { value: 'list-456' } });

    // 3. Save config
    const saveBtn = screen.getByRole('button', { name: /save config/i });
    fireEvent.click(saveBtn);

    // 4. Verify alert triggered after Supabase settings persistence
    await waitFor(() => {
      expect(global.alert).toHaveBeenCalledWith('Settings saved successfully!');
    });

    // 5. Navigate to Integrations (EmailOctopus) tab
    fireEvent.click(screen.getByTestId('nav-item-integrations'));
    
    // Connection State should now read "Connected" (since keys exist)
    await waitFor(() => {
      expect(screen.getByText('Connected')).toBeInTheDocument();
    });

    // 6. Click "Sync Now" to trigger manual synchronization
    const syncBtn = screen.getByRole('button', { name: /sync now/i });
    fireEvent.click(syncBtn);

    // Verify fetch endpoint called, with no contact list: the browser holds only the
    // page on screen, so the route reads the full book server-side.
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/integrations/emailoctopus/sync', expect.any(Object));
    });

    const syncCall = mockFetch.mock.calls.find(
      (call) => call[0] === '/api/integrations/emailoctopus/sync'
    );
    expect(JSON.parse(syncCall?.[1].body)).not.toHaveProperty('contacts');

    // Check that success notice is logged in the sync timeline
    await screen.findByText(/Sync completed: 3 subscribers/);
  });

  it('requests one bounded page of contacts rather than the whole table', async () => {
    render(<Home />);

    await waitFor(() => {
      const listCall = mockFetch.mock.calls.find((call) => String(call[0]).startsWith('/api/contacts'));
      expect(listCall).toBeDefined();

      const params = new URLSearchParams(String(listCall?.[0]).split('?')[1]);
      expect(params.get('page')).toBe('1');
      expect(params.get('pageSize')).toBe('50');
    });
  });

  it('pages through a contact list larger than one screen', async () => {
    routeFetch({
      '/api/contacts': jsonResponse({ contacts: [], total: 3482, page: 1, pageSize: 50 }),
    });

    render(<Home />);

    // waitFor on the content, not findBy on the element: the summary node exists from
    // the first paint reading "No contacts", so findByTestId resolves before the fetch
    // and the assertion races it.
    await waitFor(() =>
      expect(screen.getByTestId('contacts-pagination-summary')).toHaveTextContent(
        'Showing 1–50 of 3,482 contacts'
      )
    );

    fireEvent.click(screen.getByTestId('contacts-pagination-next'));

    await waitFor(() => {
      const pageTwo = mockFetch.mock.calls
        .map((call) => String(call[0]))
        .filter((url) => url.startsWith('/api/contacts'))
        .some((url) => new URLSearchParams(url.split('?')[1]).get('page') === '2');

      expect(pageTwo).toBe(true);
    });
  });

  it('sends filtering and sorting to the server instead of filtering the page', async () => {
    routeFetch({
      '/api/contacts': jsonResponse({ contacts: [], total: 3482, page: 1, pageSize: 50 }),
    });

    render(<Home />);

    await screen.findByTestId('contacts-pagination-next');
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'ada' } });

    await waitFor(() => {
      const searched = mockFetch.mock.calls
        .map((call) => String(call[0]))
        .filter((url) => url.startsWith('/api/contacts'))
        .some((url) => new URLSearchParams(url.split('?')[1]).get('q') === 'ada');

      expect(searched).toBe(true);
    });
  });

  it('returns to the first page when the filter changes', async () => {
    routeFetch({
      '/api/contacts': jsonResponse({ contacts: [], total: 3482, page: 1, pageSize: 50 }),
    });

    render(<Home />);

    fireEvent.click(await screen.findByTestId('contacts-pagination-next'));
    await waitFor(() =>
      expect(screen.getByTestId('contacts-pagination-position')).toHaveTextContent('Page 2')
    );

    // A filter applied from page 2 must not request a page the narrowed set may lack.
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'ada' } });

    await waitFor(() =>
      expect(screen.getByTestId('contacts-pagination-position')).toHaveTextContent('Page 1')
    );
  });

  it('counts the dashboard totals in the database, not over the loaded page', async () => {
    // The API serves a page of one contact; the counters must still report all three
    // active contacts.
    routeFetch({
      '/api/contacts': jsonResponse({
        contacts: [
          {
            id: 'a1',
            first_name: 'Ada',
            last_name: 'Lovelace',
            email: 'ada@example.com',
            subscribed_to_newsletter: true,
          },
        ],
        total: 3,
        page: 1,
        pageSize: 50,
      }),
    });

    render(<Home />);

    fireEvent.click(screen.getByTestId('nav-item-integrations'));

    expect(await screen.findByText('3 Contacts')).toBeInTheDocument();
  });

});
