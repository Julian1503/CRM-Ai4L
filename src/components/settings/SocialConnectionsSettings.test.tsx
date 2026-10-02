import React from 'react';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import type { ListAccountsResponse, SocialAccount } from '@/lib/content-studio/types';

import SocialConnectionsSettings, { readConnectResult } from './SocialConnectionsSettings';

const mockListAccounts = jest.fn();
jest.mock('@/components/content-studio/api', () => ({
  listAccounts: () => mockListAccounts(),
  errorMessage: (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback),
}));

const ACCOUNT: SocialAccount = {
  id: 'acc-1',
  platform: 'linkedin',
  provider: 'linkedin',
  externalId: '42',
  displayName: 'AI4L',
  authorKind: 'organization',
  scopes: [],
  status: 'connected',
  lastError: null,
  healthCheckedAt: null,
  createdAt: '2026-10-07T00:00:00.000Z',
};

function respond(data: Partial<ListAccountsResponse> = {}) {
  mockListAccounts.mockResolvedValue({ accounts: [ACCOUNT], enabledPlatforms: ['facebook', 'linkedin'], ...data });
}

const fetchMock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = fetchMock as unknown as typeof fetch;
  window.history.replaceState(null, '', '/');
});

describe('readConnectResult', () => {
  it('reads the callback result without echoing anything unknown', () => {
    expect(readConnectResult('?social=connected&count=1')).toEqual({ kind: 'success', text: 'Connected 1 account.' });
    expect(readConnectResult('?social=connected&count=3')?.text).toBe('Connected 3 accounts.');
    expect(readConnectResult('?social=error&reason=invalid_state')?.text).toMatch(/expired or was already used/);
    expect(readConnectResult('?social=error&reason=<script>')?.text).toBe('The account could not be connected.');
    expect(readConnectResult('?view=settings')).toBeNull();
  });
});

describe('SocialConnectionsSettings', () => {
  it('lists accounts with platform, author kind and status', async () => {
    respond();
    render(<SocialConnectionsSettings />);

    const row = await screen.findByTestId('social-account-acc-1');
    expect(within(row).getByText('AI4L')).toBeInTheDocument();
    expect(within(row).getByText(/LinkedIn · Organisation page · Connected/)).toBeInTheDocument();
  });

  it('offers a connect form per enabled provider, with an explicit LinkedIn author choice', async () => {
    respond();
    render(<SocialConnectionsSettings />);

    const meta = await screen.findByTestId('connect-meta');
    expect(meta).toHaveAttribute('action', '/api/social/oauth/meta/start');
    expect(meta).toHaveAttribute('method', 'post');
    const linkedin = screen.getByTestId('connect-linkedin');
    expect(within(linkedin).getByLabelText('Post as')).toHaveValue('organization');
    expect(within(linkedin).getByRole('option', { name: 'My personal profile' })).toHaveValue('member');
    expect(screen.queryByTestId('connect-mock')).not.toBeInTheDocument();
  });

  it('offers the mock provider only when allowed', async () => {
    respond({ enabledPlatforms: [] });
    render(<SocialConnectionsSettings allowMock />);
    expect(await screen.findByTestId('connect-mock')).toHaveAttribute('action', '/api/social/oauth/mock/start');
  });

  it('explains when no network is enabled', async () => {
    respond({ enabledPlatforms: [], accounts: [] });
    render(<SocialConnectionsSettings />);
    expect(await screen.findByText(/No social network is enabled/)).toBeInTheDocument();
    expect(screen.getByText('No social accounts are connected yet.')).toBeInTheDocument();
  });

  it('hides the controls from someone who cannot manage accounts', async () => {
    respond();
    render(<SocialConnectionsSettings canManage={false} />);
    await screen.findByTestId('social-account-acc-1');
    expect(screen.queryByTestId('connect-meta')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Disconnect/ })).not.toBeInTheDocument();
  });

  it('disconnects only after confirmation, then reloads', async () => {
    respond();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ account: { ...ACCOUNT, status: 'disconnected' } }) });
    render(<SocialConnectionsSettings />);

    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect AI4L' }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm disconnect' }));

    await waitFor(() => expect(mockListAccounts).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenCalledWith('/api/social/accounts/acc-1', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ action: 'disconnect' }) }));
  });

  it('can cancel a disconnect', async () => {
    respond();
    render(<SocialConnectionsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect AI4L' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Disconnect AI4L' })).toBeInTheDocument();
  });

  it('shows a disconnect failure on the row', async () => {
    respond();
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'Only an administrator can do that.' }) });
    render(<SocialConnectionsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect AI4L' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm disconnect' }));
    expect(await screen.findByText('Only an administrator can do that.')).toBeInTheDocument();
  });

  it('falls back to a generic message when the failure has no body', async () => {
    respond();
    fetchMock.mockResolvedValue({ ok: false, json: async () => { throw new Error('no json'); } });
    render(<SocialConnectionsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect AI4L' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm disconnect' }));
    expect(await screen.findByText('Could not disconnect the account.')).toBeInTheDocument();
  });

  it('does not offer to disconnect an account that already is', async () => {
    respond({ accounts: [{ ...ACCOUNT, status: 'disconnected', provider: 'mock' }] });
    render(<SocialConnectionsSettings />);
    expect(await screen.findByText(/Disconnected · Test account/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Disconnect/ })).not.toBeInTheDocument();
  });

  it('shows the callback result from the URL', async () => {
    window.history.replaceState(null, '', '/?view=settings&social=error&reason=denied');
    respond();
    render(<SocialConnectionsSettings />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The connection was cancelled at the provider.');
  });

  it('shows a load error with a retry', async () => {
    mockListAccounts.mockRejectedValueOnce(new Error('Server down'));
    respond();
    render(<SocialConnectionsSettings />);
    expect(await screen.findByText(/Server down/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('social-account-acc-1')).toBeInTheDocument();
  });
});
