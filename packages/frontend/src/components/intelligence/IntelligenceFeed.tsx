import { useState, useEffect, useCallback } from 'react';
import { get, put, post } from '../../services/api-client';

// ─── Types ───────────────────────────────────────────────────────────────────

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

interface IntelligenceResponse {
  items: IntelligenceItem[];
  total: number;
}

type TabId = 'grants' | 'ai_news' | 'publishing';

// ─── Component ───────────────────────────────────────────────────────────────

export function IntelligenceFeed() {
  const [activeTab, setActiveTab] = useState<TabId>('grants');
  const [items, setItems] = useState<IntelligenceItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('');

  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const endpoint = getEndpoint(activeTab, statusFilter);
      const data = await get<IntelligenceResponse>(endpoint);
      setItems(data.items);
      setTotal(data.total);
    } catch (error) {
      console.error('Failed to fetch intelligence items:', error);
    } finally {
      setLoading(false);
    }
  }, [activeTab, statusFilter]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  const handleAction = async (itemId: string, action: 'saved' | 'dismissed' | 'selected') => {
    try {
      if (action === 'selected') {
        // Select for Promptly writing queue
        await post(`/api/promptly/queue/${itemId}/select`);
      } else {
        await put(`/api/intelligence/ai-news/${itemId}`, { status: action });
      }
      // Update local state
      setItems((prev) =>
        prev.map((item) =>
          item.id === itemId ? { ...item, status: action } : item
        )
      );
    } catch (error) {
      console.error('Failed to update item status:', error);
    }
  };

  const tabs: { id: TabId; label: string }[] = [
    { id: 'grants', label: 'Grants' },
    { id: 'ai_news', label: 'AI News' },
    { id: 'publishing', label: 'Publishing' },
  ];

  return (
    <div className="max-w-4xl mx-auto px-4 py-4 md:p-6">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Intelligence Feed</h1>

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="-mb-px flex space-x-8" aria-label="Intelligence tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`py-2 px-1 border-b-2 font-medium text-sm transition-colors ${
                activeTab === tab.id
                  ? 'border-indigo-500 text-indigo-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
              aria-current={activeTab === tab.id ? 'page' : undefined}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Status Filter */}
      <div className="flex items-center gap-4 mb-4">
        <label htmlFor="status-filter" className="text-sm text-gray-600">
          Filter:
        </label>
        <select
          id="status-filter"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="text-sm border border-gray-300 rounded-md px-3 py-1.5 focus:ring-indigo-500 focus:border-indigo-500"
        >
          <option value="">All</option>
          <option value="new">New</option>
          <option value="saved">Saved</option>
          <option value="reviewed">Reviewed</option>
          <option value="dismissed">Dismissed</option>
        </select>
        <span className="text-sm text-gray-500 ml-auto">{total} items</span>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <p>No items found. Intelligence scanners will populate this feed automatically.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {activeTab === 'grants' && <GrantsList items={items} onAction={handleAction} />}
          {activeTab === 'ai_news' && <AiNewsList items={items} onAction={handleAction} />}
          {activeTab === 'publishing' && <PublishingList items={items} onAction={handleAction} />}
        </div>
      )}
    </div>
  );
}

// ─── Grants Tab ──────────────────────────────────────────────────────────────

function GrantsList({
  items,
  onAction,
}: {
  items: IntelligenceItem[];
  onAction: (id: string, action: 'saved' | 'dismissed' | 'selected') => void;
}) {
  return (
    <>
      {items.map((item) => (
        <div
          key={item.id}
          className={`border rounded-lg p-4 transition-colors ${
            item.status === 'new'
              ? 'border-indigo-200 bg-indigo-50/30'
              : 'border-gray-200 bg-white'
          }`}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                {item.status === 'new' && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-800">
                    New
                  </span>
                )}
                {item.subcategory && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700 capitalize">
                    {item.subcategory.replace('_', ' ')}
                  </span>
                )}
              </div>
              <h3 className="text-sm font-semibold text-gray-900 truncate">
                {item.source ? (
                  <a
                    href={item.source}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-indigo-600"
                  >
                    {item.title}
                  </a>
                ) : (
                  item.title
                )}
              </h3>
              {item.summary && (
                <p className="text-sm text-gray-600 mt-1 line-clamp-2">{item.summary}</p>
              )}
              <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                {item.source_name && <span>{item.source_name}</span>}
                {item.deadline && (
                  <span className="text-orange-600 font-medium">
                    Deadline: {new Date(item.deadline).toLocaleDateString()}
                  </span>
                )}
                {item.award_details && (
                  <span className="text-green-700">{item.award_details}</span>
                )}
              </div>
              {item.eligibility_summary && (
                <p className="text-xs text-gray-500 mt-1">
                  Eligibility: {item.eligibility_summary}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1 shrink-0">
              <button
                onClick={() => onAction(item.id, 'saved')}
                className="px-3 py-1 text-xs font-medium text-indigo-700 bg-indigo-50 rounded hover:bg-indigo-100 transition-colors"
                aria-label={`Save ${item.title}`}
              >
                Save
              </button>
              <button
                onClick={() => onAction(item.id, 'dismissed')}
                className="px-3 py-1 text-xs font-medium text-gray-500 bg-gray-50 rounded hover:bg-gray-100 transition-colors"
                aria-label={`Dismiss ${item.title}`}
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

// ─── AI News Tab ─────────────────────────────────────────────────────────────

function AiNewsList({
  items,
  onAction,
}: {
  items: IntelligenceItem[];
  onAction: (id: string, action: 'saved' | 'dismissed' | 'selected') => void;
}) {
  return (
    <>
      {items.map((item) => (
        <div
          key={item.id}
          className={`border rounded-lg p-4 transition-colors ${
            item.status === 'new'
              ? 'border-blue-200 bg-blue-50/30'
              : 'border-gray-200 bg-white'
          }`}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                {item.status === 'new' && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                    New
                  </span>
                )}
                {item.subcategory && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700 capitalize">
                    {item.subcategory.replace('_', ' ')}
                  </span>
                )}
                {item.relevance_score !== null && (
                  <span className="text-xs text-gray-400">
                    {Math.round(item.relevance_score * 100)}% relevant
                  </span>
                )}
              </div>
              <h3 className="text-sm font-semibold text-gray-900 truncate">
                {item.source ? (
                  <a
                    href={item.source}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-blue-600"
                  >
                    {item.title}
                  </a>
                ) : (
                  item.title
                )}
              </h3>
              {item.summary && (
                <p className="text-sm text-gray-600 mt-1 line-clamp-2">{item.summary}</p>
              )}
              <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                {item.source_name && <span>{item.source_name}</span>}
                {item.discovered_at && (
                  <span>{new Date(item.discovered_at).toLocaleDateString()}</span>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-1 shrink-0">
              <button
                onClick={() => onAction(item.id, 'selected')}
                className="px-3 py-1 text-xs font-medium text-white bg-blue-600 rounded hover:bg-blue-700 transition-colors"
                aria-label={`Select ${item.title} for writing`}
              >
                Write
              </button>
              <button
                onClick={() => onAction(item.id, 'saved')}
                className="px-3 py-1 text-xs font-medium text-blue-700 bg-blue-50 rounded hover:bg-blue-100 transition-colors"
                aria-label={`Save ${item.title} for later`}
              >
                Save
              </button>
              <button
                onClick={() => onAction(item.id, 'dismissed')}
                className="px-3 py-1 text-xs font-medium text-gray-500 bg-gray-50 rounded hover:bg-gray-100 transition-colors"
                aria-label={`Dismiss ${item.title}`}
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

// ─── Publishing Tab ──────────────────────────────────────────────────────────

function PublishingList({
  items,
  onAction,
}: {
  items: IntelligenceItem[];
  onAction: (id: string, action: 'saved' | 'dismissed' | 'selected') => void;
}) {
  // Group items by subcategory
  const grouped = items.reduce<Record<string, IntelligenceItem[]>>((acc, item) => {
    const key = item.subcategory || 'other';
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});

  const categoryLabels: Record<string, string> = {
    agent_movement: 'Agent Movements',
    submission_window: 'Submission Windows',
    contest_deadline: 'Contest Deadlines',
    market_trend: 'Market Trends',
    industry_news: 'Industry News',
    other: 'Other',
  };

  return (
    <>
      {Object.entries(grouped).map(([category, categoryItems]) => (
        <div key={category} className="mb-6">
          <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
            {categoryLabels[category] || category.replace('_', ' ')}
          </h3>
          <div className="space-y-3">
            {categoryItems.map((item) => (
              <div
                key={item.id}
                className={`border rounded-lg p-4 transition-colors ${
                  item.status === 'new'
                    ? 'border-emerald-200 bg-emerald-50/30'
                    : 'border-gray-200 bg-white'
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      {item.status === 'new' && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800">
                          New
                        </span>
                      )}
                      {item.deadline && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-800">
                          Deadline: {new Date(item.deadline).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                    <h4 className="text-sm font-semibold text-gray-900 truncate">
                      {item.source ? (
                        <a
                          href={item.source}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-emerald-600"
                        >
                          {item.title}
                        </a>
                      ) : (
                        item.title
                      )}
                    </h4>
                    {item.summary && (
                      <p className="text-sm text-gray-600 mt-1 line-clamp-2">{item.summary}</p>
                    )}
                    <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                      {item.source_name && <span>{item.source_name}</span>}
                      {item.discovered_at && (
                        <span>{new Date(item.discovered_at).toLocaleDateString()}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col gap-1 shrink-0">
                    <button
                      onClick={() => onAction(item.id, 'saved')}
                      className="px-3 py-1 text-xs font-medium text-emerald-700 bg-emerald-50 rounded hover:bg-emerald-100 transition-colors"
                      aria-label={`Save ${item.title}`}
                    >
                      Save
                    </button>
                    <button
                      onClick={() => onAction(item.id, 'dismissed')}
                      className="px-3 py-1 text-xs font-medium text-gray-500 bg-gray-50 rounded hover:bg-gray-100 transition-colors"
                      aria-label={`Dismiss ${item.title}`}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getEndpoint(tab: TabId, statusFilter: string): string {
  const base = `/api/intelligence/${tab === 'ai_news' ? 'ai-news' : tab}`;
  const params = new URLSearchParams();
  if (statusFilter) params.set('status', statusFilter);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}
