import { useState, useEffect, useCallback } from 'react';
import { get, put } from '../../services/api-client';

interface IntelligenceItem {
  id: string;
  category: string;
  subcategory: string | null;
  title: string;
  source: string | null;
  source_name: string | null;
  summary: string | null;
  relevance_score: number | null;
  deadline: string | null;
  eligibility_summary: string | null;
  award_details: string | null;
  status: string;
  published_at: string | null;
  discovered_at: string;
  reviewed_at: string | null;
}

interface ItemsResponse {
  items: IntelligenceItem[];
  total: number;
}

type Tab = 'grants' | 'ai-news' | 'publishing';

export function IntelligenceFeed() {
  const [activeTab, setActiveTab] = useState<Tab>('grants');
  const [items, setItems] = useState<IntelligenceItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('');

  const loadItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      params.set('limit', '50');
      params.set('offset', '0');

      const endpoint = `/api/intelligence/${activeTab}?${params.toString()}`;
      const data = await get<ItemsResponse>(endpoint);
      setItems(data.items);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load items');
    } finally {
      setLoading(false);
    }
  }, [activeTab, statusFilter]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  async function updateStatus(itemId: string, newStatus: string) {
    try {
      await put(`/api/intelligence/ai-news/${itemId}`, { status: newStatus });
      await loadItems();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status');
    }
  }

  const tabs: { key: Tab; label: string; icon: string }[] = [
    { key: 'grants', label: 'Grants', icon: '💰' },
    { key: 'ai-news', label: 'AI News', icon: '🤖' },
    { key: 'publishing', label: 'Publishing', icon: '📖' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Intelligence Feed</h2>
        <p className="text-gray-600 text-sm mt-1">
          Grants, AI news, and publishing opportunities discovered by Quinn's background scanners
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => { setActiveTab(tab.key); setStatusFilter(''); }}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <span className="mr-1.5">{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Filter */}
      <div className="flex items-center gap-3">
        <label htmlFor="status-filter" className="text-sm text-gray-600">Filter:</label>
        <select
          id="status-filter"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
        >
          <option value="">All</option>
          <option value="new">New</option>
          <option value="reviewed">Reviewed</option>
          <option value="selected">Selected</option>
          <option value="saved">Saved</option>
          <option value="dismissed">Dismissed</option>
        </select>
        <span className="text-sm text-gray-400">{total} items</span>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-red-800 text-sm">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
        </div>
      )}

      {/* Empty state */}
      {!loading && items.length === 0 && (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
          <p className="text-lg text-gray-600">No items yet</p>
          <p className="text-sm text-gray-500 mt-2">
            Quinn's background scanners will populate this feed automatically based on your configured schedules.
            Check Settings → Intelligence Schedules to configure scan frequency.
          </p>
        </div>
      )}

      {/* Items list */}
      {!loading && items.length > 0 && (
        <div className="space-y-3">
          {items.map((item) => (
            <div key={item.id} className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-medium text-gray-900 truncate">{item.title}</h3>
                    <span className={`text-xs px-2 py-0.5 rounded-full flex-shrink-0 ${
                      item.status === 'new' ? 'bg-blue-100 text-blue-700' :
                      item.status === 'selected' ? 'bg-green-100 text-green-700' :
                      item.status === 'saved' ? 'bg-amber-100 text-amber-700' :
                      item.status === 'dismissed' ? 'bg-gray-100 text-gray-500' :
                      'bg-gray-100 text-gray-600'
                    }`}>
                      {item.status}
                    </span>
                  </div>

                  {item.summary && (
                    <p className="text-sm text-gray-600 mt-1 line-clamp-2">{item.summary}</p>
                  )}

                  <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                    {item.source_name && <span>{item.source_name}</span>}
                    {item.deadline && (
                      <span className="text-red-600 font-medium">
                        Deadline: {new Date(item.deadline).toLocaleDateString()}
                      </span>
                    )}
                    {item.relevance_score != null && (
                      <span>Relevance: {Math.round(item.relevance_score * 100)}%</span>
                    )}
                    <span>{new Date(item.discovered_at).toLocaleDateString()}</span>
                  </div>

                  {item.eligibility_summary && (
                    <p className="text-xs text-gray-500 mt-2 italic">{item.eligibility_summary}</p>
                  )}
                </div>

                {/* Actions */}
                {activeTab === 'ai-news' && item.status === 'new' && (
                  <div className="flex flex-col gap-1 flex-shrink-0">
                    <button
                      onClick={() => updateStatus(item.id, 'selected')}
                      className="text-xs px-2 py-1 bg-green-50 text-green-700 rounded hover:bg-green-100"
                    >
                      Select
                    </button>
                    <button
                      onClick={() => updateStatus(item.id, 'saved')}
                      className="text-xs px-2 py-1 bg-amber-50 text-amber-700 rounded hover:bg-amber-100"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => updateStatus(item.id, 'dismissed')}
                      className="text-xs px-2 py-1 bg-gray-50 text-gray-500 rounded hover:bg-gray-100"
                    >
                      Dismiss
                    </button>
                  </div>
                )}

                {item.source && (
                  <a
                    href={item.source}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-indigo-600 hover:text-indigo-700 flex-shrink-0"
                  >
                    Source ↗
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
