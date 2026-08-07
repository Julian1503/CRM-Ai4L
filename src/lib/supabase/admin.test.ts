/**
 * @jest-environment node
 */
import { createClient } from '@supabase/supabase-js';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({ from: jest.fn() })),
}));

const mockCreateClient = createClient as jest.Mock;

const ORIGINAL_ENV = process.env;

async function loadAdminModule() {
  let mod: typeof import('./admin');
  await jest.isolateModulesAsync(async () => {
    mod = await import('./admin');
  });
  return mod!;
}

describe('supabase/admin - service-role client', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('throws a descriptive error when the service-role key is absent', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const { getAdminClient } = await loadAdminModule();

    expect(() => getAdminClient()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('throws when the Supabase URL is absent', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

    const { getAdminClient } = await loadAdminModule();

    expect(() => getAdminClient()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only service-role key as missing', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = '   ';

    const { getAdminClient } = await loadAdminModule();

    expect(() => getAdminClient()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('uses the service-role key, never the anon key', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-should-not-be-used';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

    const { getAdminClient } = await loadAdminModule();
    getAdminClient();

    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    const [url, key] = mockCreateClient.mock.calls[0];
    expect(url).toBe('https://test.supabase.co');
    expect(key).toBe('service-role-key');
    expect(key).not.toBe('anon-key-should-not-be-used');
  });

  it('disables session persistence so requests cannot inherit a user session', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

    const { getAdminClient } = await loadAdminModule();
    getAdminClient();

    const options = mockCreateClient.mock.calls[0][2];
    expect(options.auth.persistSession).toBe(false);
    expect(options.auth.autoRefreshToken).toBe(false);
    expect(options.auth.detectSessionInUrl).toBe(false);
  });
});
