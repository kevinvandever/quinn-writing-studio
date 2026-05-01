import { useState, useEffect, useCallback } from 'react';
import { get, post, put } from '../../services/api-client';

// ─── Types ───────────────────────────────────────────────────────────────────

interface QueueItem {
  id: string;
  project_id: string;
  intelligence_item_id: string;
  status: 'selected' | 'in_progress' | 'published' | 'dropped';
  substack_post_id: string | null;
  coaching_session_id: string | null;
  notes: string | null;
  selected_at: string;
  published_at: string | null;
  news_title: string;
  news_source: string | null;
  news_source_name: string | null;
  news_summary: string | null;
  news_relevance_score: number | null;
  news_subcategory: string | null;
}

interface QueueResponse {
  items: QueueItem[];
}

type StatusGroup = 'selected' | 'in_progress' | 'published' | 'dropped';

// ─── Component ───────────────────────────────────────────────────────────────

export function PromptlyQueue() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchQueue = useCallback(async () => {
    setLoading(true);
    try {
      const data = await get<QueueResponse>('/api/promptly/queue');
      setItems(data.items);
    } catch (error) {
      console.error('Failed to fetch Promptly queue:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchQueue();
  }, [fetchQueue]);

  const handleStartCoaching = async (itemId: string) => {
    try {
      const result = await post<{ sessionId: string; projectId: string }>(
        `/api/promptly/queue/${itemId}/coach`
      );
      // Navigate to coaching session
      window.location.href = `/projects/${result.projectId}/coach?session=${result.sessionId}`;
    } catch (error) {
      console.error('Failed to start coaching session:', error);
    }
  };

  const handleUpdateStatus = async (itemId: string, status: StatusGroup) => {
    try {
      await put(`/api/promptly/queue/${itemId}`, { status });
      setItems((prev) =>
        prev.map((item) =>
          item.id === itemId ? { ...item, status } : item
        )
      );
    } catch (error) {
      console.error('Failed to update queue item:', error);
    }
  };

  const handleMarkPublished = async (itemId: string, substackPostId: string) => {
    try {
      await put(`/api/promptly/queue/${itemId}`, {
        status: 'published',
        substackPostId,
      });
      setItems((prev) =>
        prev.map((item) =>
          item.id === itemId
            ? { ...item, status: 'published' as const, substack_post_id: substackPostId }
            : item
        )
      );
    } catch (error) {
      console.error('Failed to mark as published:', error);
    }
  };

  // Group items by status
  const grouped = items.reduce<Record<StatusGroup, QueueItem[]>>(
    (acc, item) => {
      acc[item.status].push(item);
      return acc;
    },
    { selected: [], in_progress: [], published: [], dropped: [] }
  );

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <h1 className="text-2xl font-bold text-gray-900 mb-2">Promptly Queue</h1>
      <p className="text-sm text-gray-500 mb-6">
        Content pipeline for AI demystification posts
      </p>

      {items.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <p>No items in the queue yet.</p>
          <p className="text-sm mt-2">
            Select AI news items from the Intelligence Feed to start building your content pipeline.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {/* Selected */}
          <StatusSection
            title="Selected"
            description="Ready to start writing"
            items={grouped.selected}
            color="blue"
            onStartCoaching={handleStartCoaching}
            onUpdateStatus={handleUpdateStatus}
            onMarkPublished={handleMarkPublished}
          />

          {/* In Progress */}
          <StatusSection
            title="In Progress"
            description="Currently being written"
            items={grouped.in_progress}
            color="amber"
            onStartCoaching={handleStartCoaching}
            onUpdateStatus={handleUpdateStatus}
            onMarkPublished={handleMarkPublished}
          />

          {/* Published */}
          <StatusSection
            title="Published"
            description="Live on Substack"
            items={grouped.published}
            color="green"
            onStartCoaching={handleStartCoaching}
            onUpdateStatus={handleUpdateStatus}
            onMarkPublished={handleMarkPublished}
          />

          {/* Dropped */}
          {grouped.dropped.length > 0 && (
            <StatusSection
              title="Dropped"
              description="Not pursuing"
              items={grouped.dropped}
              color="gray"
              onStartCoaching={handleStartCoaching}
              onUpdateStatus={handleUpdateStatus}
              onMarkPublished={handleMarkPublished}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ─── Status Section ──────────────────────────────────────────────────────────

function StatusSection({
  title,
  description,
  items,
  color,
  onStartCoaching,
  onUpdateStatus,
  onMarkPublished,
}: {
  title: string;
  description: string;
  items: QueueItem[];
  color: 'blue' | 'amber' | 'green' | 'gray';
  onStartCoaching: (id: string) => void;
  onUpdateStatus: (id: string, status: StatusGroup) => void;
  onMarkPublished: (id: string, substackPostId: string) => void;
}) {
  if (items.length === 0) return null;

  const colorClasses = {
    blue: 'border-blue-200 bg-blue-50/50',
    amber: 'border-amber-200 bg-amber-50/50',
    green: 'border-emerald-200 bg-emerald-50/50',
    gray: 'border-gray-200 bg-gray-50/50',
  };

  const badgeClasses = {
    blue: 'bg-blue-100 text-blue-800',
    amber: 'bg-amber-100 text-amber-800',
    green: 'bg-emerald-100 text-emerald-800',
    gray: 'bg-gray-100 text-gray-800',
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
          {title}
        </h2>
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${badgeClasses[color]}`}>
          {items.length}
        </span>
        <span className="text-xs text-gray-400">{description}</span>
      </div>
      <div className="space-y-3">
        {items.map((item) => (
          <QueueItemCard
            key={item.id}
            item={item}
            colorClass={colorClasses[color]}
            onStartCoaching={onStartCoaching}
            onUpdateStatus={onUpdateStatus}
            onMarkPublished={onMarkPublished}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Queue Item Card ─────────────────────────────────────────────────────────

function QueueItemCard({
  item,
  colorClass,
  onStartCoaching,
  onUpdateStatus,
  onMarkPublished,
}: {
  item: QueueItem;
  colorClass: string;
  onStartCoaching: (id: string) => void;
  onUpdateStatus: (id: string, status: StatusGroup) => void;
  onMarkPublished: (id: string, substackPostId: string) => void;
}) {
  const [showPublishForm, setShowPublishForm] = useState(false);
  const [substackUrl, setSubstackUrl] = useState('');

  return (
    <div className={`border rounded-lg p-4 ${colorClass}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-gray-900">
            {item.news_source ? (
              <a
                href={item.news_source}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-blue-600"
              >
                {item.news_title}
              </a>
            ) : (
              item.news_title
            )}
          </h3>
          {item.news_summary && (
            <p className="text-sm text-gray-600 mt-1 line-clamp-2">{item.news_summary}</p>
          )}
          <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
            {item.news_source_name && <span>{item.news_source_name}</span>}
            <span>Selected {new Date(item.selected_at).toLocaleDateString()}</span>
            {item.coaching_session_id && (
              <span className="text-blue-600">Has coaching session</span>
            )}
            {item.substack_post_id && (
              <span className="text-green-600">Published</span>
            )}
          </div>
          {item.notes && (
            <p className="text-xs text-gray-500 mt-2 italic">Notes: {item.notes}</p>
          )}
        </div>

        <div className="flex flex-col gap-1 shrink-0">
          {/* Coaching button for selected/in_progress items */}
          {(item.status === 'selected' || item.status === 'in_progress') && (
            <button
              onClick={() => onStartCoaching(item.id)}
              className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded hover:bg-blue-700 transition-colors"
              aria-label={`Start coaching for ${item.news_title}`}
            >
              {item.coaching_session_id ? 'Continue' : 'Coach'}
            </button>
          )}

          {/* Status actions */}
          {item.status === 'selected' && (
            <button
              onClick={() => onUpdateStatus(item.id, 'dropped')}
              className="px-3 py-1 text-xs font-medium text-gray-500 bg-gray-50 rounded hover:bg-gray-100 transition-colors"
            >
              Drop
            </button>
          )}

          {item.status === 'in_progress' && (
            <>
              <button
                onClick={() => setShowPublishForm(!showPublishForm)}
                className="px-3 py-1 text-xs font-medium text-emerald-700 bg-emerald-50 rounded hover:bg-emerald-100 transition-colors"
              >
                Published
              </button>
              <button
                onClick={() => onUpdateStatus(item.id, 'dropped')}
                className="px-3 py-1 text-xs font-medium text-gray-500 bg-gray-50 rounded hover:bg-gray-100 transition-colors"
              >
                Drop
              </button>
            </>
          )}

          {item.status === 'dropped' && (
            <button
              onClick={() => onUpdateStatus(item.id, 'selected')}
              className="px-3 py-1 text-xs font-medium text-blue-700 bg-blue-50 rounded hover:bg-blue-100 transition-colors"
            >
              Reselect
            </button>
          )}
        </div>
      </div>

      {/* Publish form */}
      {showPublishForm && (
        <div className="mt-3 pt-3 border-t border-gray-200 flex items-center gap-2">
          <input
            type="text"
            value={substackUrl}
            onChange={(e) => setSubstackUrl(e.target.value)}
            placeholder="Substack post URL or ID"
            className="flex-1 text-sm border border-gray-300 rounded px-3 py-1.5 focus:ring-blue-500 focus:border-blue-500"
          />
          <button
            onClick={() => {
              if (substackUrl.trim()) {
                onMarkPublished(item.id, substackUrl.trim());
                setShowPublishForm(false);
                setSubstackUrl('');
              }
            }}
            className="px-3 py-1.5 text-xs font-medium text-white bg-emerald-600 rounded hover:bg-emerald-700 transition-colors"
          >
            Link
          </button>
        </div>
      )}
    </div>
  );
}
