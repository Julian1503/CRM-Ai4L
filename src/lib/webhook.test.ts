import { POST } from '../app/api/integrations/emailoctopus/webhook/route';
import { getSupabaseClient } from './supabaseClient';

// Mock Supabase Client
jest.mock('@supabase/supabase-js', () => {
  const mockFrom = jest.fn();
  return {
    createClient: jest.fn(() => ({
      from: mockFrom,
    })),
  };
});

describe('EmailOctopus Webhook Event Handler (TDD)', () => {
  const supabase = getSupabaseClient();
  let mockUpdate: jest.Mock;
  let mockEq: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    mockUpdate = jest.fn().mockReturnThis();
    mockEq = jest.fn().mockResolvedValue({ data: null, error: null });

    const mockQueryBuilder = {
      update: mockUpdate,
      eq: mockEq,
    };

    (supabase.from as jest.Mock).mockReturnValue(mockQueryBuilder);
  });

  const createMockRequest = (body: Record<string, unknown>) => {
    // We can cast our MockRequest as Request/NextRequest directly
    return new Request('http://localhost/api/integrations/emailoctopus/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }) as Parameters<typeof POST>[0];
  };

  it('should update contact subscribed_to_newsletter to false when unsubscribe event is received', async () => {
    const payload = {
      event: 'contact.unsubscribed',
      contact: {
        email_address: 'john@doe.com',
      },
    };

    const req = createMockRequest(payload);
    const response = await POST(req);

    expect(response.status).toBe(200);
    expect(supabase.from).toHaveBeenCalledWith('contacts');
    expect(mockUpdate).toHaveBeenCalledWith({ subscribed_to_newsletter: false });
    expect(mockEq).toHaveBeenCalledWith('email', 'john@doe.com');
  });

  it('should update contact subscribed_to_newsletter to true when subscribe event is received', async () => {
    const payload = {
      event: 'contact.subscribed',
      contact: {
        email_address: 'jane@doe.com',
      },
    };

    const req = createMockRequest(payload);
    const response = await POST(req);

    expect(response.status).toBe(200);
    expect(supabase.from).toHaveBeenCalledWith('contacts');
    expect(mockUpdate).toHaveBeenCalledWith({ subscribed_to_newsletter: true });
    expect(mockEq).toHaveBeenCalledWith('email', 'jane@doe.com');
  });

  it('should return 400 bad request for invalid payload structure', async () => {
    const payload = {
      invalid_key: 'random',
    };

    const req = createMockRequest(payload);
    const response = await POST(req);

    expect(response.status).toBe(400);
  });
});
