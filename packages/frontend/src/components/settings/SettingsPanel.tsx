import { useState, useEffect } from 'react';
import { get, put, post } from '../../services/api-client';
import { PersonaEditor } from './PersonaEditor';

interface Settings {
  anthropic_api_key_set: boolean;
  anthropic_api_key_masked: string | null;
  model_routing_preference: string;
  quiet_period_thresholds: { gentle: number; warm: number; direct: number };
  stale_corpus_threshold_days: number;
  email_notifications_enabled: boolean;
  notification_email: string | null;
  vacation_start: string | null;
  vacation_end: string | null;
  intelligence_schedules: Record<string, string> | null;
}

interface SettingsResponse {
  settings: Settings;
}

interface ExportResponse {
  jobId: string;
  status: string;
}

export function SettingsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Form state
  const [apiKey, setApiKey] = useState('');
  const [modelPreference, setModelPreference] = useState('auto');
  const [gentleThreshold, setGentleThreshold] = useState(3);
  const [warmThreshold, setWarmThreshold] = useState(7);
  const [directThreshold, setDirectThreshold] = useState(14);
  const [staleCorpusDays, setStaleCorpusDays] = useState(30);
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [notificationEmail, setNotificationEmail] = useState('');
  const [grantSchedule, setGrantSchedule] = useState('0 6 * * *');
  const [aiNewsSchedule, setAiNewsSchedule] = useState('0 */6 * * *');
  const [publishingSchedule, setPublishingSchedule] = useState('0 7 * * *');

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    try {
      const data = await get<SettingsResponse>('/api/settings');
      setSettings(data.settings);
      setModelPreference(data.settings.model_routing_preference);
      setGentleThreshold(data.settings.quiet_period_thresholds.gentle);
      setWarmThreshold(data.settings.quiet_period_thresholds.warm);
      setDirectThreshold(data.settings.quiet_period_thresholds.direct);
      setStaleCorpusDays(data.settings.stale_corpus_threshold_days);
      setEmailEnabled(data.settings.email_notifications_enabled);
      setNotificationEmail(data.settings.notification_email || '');
      if (data.settings.intelligence_schedules) {
        setGrantSchedule(data.settings.intelligence_schedules.grant_scanner || '0 6 * * *');
        setAiNewsSchedule(data.settings.intelligence_schedules.ai_news_scanner || '0 */6 * * *');
        setPublishingSchedule(data.settings.intelligence_schedules.publishing_scanner || '0 7 * * *');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSave() {
    setIsSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const payload: Record<string, unknown> = {
        model_routing_preference: modelPreference,
        quiet_period_thresholds: {
          gentle: gentleThreshold,
          warm: warmThreshold,
          direct: directThreshold,
        },
        stale_corpus_threshold_days: staleCorpusDays,
        email_notifications_enabled: emailEnabled,
        notification_email: notificationEmail || null,
        intelligence_schedules: {
          grant_scanner: grantSchedule,
          ai_news_scanner: aiNewsSchedule,
          publishing_scanner: publishingSchedule,
        },
      };

      // Only include API key if user entered a new one
      if (apiKey) {
        payload.anthropic_api_key = apiKey;
      }

      await put('/api/settings', payload);
      setSuccess('Settings saved successfully');
      setApiKey('');
      await loadSettings();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  }

  async function handleExport() {
    setIsExporting(true);
    try {
      const data = await post<ExportResponse>('/api/export');
      setSuccess(`Export initiated (Job ID: ${data.jobId}). Check back shortly for download.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setIsExporting(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <h2 className="text-2xl font-bold text-gray-900">Settings</h2>

      {/* Feedback messages */}
      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-red-800 text-sm">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-lg bg-green-50 border border-green-200 p-4 text-green-800 text-sm">
          {success}
        </div>
      )}

      {/* API Key Configuration */}
      <section className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
        <h3 className="text-lg font-semibold text-gray-900">API Configuration</h3>

        <div>
          <label htmlFor="api-key" className="block text-sm font-medium text-gray-700 mb-1">
            Anthropic API Key
          </label>
          <div className="flex items-center gap-2">
            <input
              id="api-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={settings?.anthropic_api_key_masked || 'Enter your API key'}
              className="flex-1 rounded-lg border border-gray-300 p-2.5 text-sm"
            />
            {settings?.anthropic_api_key_set && (
              <span className="text-xs text-green-600 font-medium">✓ Set</span>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Your API key is encrypted at rest. Leave blank to keep the current key.
          </p>
        </div>
      </section>

      {/* Model Routing */}
      <section className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
        <h3 className="text-lg font-semibold text-gray-900">Model Routing</h3>

        <div>
          <label htmlFor="model-pref" className="block text-sm font-medium text-gray-700 mb-1">
            Routing Preference
          </label>
          <select
            id="model-pref"
            value={modelPreference}
            onChange={(e) => setModelPreference(e.target.value)}
            className="w-full rounded-lg border border-gray-300 p-2.5 text-sm"
          >
            <option value="auto">Auto (recommended)</option>
            <option value="always_sonnet">Always use Sonnet</option>
            <option value="always_opus">Always use Opus</option>
          </select>
          <p className="text-xs text-gray-500 mt-1">
            Auto routes to Opus for complex tasks (theme analysis, deep corpus work) and Sonnet for everyday coaching.
          </p>
        </div>
      </section>

      {/* Quiet Period Thresholds */}
      <section className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
        <h3 className="text-lg font-semibold text-gray-900">Nudge Thresholds</h3>
        <p className="text-sm text-gray-600">
          Configure how long Quinn waits before checking in during quiet periods.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label htmlFor="gentle-threshold" className="block text-sm font-medium text-gray-700 mb-1">
              Gentle (days)
            </label>
            <input
              id="gentle-threshold"
              type="number"
              min="1"
              value={gentleThreshold}
              onChange={(e) => setGentleThreshold(Number(e.target.value))}
              className="w-full rounded-lg border border-gray-300 p-2.5 text-sm"
            />
          </div>
          <div>
            <label htmlFor="warm-threshold" className="block text-sm font-medium text-gray-700 mb-1">
              Warm (days)
            </label>
            <input
              id="warm-threshold"
              type="number"
              min="1"
              value={warmThreshold}
              onChange={(e) => setWarmThreshold(Number(e.target.value))}
              className="w-full rounded-lg border border-gray-300 p-2.5 text-sm"
            />
          </div>
          <div>
            <label htmlFor="direct-threshold" className="block text-sm font-medium text-gray-700 mb-1">
              Direct (days)
            </label>
            <input
              id="direct-threshold"
              type="number"
              min="1"
              value={directThreshold}
              onChange={(e) => setDirectThreshold(Number(e.target.value))}
              className="w-full rounded-lg border border-gray-300 p-2.5 text-sm"
            />
          </div>
        </div>

        <div>
          <label htmlFor="stale-corpus" className="block text-sm font-medium text-gray-700 mb-1">
            Stale Corpus Threshold (days)
          </label>
          <input
            id="stale-corpus"
            type="number"
            min="7"
            value={staleCorpusDays}
            onChange={(e) => setStaleCorpusDays(Number(e.target.value))}
            className="w-full rounded-lg border border-gray-300 p-2.5 text-sm"
          />
        </div>
      </section>

      {/* Email Notifications */}
      <section className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
        <h3 className="text-lg font-semibold text-gray-900">Email Notifications</h3>

        <div className="flex items-center gap-3">
          <input
            id="email-enabled"
            type="checkbox"
            checked={emailEnabled}
            onChange={(e) => setEmailEnabled(e.target.checked)}
            className="w-4 h-4 text-indigo-600 rounded border-gray-300"
          />
          <label htmlFor="email-enabled" className="text-sm text-gray-700">
            Enable email notifications for nudges
          </label>
        </div>

        {emailEnabled && (
          <div>
            <label htmlFor="notification-email" className="block text-sm font-medium text-gray-700 mb-1">
              Notification Email
            </label>
            <input
              id="notification-email"
              type="email"
              value={notificationEmail}
              onChange={(e) => setNotificationEmail(e.target.value)}
              placeholder="your@email.com"
              className="w-full rounded-lg border border-gray-300 p-2.5 text-sm"
            />
          </div>
        )}
      </section>

      {/* Save button */}
      <button
        onClick={handleSave}
        disabled={isSaving}
        className="w-full py-3 px-4 bg-indigo-600 text-white rounded-lg font-medium
                   hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {isSaving ? 'Saving...' : 'Save Settings'}
      </button>

      {/* Intelligence Schedules */}
      <section className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
        <h3 className="text-lg font-semibold text-gray-900">Intelligence Schedules</h3>
        <p className="text-sm text-gray-600">
          Configure how often Quinn scans for grants, AI news, and publishing opportunities.
          Uses cron syntax. Changes take effect on next server restart.
        </p>

        <div className="space-y-4">
          <div>
            <label htmlFor="grant-schedule" className="block text-sm font-medium text-gray-700 mb-1">
              Grant Scanner
            </label>
            <input
              id="grant-schedule"
              type="text"
              value={grantSchedule}
              onChange={(e) => setGrantSchedule(e.target.value)}
              className="w-full rounded-lg border border-gray-300 p-2.5 text-sm font-mono"
            />
            <p className="text-xs text-gray-500 mt-1">Default: 0 6 * * * (daily at 6:00 AM UTC)</p>
          </div>

          <div>
            <label htmlFor="ai-news-schedule" className="block text-sm font-medium text-gray-700 mb-1">
              AI News Scanner (Promptly)
            </label>
            <input
              id="ai-news-schedule"
              type="text"
              value={aiNewsSchedule}
              onChange={(e) => setAiNewsSchedule(e.target.value)}
              className="w-full rounded-lg border border-gray-300 p-2.5 text-sm font-mono"
            />
            <p className="text-xs text-gray-500 mt-1">Default: 0 */6 * * * (every 6 hours)</p>
          </div>

          <div>
            <label htmlFor="publishing-schedule" className="block text-sm font-medium text-gray-700 mb-1">
              Publishing Scanner
            </label>
            <input
              id="publishing-schedule"
              type="text"
              value={publishingSchedule}
              onChange={(e) => setPublishingSchedule(e.target.value)}
              className="w-full rounded-lg border border-gray-300 p-2.5 text-sm font-mono"
            />
            <p className="text-xs text-gray-500 mt-1">Default: 0 7 * * * (daily at 7:00 AM UTC)</p>
          </div>
        </div>

        <button
          onClick={handleSave}
          disabled={isSaving}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium
                     hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isSaving ? 'Saving...' : 'Save Schedules'}
        </button>
      </section>

      {/* Persona Editor */}
      <section className="bg-white rounded-lg border border-gray-200 p-6">
        <PersonaEditor />
      </section>

      {/* Data Export */}
      <section className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
        <h3 className="text-lg font-semibold text-gray-900">Data Export</h3>
        <p className="text-sm text-gray-600">
          Download all your data as a ZIP archive including session transcripts, captures, snapshots, and intelligence items.
        </p>
        <button
          onClick={handleExport}
          disabled={isExporting}
          className="px-4 py-2 bg-gray-800 text-white rounded-lg text-sm font-medium
                     hover:bg-gray-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isExporting ? 'Exporting...' : '📦 Export All Data'}
        </button>
      </section>
    </div>
  );
}
