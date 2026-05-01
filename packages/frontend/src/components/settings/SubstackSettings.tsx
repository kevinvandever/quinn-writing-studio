import { useState, useEffect, useCallback } from 'react';
import { get, post } from '../../services/api-client';

interface SubstackConnection {
  id: string;
  project_id: string;
  publication_url: string;
  publication_name: string | null;
  last_sync_at: string | null;
  sync_status: string;
  sync_error: string | null;
}

interface SubstackSettingsProps {
  projectId: string;
  projectName?: string;
}

export function SubstackSettings({ projectId, projectName }: SubstackSettingsProps) {
  const [connection, setConnection] = useState<SubstackConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Form state
  const [publicationUrl, setPublicationUrl] = useState('');
  const [publicationName, setPublicationName] = useState('');
  const [authCookies, setAuthCookies] = useState('');

  const loadStatus = useCallback(async () => {
    try {
      setLoading(true);
      const result = await get<{ connections: SubstackConnection[] }>(
        '/api/integrations/substack/status'
      );
      const projectConnection = result.connections.find(
        (c) => c.project_id === projectId
      );
      if (projectConnection) {
        setConnection(projectConnection);
        setPublicationUrl(projectConnection.publication_url);
        setPublicationName(projectConnection.publication_name || '');
      }
    } catch (err) {
      console.error('Failed to load Substack status:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const saveConnection = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!publicationUrl.trim()) {
      setError('Publication URL is required');
      return;
    }

    try {
      setSaving(true);
      const result = await post<{ connection: SubstackConnection }>(
        '/api/integrations/substack',
        {
          project_id: projectId,
          publication_url: publicationUrl.trim(),
          publication_name: publicationName.trim() || null,
          auth_cookies: authCookies.trim() || null,
        }
      );
      setConnection(result.connection);
      setSuccess('Substack connection saved successfully');
    } catch (err) {
      setError('Failed to save connection');
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const triggerSync = async () => {
    setError(null);
    setSuccess(null);

    try {
      setSyncing(true);
      const result = await post<{
        sync: { postsFound: number; newPosts: number; errors: string[] };
      }>('/api/integrations/substack/sync', { project_id: projectId });

      if (result.sync.errors.length > 0) {
        setError(`Sync completed with errors: ${result.sync.errors.join(', ')}`);
      } else {
        setSuccess(
          `Sync complete: ${result.sync.postsFound} posts found, ${result.sync.newPosts} new posts imported`
        );
      }

      // Reload status
      await loadStatus();
    } catch (err) {
      setError('Failed to sync');
      console.error(err);
    } finally {
      setSyncing(false);
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Never';
    return new Date(dateStr).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'ok':
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
            Connected
          </span>
        );
      case 'error':
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
            Error
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
            Never Synced
          </span>
        );
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-gray-900">Substack Integration</h3>
        {projectName && (
          <p className="text-sm text-gray-500 mt-1">
            Configure Substack sync for {projectName}
          </p>
        )}
      </div>

      {/* Status Display */}
      {connection && (
        <div className="bg-gray-50 rounded-lg border border-gray-200 p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium text-gray-700">
                  {connection.publication_name || connection.publication_url}
                </p>
                {getStatusBadge(connection.sync_status)}
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Last sync: {formatDate(connection.last_sync_at)}
              </p>
              {connection.sync_error && (
                <p className="text-xs text-red-600 mt-1">{connection.sync_error}</p>
              )}
            </div>
            <button
              onClick={triggerSync}
              disabled={syncing}
              className="inline-flex items-center px-3 py-1.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {syncing ? 'Syncing...' : 'Sync Now'}
            </button>
          </div>
        </div>
      )}

      {/* Messages */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm">
          {success}
        </div>
      )}

      {/* Configuration Form */}
      <form onSubmit={saveConnection} className="space-y-4">
        <div>
          <label
            htmlFor="publication-url"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            Publication URL
          </label>
          <input
            id="publication-url"
            type="url"
            value={publicationUrl}
            onChange={(e) => setPublicationUrl(e.target.value)}
            placeholder="https://yourname.substack.com"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            required
          />
          <p className="text-xs text-gray-500 mt-1">
            Your Substack publication URL (e.g., https://yourname.substack.com)
          </p>
        </div>

        <div>
          <label
            htmlFor="publication-name"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            Publication Name (optional)
          </label>
          <input
            id="publication-name"
            type="text"
            value={publicationName}
            onChange={(e) => setPublicationName(e.target.value)}
            placeholder="My Newsletter"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          />
        </div>

        <div>
          <label
            htmlFor="auth-cookies"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            Auth Cookies (optional, for draft access)
          </label>
          <textarea
            id="auth-cookies"
            value={authCookies}
            onChange={(e) => setAuthCookies(e.target.value)}
            placeholder="substack.sid=..."
            rows={3}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          />
          <p className="text-xs text-gray-500 mt-1">
            Optional: Provide session cookies to also sync draft posts. Published posts are always available via RSS.
          </p>
        </div>

        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? 'Saving...' : connection ? 'Update Connection' : 'Save Connection'}
        </button>
      </form>
    </div>
  );
}
