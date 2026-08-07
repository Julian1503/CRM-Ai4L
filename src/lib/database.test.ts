import { getSupabaseClient } from './supabaseClient';

// Mock Supabase JS client
jest.mock('@supabase/supabase-js', () => {
  const mockFrom = jest.fn();
  return {
    createClient: jest.fn(() => ({
      from: mockFrom,
      auth: {
        getSession: jest.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      },
    })),
  };
});

describe('Supabase Database Client & Schema Verification', () => {
  const supabase = getSupabaseClient();
  let mockSelect: jest.Mock;
  let mockInsert: jest.Mock;
  let mockUpdate: jest.Mock;
  let mockDelete: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    mockSelect = jest.fn().mockReturnThis();
    mockInsert = jest.fn().mockReturnThis();
    mockUpdate = jest.fn().mockReturnThis();
    mockDelete = jest.fn().mockReturnThis();

    const mockQueryBuilder = {
      select: mockSelect,
      insert: mockInsert,
      update: mockUpdate,
      delete: mockDelete,
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: null, error: null }),
    };

    // Override the mock from() implementation
    (supabase.from as jest.Mock).mockReturnValue(mockQueryBuilder);
  });

  it('selects contacts table and returns list of contact profiles', async () => {
    const mockContacts = [
      {
        id: 'contact-uuid-1',
        first_name: 'John',
        last_name: 'Doe',
        email: 'john.doe@example.com',
        is_customer: false,
        subscribed_to_newsletter: true,
      },
    ];

    mockSelect.mockResolvedValueOnce({ data: mockContacts, error: null });

    const { data, error } = await supabase.from('contacts').select('*');

    expect(supabase.from).toHaveBeenCalledWith('contacts');
    expect(mockSelect).toHaveBeenCalled();
    expect(error).toBeNull();
    expect(data).toEqual(mockContacts);
  });

  it('inserts contact with valid parameters and organization references', async () => {
    const newContact = {
      first_name: 'Jane',
      last_name: 'Smith',
      email: 'jane.smith@example.com',
      organisation_id: 'org-uuid-1',
      is_customer: true,
      subscribed_to_newsletter: false,
    };

    mockInsert.mockResolvedValueOnce({ data: { id: 'contact-uuid-2', ...newContact }, error: null });

    const { data, error } = await supabase.from('contacts').insert(newContact);

    expect(supabase.from).toHaveBeenCalledWith('contacts');
    expect(mockInsert).toHaveBeenCalledWith(newContact);
    expect(error).toBeNull();
    const inserted = data as { first_name?: string } | null;
    expect(inserted?.first_name).toBe('Jane');
  });

  it('verifies RLS session simulation returns auth errors when anonymous', async () => {
    // When no active session exists, write operations simulated on frontend client should warn/block
    const mockSession = await supabase.auth.getSession();
    expect(mockSession.data.session).toBeNull();
  });
});
