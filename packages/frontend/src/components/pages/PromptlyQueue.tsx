import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { get, put, post } from '../../services/api-client';

interface QueueItem {
  id: string;
  project_id: string;
  intelligence_item_id: string;
  status: string;
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

export function PromptlyQueue() {
  const { id: projectId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [editingNotes, setEditingNotes] = useState<string | null>(null);
  const [notesValue, setNotesValue] = useState('');

  const loadQueue = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (projectId) params.set('projectId', projectId);

      const data = await get<QueueResponse>(`/api/promptly/queue?${params.toString()}`);
      setItems(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load queue');
    } finally {
      setLoading(false);
    }
  }, [projectId, statusFilter]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  async function updateStatus(itemId: string, newStatus: string) {
    try {
      await put(`/api/promptly/queue/${itemId}`, { status: newStatus });
      await loadQueue();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update');
    }
  }

  async function saveNotes(itemId: string) {
    try {
      await put(`/api/promptly/queue/${itemId}`, { notes: notesValue });
      setEditingNotes(null);
      await loadQueue();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save notes');
    }
  }

  async function startCoaching(itemId: string) {
    try {
      const result = await post<{ sessionId: string; projectId: string }>(
        `/api/promptly/queue/${itemId}/coach`
      );
      navigate(`/projects/${result.projectId}/coach`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start coaching');
    }
  }

  function getStatusColor(status: string): string {
    switch (status) {
      case 'selected': return 'bg-blue-100 text-blue-700';
      case 'in_progress': return 'bg-amber-100 text-amber-700';
      case 'published': return 'bg-green-100 text-green-700';
      case 'dropped': return 'bg-gray-100 text-gray-500';
      default: return 'bg-gray-100 text-gray-600';
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Promptly Queue</h2>
          <p className="text-gray-600 text-sm mt-1">
            Your AI demystification content pipeline
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            aria-label="Filter by status"
          >
            <option value="">All</option>
            <option value="selected">Selected</option>
            <option value="in_progress">In Progress</option>
            <option value="published">Published</option>
            <option value="dropped">Dropped</option>
          </select>
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-red-800 text-sm">
          {error}
        </div>
      )}

      {items.length === 0 && (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
          <p className="text-lg text-gray-600">No items in the queue</p>
          <p className="text-sm text-gray-500 mt-2">
            Select AI news items from the Intelligence Feed to add them to your Promptly content pipeline.
          </p>
        </div>
      )}

      <div className="space-y-4">
        {items.map((item) => (
          <div key={item.id} className="bg-white rounded-lg border border-gray-200 p-5">
            {/* Header */}
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-semibold text-gray-900">{item.news_title}</h3>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${getStatusColor(item.status)}`}>
                    {item.status.replace('_', ' ')}
                  </span>
                </div>
                {item.news_summary && (
                  <p className="text-sm text-gray-600 mt-1">{item.news_summary}</p>
                )}
                <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                  {item.news_source_name && <span>{item.news_source_name}</span>}
                  {item.news_relevance_score != null && (
                    <span>Relevance: {Math.round(item.news_relevance_score * 100)}%</span>
                  )}
                  <span>Selected: {new Date(item.selected_at).toLocaleDateString()}</span>
                  {item.published_at && (
                    <span className="text-green-600">
                      Published: {new Date(item.published_at).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Notes */}
            {editingNotes === item.id ? (
              <div className="mt-3 space-y-2">
                <textarea
                  value={notesValue}
                  onChange={(e) => setNotesValue(e.target.value)}
                  placeholder="Notes on angle, framing, approach..."
                  className="w-full rounded-md border border-gray-300 p-2.5 text-sm resize-y min-h-[80px]"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => saveNotes(item.id)}
                    className="text-xs px-3 py-1.5 bg-indigo-600 text-white rounded-md hover:bg-indigo-700"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setEditingNotes(null)}
                    className="text-xs px-3 py-1.5 text-gray-600 hover:text-gray-800"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : item.notes ? (
              <div className="mt-3 bg-gray-50 rounded-md p-3">
                <p className="text-sm text-gray-700 italic">{item.notes}</p>
                <button
                  onClick={() => { setEditingNotes(item.id); setNotesValue(item.notes || ''); }}
                  className="text-xs text-indigo-600 hover:text-indigo-700 mt-1"
                >
                  Edit notes
                </button>
              </div>
            ) : null}

            {/* Actions */}
            <div className="mt-4 flex items-center gap-2 flex-wrap">
              {item.status === 'selected' && (
                <>
                  <button
                    onClick={() => startCoaching(item.id)}
                    className="text-sm px-3 py-1.5 bg-indigo-600 text-white rounded-md hover:bg-indigo-700"
                  >
                    💬 Coach on this
                  </button>
                  <button
                    onClick={() => updateStatus(item.id, 'in_progress')}
                    className="text-sm px-3 py-1.5 bg-amber-50 text-amber-700 rounded-md hover:bg-amber-100"
                  >
                    Start writing
                  </button>
                  <button
                    onClick={() => { setEditingNotes(item.id); setNotesValue(item.notes || ''); }}
                    className="text-sm px-3 py-1.5 text-gray-600 hover:bg-gray-100 rounded-md"
                  >
                    ✏️ Add notes
                  </button>
                  <button
                    onClick={() => updateStatus(item.id, 'dropped')}
                    className="text-sm px-3 py-1.5 text-gray-400 hover:text-gray-600"
                  >
                    Drop
                  </button>
                </>
              )}
              {item.status === 'in_progress' && (
                <>
                  <button
                    onClick={() => startCoaching(item.id)}
                    className="text-sm px-3 py-1.5 bg-indigo-600 text-white rounded-md hover:bg-indigo-700"
                  >
                    💬 Continue coaching
                  </button>
                  <button
                    onClick={() => updateStatus(item.id, 'published')}
                    className="text-sm px-3 py-1.5 bg-green-50 text-green-700 rounded-md hover:bg-green-100"
                  >
                    ✓ Mark published
                  </button>
                  <button
                    onClick={() => { setEditingNotes(item.id); setNotesValue(item.notes || ''); }}
                    className="text-sm px-3 py-1.5 text-gray-600 hover:bg-gray-100 rounded-md"
                  >
                    ✏️ Notes
                  </button>
                  <button
                    onClick={() => updateStatus(item.id, 'dropped')}
                    className="text-sm px-3 py-1.5 text-gray-400 hover:text-gray-600"
                  >
                    Drop
                  </button>
                </>
              )}
              {item.status === 'published' && item.news_source && (
                <a
                  href={item.news_source}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-indigo-600 hover:text-indigo-700"
                >
                  View source ↗
                </a>
              )}
              {item.status === 'dropped' && (
                <button
                  onClick={() => updateStatus(item.id, 'selected')}
                  className="text-sm px-3 py-1.5 text-gray-600 hover:bg-gray-100 rounded-md"
                >
                  ↩ Restore
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
