'use client';

import React, { useId, useMemo, useState, useSyncExternalStore } from 'react';

import { errorMessage, listAccounts } from '@/components/content-studio/api';
import { useResource } from '@/components/content-studio/hooks';
import type { SocialAccount, SocialPlatform } from '@/lib/content-studio/types';

import styles from './CatalogSettings.module.css';

/**
 * Social connections (Settings). Lists the connected Facebook Pages, Instagram Business
 * accounts and LinkedIn organisations/members, and lets an administrator connect or
 * disconnect them. Connecting is a form post to /api/social/oauth/<provider>/start: the
 * browser goes to the provider's consent screen and comes back to Settings with
 * `?social=connected|error`. Tokens never reach this component.
 */

type Props = {
  /** Show connect/disconnect controls. The server enforces administrator-only anyway. */
  canManage?: boolean;
  /** Offer the fake 'mock' provider (local development and E2E only). */
  allowMock?: boolean;
};

const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
};

const AUTHOR_LABELS: Record<SocialAccount['authorKind'], string> = {
  page: 'Page',
  instagram_business: 'Business account',
  organization: 'Organisation page',
  member: 'Personal profile',
};

const STATUS_LABELS: Record<SocialAccount['status'], string> = {
  connected: 'Connected',
  needs_reauth: 'Needs reconnecting',
  disconnected: 'Disconnected',
};

const ERROR_REASONS: Record<string, string> = {
  invalid_state: 'The connection request expired or was already used. Start again.',
  denied: 'The connection was cancelled at the provider.',
  no_accounts: 'The provider returned no page or account you can post as.',
  not_authorised: 'Only an administrator can connect accounts.',
  engine_not_configured: 'The content engine is not configured.',
  engine_unreachable: 'The content engine could not be reached. Try again shortly.',
  engine_refused: 'The provider refused the connection.',
};

type Banner = { kind: 'success' | 'error'; text: string };

const noSubscription = () => () => undefined;
const readSearch = () => window.location.search;
const serverSearch = () => '';

/** Reads the `?social=` result the OAuth callback redirected back with. */
export function readConnectResult(search: string): Banner | null {
  const params = new URLSearchParams(search);
  const outcome = params.get('social');
  if (outcome === 'connected') {
    const count = Number(params.get('count') ?? '0');
    return { kind: 'success', text: `Connected ${count} account${count === 1 ? '' : 's'}.` };
  }
  if (outcome === 'error') {
    const reason = params.get('reason') ?? '';
    return { kind: 'error', text: ERROR_REASONS[reason] ?? 'The account could not be connected.' };
  }
  return null;
}

function ConnectForm({ provider, label, children }: { provider: string; label: string; children?: React.ReactNode }) {
  return (
    <form method="post" action={`/api/social/oauth/${provider}/start`} className={styles.toolbar} data-testid={`connect-${provider}`}>
      {children}
      <button type="submit" className={styles.primaryBtn}>
        {label}
      </button>
    </form>
  );
}

function LinkedInConnect() {
  const id = useId();
  return (
    <ConnectForm provider="linkedin" label="Connect LinkedIn">
      <span className={styles.fieldGroup}>
        <label htmlFor={id} className={styles.label}>
          Post as
        </label>
        <select id={id} name="authorKind" className={styles.input} defaultValue="organization">
          <option value="organization">An organisation page I administer</option>
          <option value="member">My personal profile</option>
        </select>
      </span>
    </ConnectForm>
  );
}

function AccountRow({ account, canManage, onDisconnected }: { account: SocialAccount; canManage: boolean; onDisconnected: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/social/accounts/${encodeURIComponent(account.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'disconnect' }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not disconnect the account.');
      setConfirming(false);
      onDisconnected();
    } catch (caught) {
      setError(errorMessage(caught, 'Could not disconnect the account.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={styles.row} data-testid={`social-account-${account.id}`}>
      <span className={styles.rowMain}>
        <span className={styles.rowName}>{account.displayName}</span>
        <span className={styles.rowMeta}>
          {PLATFORM_LABELS[account.platform]} · {AUTHOR_LABELS[account.authorKind]} · {STATUS_LABELS[account.status]}
          {account.provider === 'mock' ? ' · Test account' : ''}
        </span>
        {error && (
          <span className={styles.error} role="alert">
            {error}
          </span>
        )}
      </span>
      {canManage && account.status !== 'disconnected' && (
        <span className={styles.rowActions}>
          {confirming ? (
            <>
              <button type="button" className={styles.primaryBtn} onClick={disconnect} disabled={busy}>
                {busy ? 'Disconnecting…' : 'Confirm disconnect'}
              </button>
              <button type="button" className={styles.secondaryBtn} onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className={styles.linkBtn} onClick={() => setConfirming(true)} aria-label={`Disconnect ${account.displayName}`}>
              Disconnect
            </button>
          )}
        </span>
      )}
    </li>
  );
}

export default function SocialConnectionsSettings({ canManage = true, allowMock = false }: Props) {
  const titleId = useId();
  const resource = useResource(listAccounts);
  const data = resource.data;
  const loadError = resource.error ? errorMessage(resource.error, 'Could not load the social accounts.') : null;
  const reload = resource.reload;
  const search = useSyncExternalStore(noSubscription, readSearch, serverSearch);
  const banner = useMemo(() => readConnectResult(search), [search]);

  const enabled = data?.enabledPlatforms ?? [];
  const metaEnabled = enabled.includes('facebook') || enabled.includes('instagram');
  const linkedinEnabled = enabled.includes('linkedin');
  const accounts = data?.accounts ?? [];

  return (
    <section className="outerShell" aria-labelledby={titleId} data-testid="social-connections-settings">
      <div className={`innerCore ${styles.card}`}>
        <h2 id={titleId} className={styles.title}>
          Social accounts
        </h2>
        <p className={styles.intro}>
          Pages and profiles the Content Studio can publish to. Connecting opens the network&apos;s own sign-in; the
          credentials are stored encrypted and never shown here.
        </p>

        {banner && (
          <p className={banner.kind === 'error' ? styles.error : styles.success} role={banner.kind === 'error' ? 'alert' : 'status'}>
            {banner.text}
          </p>
        )}

        {loadError && (
          <p className={styles.error} role="alert">
            {loadError}{' '}
            <button type="button" className={styles.linkBtn} onClick={reload}>
              Retry
            </button>
          </p>
        )}

        <ul className={styles.list} aria-label="Connected social accounts" aria-busy={data === null && !loadError}>
          {data !== null && accounts.length === 0 && <li className={styles.empty}>No social accounts are connected yet.</li>}
          {accounts.map((account) => (
            <AccountRow key={account.id} account={account} canManage={canManage} onDisconnected={reload} />
          ))}
        </ul>

        {canManage && data !== null && (
          <div style={{ marginTop: 'var(--space-md)' }}>
            {metaEnabled && <ConnectForm provider="meta" label="Connect Facebook / Instagram" />}
            {linkedinEnabled && <LinkedInConnect />}
            {allowMock && <ConnectForm provider="mock" label="Connect test accounts (mock)" />}
            {!metaEnabled && !linkedinEnabled && !allowMock && (
              <p className={styles.intro}>No social network is enabled for publishing (CONTENT_SOCIAL_PLATFORMS).</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
