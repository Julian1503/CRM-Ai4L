import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Home from './page';

jest.mock('@/lib/supabaseClient', () => {
  let credentialsStore: Array<{ key: string; value: string }> = [];
  let syncLogs: Array<{ id: string; event_text: string; status: string; created_at: string }> = [];
  let logCounter = 0;

  const tableData = (table: string) => {
    if (table === 'credentials') return credentialsStore;
    if (table === 'sync_logs') return syncLogs;
    return [];
  };

  const queryResult = (data: unknown) => {
    const result = { data, error: null };
    return {
      order: jest.fn(() => Promise.resolve(result)),
      maybeSingle: jest.fn(() => Promise.resolve({ data: Array.isArray(data) ? data[0] || null : data, error: null })),
      single: jest.fn(() => Promise.resolve({ data: Array.isArray(data) ? data[0] || null : data, error: null })),
      then: (
        resolve: (value: { data: unknown; error: null }) => unknown,
        reject?: (reason: unknown) => unknown
      ) => Promise.resolve(result).then(resolve, reject),
    };
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

describe('Home Page & Excel Importer UI Integration Tests', () => {
  const { __resetSupabaseMock } = jest.requireMock('@/lib/supabaseClient');

  beforeEach(() => {
    jest.clearAllMocks();
    __resetSupabaseMock();
    
    // Set default fetch resolution for parsing
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
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
        }),
    });
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
    // Override fetch mock for sync trigger
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, syncedCount: 3, errorsCount: 0 }),
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

    // Verify fetch endpoint called
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/integrations/emailoctopus/sync', expect.any(Object));
    });

    // Check that success notice is logged in the sync timeline
    await screen.findByText(/Sync completed: 3 subscribers/);
  });
});
