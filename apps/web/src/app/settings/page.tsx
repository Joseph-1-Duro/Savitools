'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { useUserPreferences } from '@/lib/preferences';
import { ShortcutBadge } from '@/components/command-palette';
import {
  beginFluxaOAuth,
  beginPasskeyRegistration,
  ConnectedAccount,
  createVaultKey,
  deleteVaultKey,
  disconnectProvider,
  listConnectedAccounts,
  listPasskeys,
  listSessions,
  listVaultKeys,
  PasskeyCredentialSummary,
  reauthenticate,
  revokePasskey,
  revokeSession,
  Session,
  verifyPasskeyRegistration,
  VaultKey,
  VaultKeyProvider,
} from '@/lib/api';


// ─── Connected Accounts ───────────────────────────────────────────────────────

function ConnectedAccountsSection() {
  const { user } = useAuth();
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const data = await listConnectedAccounts();
      setAccounts(data);
    } catch {
      // non-fatal
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { void load(); }, [load]);

  async function handleConnect() {
    setError(null);
    try {
      const { redirectUrl } = await beginFluxaOAuth();
      window.location.href = redirectUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start OAuth flow.');
    }
  }

  async function handleDisconnect(provider: string) {
    setError(null);
    try {
      await disconnectProvider(provider);
      setAccounts((prev) => prev.filter((a) => a.provider !== provider));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect.');
    }
  }

  const fluxaConnected = accounts.find((a) => a.provider === 'fluxa');

  return (
    <section className="border border-border rounded-lg p-5 space-y-4">
      <div>
        <h2 className="text-sm font-medium">Connected Accounts</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Link external accounts to use their API keys inside SaviTools tools.
        </p>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="border-t border-border pt-4 flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Fluxa</p>
          {fluxaConnected ? (
            <p className="text-xs text-muted-foreground">
              Connected{' '}
              {new Date(fluxaConnected.connectedAt).toLocaleDateString()}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">Not connected</p>
          )}
        </div>

        {fluxaConnected ? (
          <button
            onClick={() => handleDisconnect('fluxa')}
            className="rounded-md border border-border px-3 py-1.5 text-xs hover:border-destructive hover:text-destructive transition-colors"
          >
            Disconnect
          </button>
        ) : (
          <button
            onClick={handleConnect}
            disabled={!user || loading}
            className="rounded-md border border-border px-3 py-1.5 text-xs hover:border-foreground/30 transition-colors disabled:opacity-50"
          >
            Connect Fluxa
          </button>
        )}
      </div>

      {/* Legacy direct-key link (still shown when tenant ID is set via old flow) */}
      {user?.fluxaTenantId && !fluxaConnected ? (
        <p className="text-xs text-muted-foreground">
          Legacy tenant ID: <span className="font-mono">{user.fluxaTenantId}</span>
        </p>
      ) : null}
    </section>
  );
}

// ─── API Key Vault ─────────────────────────────────────────────────────────────

const VAULT_PROVIDERS: { value: VaultKeyProvider; label: string }[] = [
  { value: 'fluxa', label: 'Fluxa' },
  { value: 'crowdpay', label: 'CrowdPay' },
  { value: 'custom', label: 'Custom' },
];

function VaultSection() {
  const { user } = useAuth();
  const [keys, setKeys] = useState<VaultKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<VaultKeyProvider>('fluxa');
  const [keyValue, setKeyValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const data = await listVaultKeys();
      setKeys(data);
    } catch {
      // non-fatal
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { void load(); }, [load]);

  async function handleAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!name.trim() || !keyValue.trim()) {
      setError('Name and key are required.');
      return;
    }
    setSubmitting(true);
    try {
      const created = await createVaultKey(name.trim(), provider, keyValue.trim());
      setKeys((prev) => [created, ...prev]);
      setName('');
      setKeyValue('');
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save key.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    setError(null);
    try {
      await deleteVaultKey(id);
      setKeys((prev) => prev.filter((k) => k.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete key.');
    }
  }

  return (
    <section className="border border-border rounded-lg p-5 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-sm font-medium">API Key Vault</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Store API keys encrypted at rest. Keys are injected server-side and never exposed to
            the browser.
          </p>
        </div>
        {user ? (
          <button
            onClick={() => setShowForm((v) => !v)}
            className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs hover:border-foreground/30 transition-colors"
          >
            {showForm ? 'Cancel' : 'Add key'}
          </button>
        ) : null}
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {showForm ? (
        <form onSubmit={handleAdd} className="border-t border-border pt-4 space-y-3">
          <div className="space-y-1">
            <label htmlFor="vk-name" className="text-xs font-medium">Name</label>
            <input
              id="vk-name"
              type="text"
              placeholder="e.g. My Fluxa prod key"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="vk-provider" className="text-xs font-medium">Provider</label>
            <select
              id="vk-provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value as VaultKeyProvider)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {VAULT_PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="vk-key" className="text-xs font-medium">API key</label>
            <input
              id="vk-key"
              type="password"
              autoComplete="off"
              placeholder="Paste your API key"
              value={keyValue}
              onChange={(e) => setKeyValue(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-primary text-primary-foreground px-3 py-2 text-sm font-medium disabled:opacity-50"
          >
            {submitting ? 'Saving…' : 'Save key'}
          </button>
        </form>
      ) : null}

      {!loading && keys.length === 0 ? (
        <p className="text-sm text-muted-foreground border-t border-border pt-4">
          No keys stored yet.
        </p>
      ) : null}

      {keys.length > 0 ? (
        <ul className="border-t border-border pt-4 space-y-2">
          {keys.map((key) => (
            <li key={key.id} className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">{key.name}</p>
                <p className="text-xs text-muted-foreground capitalize">{key.provider}</p>
              </div>
              <button
                onClick={() => handleDelete(key.id)}
                className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                aria-label={`Delete ${key.name}`}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// ─── Sessions ──────────────────────────────────────────────────────────────────

function SessionsSection() {
  const { user } = useAuth();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const data = await listSessions();
      setSessions(data);
    } catch {
      // non-fatal
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { void load(); }, [load]);

  async function handleRevoke(id: string) {
    setError(null);
    try {
      await revokeSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke session.');
    }
  }

  return (
    <section className="border border-border rounded-lg p-5 space-y-4">
      <div>
        <h2 className="text-sm font-medium">Active Sessions</h2>
        <p className="text-sm text-muted-foreground mt-1">
          All devices with an active login. Revoke any session to immediately invalidate it.
        </p>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {!user ? (
        <p className="text-sm text-muted-foreground border-t border-border pt-4">
          Log in to view your sessions.
        </p>
      ) : loading ? (
        <p className="text-sm text-muted-foreground border-t border-border pt-4">
          Loading…
        </p>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground border-t border-border pt-4">
          No active sessions.
        </p>
      ) : (
        <ul className="border-t border-border pt-4 space-y-3">
          {sessions.map((session) => (
            <li key={session.id} className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm truncate">
                  {session.userAgent ?? 'Unknown device'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {session.ipAddress ?? 'Unknown IP'} ·{' '}
                  Created {new Date(session.createdAt).toLocaleString()}
                </p>
              </div>
              <button
                onClick={() => handleRevoke(session.id)}
                className="shrink-0 text-xs text-muted-foreground hover:text-destructive transition-colors"
                aria-label="Revoke session"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ─── Keyboard & Navigation Preferences ────────────────────────────────────────

function KeyboardNavigationSection() {
  const { preferences, updatePreferences } = useUserPreferences();

  return (
    <section className="border border-border rounded-lg p-5 space-y-4">
      <div>
        <h2 className="text-sm font-medium">Keyboard &amp; Navigation</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Configure keyboard-driven navigation, command palette triggers, and quick workstation shortcuts.
        </p>
      </div>

      <div className="border-t border-border pt-4 space-y-4">
        {/* Master toggle */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Enable Command Palette &amp; Shortcuts</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Allow <ShortcutBadge shortcut="Cmd+K" /> to open the command palette and enable workstation shortcuts.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={preferences.keyboardShortcutsEnabled}
            onClick={() =>
              updatePreferences({
                keyboardShortcutsEnabled: !preferences.keyboardShortcutsEnabled,
              })
            }
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
              preferences.keyboardShortcutsEnabled ? 'bg-violet-600' : 'bg-muted'
            }`}
          >
            <span
              aria-hidden="true"
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                preferences.keyboardShortcutsEnabled ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {/* Shortcuts overview */}
        <div className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-2 text-xs">
          <p className="font-medium text-foreground/80">Available Workstation Shortcuts</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-muted-foreground pt-1">
            <div className="flex items-center justify-between p-1.5 rounded bg-background/50 border border-border/40">
              <span>Open command palette</span>
              <ShortcutBadge shortcut="Cmd+K" />
            </div>
            <div className="flex items-center justify-between p-1.5 rounded bg-background/50 border border-border/40">
              <span>Run current tool action</span>
              <ShortcutBadge shortcut="Cmd+Enter" />
            </div>
            <div className="flex items-center justify-between p-1.5 rounded bg-background/50 border border-border/40">
              <span>Copy selected transaction hash</span>
              <ShortcutBadge shortcut="Cmd+C" />
            </div>
            <div className="flex items-center justify-between p-1.5 rounded bg-background/50 border border-border/40">
              <span>Navigate palette list</span>
              <ShortcutBadge shortcut="↑↓ ↵" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

function PasskeysSection() {
  const { user } = useAuth();
  const [passkeys, setPasskeys] = useState<PasskeyCredentialSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  const [password, setPassword] = useState('');
  const [showRegister, setShowRegister] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const data = await listPasskeys();
      setPasskeys(data);
    } catch {
      // non-fatal
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  const requireReauth = async (password: string): Promise<string> => {
    const { reauthToken } = await reauthenticate(password);
    return reauthToken;
  };

  async function handleRegister() {
    setError(null);
    setBusy(true);
    try {
      const { startRegistration } = await import('@simplewebauthn/browser');
      const reauthToken = await requireReauth(password);
      const { options } = await beginPasskeyRegistration(reauthToken);
      const attResp = await startRegistration({ optionsJSON: options });
      await verifyPasskeyRegistration({
        reauthToken,
        name: newName.trim() || 'My passkey',
        registrationResponse: attResp,
      });
      setShowRegister(false);
      setPassword('');
      setNewName('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Passkey registration failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(id: string) {
    setError(null);
    setBusy(true);
    try {
      const reauthToken = await requireReauth(
        password || window.prompt('Re-enter your password to confirm revocation:') || '',
      );
      await revokePasskey(id, reauthToken);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke passkey.');
    } finally {
      setBusy(false);
    }
  }

  if (!user) return null;

  return (
    <section className="border border-border rounded-lg p-5 space-y-4">
      <div>
        <h2 className="text-sm font-medium">Passkeys</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Phishing-resistant sign-in credentials. Registration and changes
          require a recent password reauthentication; password sign-in and
          recovery keep working regardless.
        </p>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {passkeys.length > 0 ? (
        <div className="border-t border-border pt-4 space-y-3">
          {passkeys.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">{p.name}</p>
                <p className="text-xs text-muted-foreground">
                  {p.revokedAt
                    ? 'Revoked — cannot authenticate'
                    : `Added ${new Date(p.createdAt).toLocaleDateString()}`}
                  {p.lastUsedAt
                    ? ` · last used ${new Date(p.lastUsedAt).toLocaleDateString()}`
                    : ''}
                </p>
              </div>
              {!p.revokedAt ? (
                <button
                  onClick={() => void handleRevoke(p.id)}
                  disabled={busy}
                  className="rounded-md border border-border px-3 py-1.5 text-xs hover:border-destructive hover:text-destructive transition-colors disabled:opacity-50"
                >
                  Revoke
                </button>
              ) : (
                <span className="text-xs text-muted-foreground">revoked</span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground border-t border-border pt-4">
          {loading ? 'Loading passkeys…' : 'No passkeys registered yet.'}
        </p>
      )}

      {showRegister ? (
        <div className="border-t border-border pt-4 space-y-2">
          <label className="text-xs text-muted-foreground block">
            Confirm your password to continue
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              autoComplete="current-password"
            />
          </label>
          <label className="text-xs text-muted-foreground block">
            Passkey name
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="MacBook Touch ID"
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => void handleRegister()}
              disabled={busy || !password}
              className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            >
              {busy ? 'Working…' : 'Register passkey'}
            </button>
            <button
              onClick={() => setShowRegister(false)}
              className="rounded-md border border-border px-3 py-1.5 text-xs"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowRegister(true)}
          disabled={busy || !user?.emailVerified}
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:border-foreground/30 transition-colors disabled:opacity-50"
        >
          Add a passkey
        </button>
      )}
    </section>
  );
}

export default function SettingsPage() {
  const { user } = useAuth();

  return (
    <div className="max-w-2xl mx-auto px-6 py-12 space-y-8">
      <div>
        <h1 className="text-xl font-semibold mb-2">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage your SaviTools account and Savitura ecosystem connections.
        </p>
      </div>

      {/* Account */}
      <section className="border border-border rounded-lg p-5">
        <h2 className="text-sm font-medium">Account</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {user ? (
            <>
              {user.email}
              {user.emailVerified ? null : (
                <span className="ml-2 text-yellow-600 text-xs">(unverified)</span>
              )}
            </>
          ) : (
            'You are browsing as a guest.'
          )}
        </p>
      </section>

      <KeyboardNavigationSection />
      <ConnectedAccountsSection />
      <PasskeysSection />
      <VaultSection />
      <SessionsSection />
    </div>
  );
}

