import { useState, useEffect, useCallback } from 'react';
import { get } from '../../services/api-client';

// ─── Types ───────────────────────────────────────────────────────────────────

type TimePeriod = 'week' | 'month' | 'quarter';

interface ActivityInsights {
  period: TimePeriod;
  periodStart: string;
  periodEnd: string;
  scrivener: {
    importCount: number;
    totalWordCountDiff: number;
    averageWordCountDiff: number;
  };
  substack: {
    publishCount: number;
    totalWordCount: number;
    averageWordCount: number;
  };
  coaching: {
    sessionCount: number;
    totalDurationMinutes: number;
    averageDurationMinutes: number;
  };
  captures: {
    totalCount: number;
    byProject: Array<{ projectId: string | null; projectName: string | null; count: number }>;
  };
  projectFocus: Array<{ projectId: string; projectName: string; eventCount: number }>;
}

interface PublishingStreak {
  projectId: string;
  projectName: string;
  currentStreak: number;
  longestStreak: number;
  lastPublishDate: string | null;
  streakUnit: string;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ActivityDashboard() {
  const [period, setPeriod] = useState<TimePeriod>('week');
  const [insights, setInsights] = useState<ActivityInsights | null>(null);
  const [streaks, setStreaks] = useState<PublishingStreak[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [insightsResult, streaksResult] = await Promise.all([
        get<{ insights: ActivityInsights }>(`/api/activity?period=${period}`),
        get<{ streaks: PublishingStreak[] }>('/api/activity/streaks'),
      ]);

      setInsights(insightsResult.insights);
      setStreaks(streaksResult.streaks);
    } catch (err) {
      setError('Failed to load activity data');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header with period selector */}
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-900">Writing Activity</h2>
        <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
          {(['week', 'month', 'quarter'] as TimePeriod[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                period === p
                  ? 'bg-white text-indigo-700 shadow-sm'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              {p.charAt(0).toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {insights && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <MetricCard
              title="Words Written"
              value={insights.scrivener.totalWordCountDiff}
              subtitle={`${insights.scrivener.importCount} import${insights.scrivener.importCount !== 1 ? 's' : ''}`}
              color="blue"
              format="signed"
            />
            <MetricCard
              title="Posts Published"
              value={insights.substack.publishCount}
              subtitle={`${insights.substack.totalWordCount.toLocaleString()} total words`}
              color="green"
            />
            <MetricCard
              title="Coaching Sessions"
              value={insights.coaching.sessionCount}
              subtitle={`${insights.coaching.totalDurationMinutes} min total`}
              color="purple"
            />
            <MetricCard
              title="Quick Captures"
              value={insights.captures.totalCount}
              subtitle={`${insights.captures.byProject.length} project${insights.captures.byProject.length !== 1 ? 's' : ''}`}
              color="amber"
            />
          </div>

          {/* Charts Section */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Project Focus Distribution */}
            <div className="bg-white rounded-lg border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">
                Project Focus Distribution
              </h3>
              {insights.projectFocus.length === 0 ? (
                <p className="text-sm text-gray-500">No project activity this period.</p>
              ) : (
                <div className="space-y-3">
                  {insights.projectFocus.map((project) => {
                    const maxEvents = Math.max(
                      ...insights.projectFocus.map((p) => p.eventCount)
                    );
                    const percentage = Math.round(
                      (project.eventCount / maxEvents) * 100
                    );
                    return (
                      <div key={project.projectId}>
                        <div className="flex items-center justify-between text-sm mb-1">
                          <span className="text-gray-700 font-medium truncate">
                            {project.projectName}
                          </span>
                          <span className="text-gray-500 ml-2">
                            {project.eventCount} events
                          </span>
                        </div>
                        <div className="w-full bg-gray-100 rounded-full h-2">
                          <div
                            className="bg-indigo-500 h-2 rounded-full transition-all duration-300"
                            style={{ width: `${percentage}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Writing Output Bar Chart */}
            <div className="bg-white rounded-lg border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">
                Writing Output
              </h3>
              <div className="flex items-end gap-4 h-40">
                <BarChartColumn
                  label="Scrivener"
                  value={Math.abs(insights.scrivener.totalWordCountDiff)}
                  maxValue={Math.max(
                    Math.abs(insights.scrivener.totalWordCountDiff),
                    insights.substack.totalWordCount,
                    1
                  )}
                  color="bg-blue-500"
                />
                <BarChartColumn
                  label="Substack"
                  value={insights.substack.totalWordCount}
                  maxValue={Math.max(
                    Math.abs(insights.scrivener.totalWordCountDiff),
                    insights.substack.totalWordCount,
                    1
                  )}
                  color="bg-green-500"
                />
              </div>
            </div>
          </div>

          {/* Publishing Streaks */}
          {streaks.length > 0 && (
            <div className="bg-white rounded-lg border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">
                Publishing Streaks
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {streaks.map((streak) => (
                  <div
                    key={streak.projectId}
                    className="bg-gray-50 rounded-lg p-4 border border-gray-100"
                  >
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {streak.projectName}
                    </p>
                    <div className="mt-2 flex items-baseline gap-1">
                      <span className="text-2xl font-bold text-indigo-600">
                        {streak.currentStreak}
                      </span>
                      <span className="text-sm text-gray-500">
                        {streak.streakUnit} current
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-xs text-gray-500">
                      <span>Best: {streak.longestStreak} {streak.streakUnit}</span>
                      {streak.lastPublishDate && (
                        <span>
                          Last:{' '}
                          {new Date(streak.lastPublishDate).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                          })}
                        </span>
                      )}
                    </div>
                    {/* Streak flame indicator */}
                    {streak.currentStreak >= 3 && (
                      <div className="mt-2 text-orange-500 text-lg" title="On fire!">
                        {'🔥'.repeat(Math.min(streak.currentStreak, 5))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function MetricCard({
  title,
  value,
  subtitle,
  color,
  format,
}: {
  title: string;
  value: number;
  subtitle: string;
  color: 'blue' | 'green' | 'purple' | 'amber';
  format?: 'signed';
}) {
  const colorClasses = {
    blue: 'bg-blue-50 border-blue-200',
    green: 'bg-green-50 border-green-200',
    purple: 'bg-purple-50 border-purple-200',
    amber: 'bg-amber-50 border-amber-200',
  };

  const valueColorClasses = {
    blue: 'text-blue-700',
    green: 'text-green-700',
    purple: 'text-purple-700',
    amber: 'text-amber-700',
  };

  const displayValue =
    format === 'signed' && value > 0
      ? `+${value.toLocaleString()}`
      : value.toLocaleString();

  return (
    <div className={`rounded-lg border p-4 ${colorClasses[color]}`}>
      <p className="text-xs font-medium text-gray-600 uppercase tracking-wide">
        {title}
      </p>
      <p className={`text-2xl font-bold mt-1 ${valueColorClasses[color]}`}>
        {displayValue}
      </p>
      <p className="text-xs text-gray-500 mt-1">{subtitle}</p>
    </div>
  );
}

function BarChartColumn({
  label,
  value,
  maxValue,
  color,
}: {
  label: string;
  value: number;
  maxValue: number;
  color: string;
}) {
  const heightPercent = maxValue > 0 ? Math.max((value / maxValue) * 100, 4) : 4;

  return (
    <div className="flex-1 flex flex-col items-center gap-2">
      <div className="w-full flex items-end justify-center h-32">
        <div
          className={`w-full max-w-[60px] ${color} rounded-t-md transition-all duration-300`}
          style={{ height: `${heightPercent}%` }}
        />
      </div>
      <div className="text-center">
        <p className="text-xs font-medium text-gray-700">{value.toLocaleString()}</p>
        <p className="text-xs text-gray-500">{label}</p>
      </div>
    </div>
  );
}
