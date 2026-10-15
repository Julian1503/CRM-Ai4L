import Root from './page';

jest.mock('next/navigation', () => ({
  redirect: (href: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { href });
  },
}));

async function redirectFor(params: Record<string, string | string[] | undefined>): Promise<string> {
  try {
    await Root({ searchParams: Promise.resolve(params) });
  } catch (error) {
    return (error as { href: string }).href;
  }
  throw new Error('expected a redirect');
}

describe('/ (legacy single-page addresses)', () => {
  it('opens Contacts by default', async () => {
    await expect(redirectFor({})).resolves.toBe('/contacts');
  });

  it('keeps the newsletter review email link working', async () => {
    await expect(redirectFor({ view: 'campaigns', campaign: 'c-1' })).resolves.toBe('/campaigns?campaign=c-1');
  });

  it('keeps the social OAuth callback working', async () => {
    await expect(redirectFor({ view: 'settings', social: 'connected', section: 'connections' })).resolves.toBe(
      '/settings?social=connected&section=connections'
    );
  });

  it('keeps Content Studio item links working', async () => {
    await expect(redirectFor({ view: 'content', item: 'i-1' })).resolves.toBe('/content?item=i-1');
  });

  it('sends an unknown view to Contacts', async () => {
    await expect(redirectFor({ view: 'admin' })).resolves.toBe('/contacts');
  });
});
