import { useState, useEffect, useCallback } from 'react';
import { get, put, del } from '../../services/api-client';
import { useProjectStore, Project } from '../../stores/projectStore';

interface Capture {
  id: string;
  user_id: string;
  project_id: string | null;
  content: string;
  status: string;
  created_at: string;
}

interface CapturesResponse {
  captures: Capture[];
  total: number;
  limit: number;
  offset: number;
}

type StatusFilter = 'inbox' | 'triaged' | 'dismissed' | '';

export function CaptureInbox() {
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('inbox');
  const [projectFilter, setProjectFilter] = useState<string>('');
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');

  // Re-tag modal state
  const [retagCaptureId, setRetagCaptureId] = useState<string | null>(null);
  const [retagProjectId, setRetagProjectId] = useState<string>('');

  const { projects, fetchProjects } = useProjectStore();

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const loadCaptures = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (projectFilter) params.set('project_id', projectFilter);
      if (fromDate) params.set('from', new Date(fromDate).toISOString());
      if (toDate) params.set('to', new Date(toDate + 'T23:59:59').toISOString());

      const queryString = params.toString();
      const path = `/api/captures${queryString ? `?${queryString}` : ''}`;
      const response = await get<CapturesResponse>(path);

      setCaptures(response.captures);
      setTotal(response.total);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load captures';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [statusFilter, projectFilter, fromDate, toDate]);

  useEffect(() => {
    loadCaptures();
  }, [loadCaptures]);

  const handleTriage = async (captureId: string) => {
    try {
      await put(`/api/captures/${captureId}`, { status: 'triaged' });
      setCaptures((prev) => prev.filter((c) => c.id !== captureId));
      setTotal((prev) => prev - 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to triage capture';
      setError(message);
    }
  };

  const handleDismiss = async (captureId: string) => {
    try {
      await put(`/api/captures/${captureId}`, { status: 'dismissed' });
      setCaptures((prev) => prev.filter((c) => c.id !== captureId));
      setTotal((prev) => prev - 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to dismiss capture';
      setError(message);
    }
  };

  const handleDelete = async (captureId: string) => {
    try {
      await del(`/api/captures/${captureId}`);
      setCaptures((prev) => prev.filter((c) => c.id !== captureId));
      setTotal((prev) => prev - 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete capture';
      setError(message);
    }
  };

  const handleRetag = async () => {
    if (!retagCaptureId) return;

    try {
      await put(`/api/captures/${retagCaptureId}`, {
        project_id: retagProjectId || null,
      });
      setCaptures((prev) =>
        prev.map((c) =>
          c.id === retagCaptureId
            ? { ...c, project_id: retagProjectId || null }
            : c
        )
      );
      setRetagCaptureId(null);
      setRetagProjectId('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to re-tag capture';
      setError(message);
    }
  };

  const getProjectName = (projectId: string | null): string => {
    if (!projectId) return 'Untagged';
    const project = projects.find((p: Project) => p.id === projectId);
    return project?.name ?? 'Unknown project';
  };

  const formatDate = (dateStr: string): string => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-900">Capture Inbox</h2>
        <span className="text-sm text-gray-500">{total} captures</span>
      </div>

      {/* Filters */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="rounded-lg border border-gray-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          <option value="inbox">Inbox</option>
          <option value="triaged">Triaged</option>
          <option value="dismissed">Dismissed</option>
        </select>

        <select
          value={projectFilter}
          onChange={(e) => setProjectFilter(e.target.value)}
          className="rounded-lg border border-gray-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          aria-label="Filter by project"
        >
          <option value="">All projects</option>
          {projects.map((project: Project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>

        <input
          type="date"
          value={fromDate}
          onChange={(e) => setFromDate(e.target.value)}
          className="rounded-lg border border-gray-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          aria-label="From date"
          placeholder="From"
        />

        <input
          type="date"
          value={toDate}
          onChange={(e) => setToDate(e.target.value)}
          className="rounded-lg border border-gray-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          aria-label="To date"
          placeholder="To"
        />
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-red-800 text-sm">
          {error}
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="flex justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
        </div>
      )}

      {/* Empty state */}
      {!isLoading && captures.length === 0 && (
        <div className="text-center py-12 text-gray-500">
          <p className="text-lg">No captures found</p>
          <p className="text-sm mt-1">Try adjusting your filters or capture a new idea.</p>
        </div>
      )}

      {/* Capture feed */}
      {!isLoading && captures.length > 0 && (
        <div className="space-y-3">
          {captures.map((capture) => (
            <div
              key={capture.id}
              className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm space-y-3"
            >
              <div className="flex items-start justify-between gap-3">
                <p className="text-gray-900 text-sm whitespace-pre-wrap flex-1">
                  {capture.content}
                </p>
                <span className="text-xs text-gray-400 whitespace-nowrap">
                  {formatDate(capture.created_at)}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700">
                  {getProjectName(capture.project_id)}
                </span>

                {/* Triage actions */}
                <div className="flex items-center gap-2">
                  {capture.status === 'inbox' && (
                    <>
                      <button
                        onClick={() => handleTriage(capture.id)}
                        className="px-3 py-1.5 text-xs font-medium rounded-md bg-green-50 text-green-700
                                   hover:bg-green-100 transition-colors min-h-[32px] touch-manipulation"
                        title="Move to corpus (triaged)"
                      >
                        Triage
                      </button>
                      <button
                        onClick={() => handleDismiss(capture.id)}
                        className="px-3 py-1.5 text-xs font-medium rounded-md bg-yellow-50 text-yellow-700
                                   hover:bg-yellow-100 transition-colors min-h-[32px] touch-manipulation"
                        title="Dismiss"
                      >
                        Dismiss
                      </button>
                      <button
                        onClick={() => {
                          setRetagCaptureId(capture.id);
                          setRetagProjectId(capture.project_id ?? '');
                        }}
                        className="px-3 py-1.5 text-xs font-medium rounded-md bg-indigo-50 text-indigo-700
                                   hover:bg-indigo-100 transition-colors min-h-[32px] touch-manipulation"
                        title="Re-tag to different project"
                      >
                        Re-tag
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => handleDelete(capture.id)}
                    className="px-3 py-1.5 text-xs font-medium rounded-md bg-red-50 text-red-700
                               hover:bg-red-100 transition-colors min-h-[32px] touch-manipulation"
                    title="Delete permanently"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Re-tag modal */}
      {retagCaptureId && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg p-6 w-full max-w-sm space-y-4 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900">Re-tag Capture</h3>
            <select
              value={retagProjectId}
              onChange={(e) => setRetagProjectId(e.target.value)}
              className="w-full rounded-lg border border-gray-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              aria-label="Select new project"
            >
              <option value="">No project (inbox)</option>
              {projects.map((project: Project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <div className="flex gap-3">
              <button
                onClick={handleRetag}
                className="flex-1 py-2 px-4 rounded-lg bg-indigo-600 text-white font-medium
                           hover:bg-indigo-700 transition-colors"
              >
                Save
              </button>
              <button
                onClick={() => {
                  setRetagCaptureId(null);
                  setRetagProjectId('');
                }}
                className="flex-1 py-2 px-4 rounded-lg border border-gray-300 text-gray-700 font-medium
                           hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
