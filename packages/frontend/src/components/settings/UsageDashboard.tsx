import { useState, useEffect } from 'react';
import { get } from '../../services/api-client';

interface UsageEntry {
  date: string;
  model: string;
  feature_area: string;
  total_cost: number;
  total_input_tokens: number;
  total_output_tokens: number;
}

interface UsageSummary {
  totalCost: number;
  byModel: Record<string, number>;
  byFeature: Record<string, number>;
  daily: UsageEntry[];
}

interface UsageResponse {
  usage: UsageSummary;
}

export function UsageDashboard() {
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [period, setPeriod] = useState<'week' | 'month' | 'quarter'>('month');

  useEffect(() => {
    loadUsage();
  }, [period]);

  async function loadUsage() {
    try {
      setIsLoading(true);
      const data = await get<UsageResponse>(`/api/activity?period=${period}`);
      // Transform activity data into usage format
      // For now, use mock structure since usage endpoint may not exist yet
      setUsage(data.usage || {
        totalCost: 0,
        byModel: {},
        byFeature: {},
        daily: [],
      });
    } catch {
      // Use empty data on error
      setUsage({
        totalCost: 0,
        byModel: {},
        byFeature: {},
        daily: [],
      });
    } finally {
      setIsLoading(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-600" />
      </div>
    );
  }

  if (!usage) return null;

  const maxCost = Math.max(...Object.values(usage.byFeature), 0.01);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900">API Usage</h3>
        <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
          {(['week', 'month', 'quarter'] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                period === p
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              {p.charAt(0).toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Total cost */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <p className="text-sm text-gray-500">Total Cost ({period})</p>
        <p className="text-3xl font-bold text-gray-900">
          ${usage.totalCost.toFixed(2)}
        </p>
      </div>

      {/* Cost by model */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h4 className="text-sm font-medium text-gray-700">By Model</h4>
        {Object.entries(usage.byModel).length === 0 ? (
          <p className="text-sm text-gray-500">No usage data yet</p>
        ) : (
          Object.entries(usage.byModel).map(([model, cost]) => (
            <div key={model} className="flex items-center gap-3">
              <span className="text-sm text-gray-600 w-20 capitalize">{model}</span>
              <div className="flex-1 bg-gray-200 rounded-full h-3">
                <div
                  className={`h-3 rounded-full ${model === 'opus' ? 'bg-purple-500' : 'bg-indigo-500'}`}
                  style={{ width: `${(cost / Math.max(usage.totalCost, 0.01)) * 100}%` }}
                />
              </div>
              <span className="text-sm font-medium text-gray-900 w-16 text-right">
                ${cost.toFixed(2)}
              </span>
            </div>
          ))
        )}
      </div>

      {/* Cost by feature area */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h4 className="text-sm font-medium text-gray-700">By Feature</h4>
        {Object.entries(usage.byFeature).length === 0 ? (
          <p className="text-sm text-gray-500">No usage data yet</p>
        ) : (
          Object.entries(usage.byFeature)
            .sort(([, a], [, b]) => b - a)
            .map(([feature, cost]) => (
              <div key={feature} className="flex items-center gap-3">
                <span className="text-sm text-gray-600 w-28 capitalize">
                  {feature.replace(/_/g, ' ')}
                </span>
                <div className="flex-1 bg-gray-200 rounded-full h-3">
                  <div
                    className="h-3 rounded-full bg-emerald-500"
                    style={{ width: `${(cost / maxCost) * 100}%` }}
                  />
                </div>
                <span className="text-sm font-medium text-gray-900 w-16 text-right">
                  ${cost.toFixed(2)}
                </span>
              </div>
            ))
        )}
      </div>
    </div>
  );
}
