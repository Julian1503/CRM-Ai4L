import { syncContactToEmailOctopus } from './emailOctopus';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe('emailOctopus - API Client Sync Wrapper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should successfully post subscription details to EmailOctopus API', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: 'octopus-contact-uuid-1', status: 'subscribed' }),
    });

    await expect(
      syncContactToEmailOctopus(
        'mock-api-key',
        'mock-list-id',
        'test@user.com',
        'Jane',
        'Doe',
        'SUBSCRIBED'
      )
    ).resolves.not.toThrow();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://emailoctopus.com/api/1.6/lists/mock-list-id/contacts',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          api_key: 'mock-api-key',
          email_address: 'test@user.com',
          fields: {
            FirstName: 'Jane',
            LastName: 'Doe',
          },
          status: 'SUBSCRIBED',
        }),
      }
    );
  });

  it('should throw an error with API error details when the endpoint returns non-200', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () =>
        Promise.resolve({
          error: {
            code: 'MEMBER_EXISTS_WITH_EMAIL_ADDRESS',
            message: 'A contact already exists with this email address.',
          },
        }),
    });

    await expect(
      syncContactToEmailOctopus(
        'mock-api-key',
        'mock-list-id',
        'test@user.com',
        'Jane',
        'Doe',
        'SUBSCRIBED'
      )
    ).rejects.toThrow('EmailOctopus API Error: A contact already exists with this email address.');
  });
});

import { POST as syncPOST } from '../app/api/integrations/emailoctopus/sync/route';

describe('EmailOctopus Sync API Route Handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should batch sync contacts list and return synced counts', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'mock-id' }),
    });

    const body = {
      apiKey: 'test-key',
      listId: 'test-list',
      contacts: [
        { email: 'user1@test.com', firstName: 'First', lastName: 'Last', subscribedToNewsletter: true },
        { email: 'user2@test.com', firstName: 'Second', lastName: 'Last', subscribedToNewsletter: false },
      ],
    };

    const req = new Request('http://localhost/api/integrations/emailoctopus/sync', {
      method: 'POST',
      body: JSON.stringify(body),
    }) as any;

    const response = await syncPOST(req);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.syncedCount).toBe(2);
    expect(data.errorsCount).toBe(0);
  });
});
