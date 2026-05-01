import { useState, useEffect, useCallback } from 'react';
import { get, post, del } from '../../services/api-client';
import { computeWordDiff, type DiffSegment } from '../../utils/diff';

interface Snapshot {
  id: string;
  document_id: string;
  word_count: number;
  trigger: string;
  created_at: string;
}

interface SnapshotContent {
  id: string;
  content: string;
  word_count: number;
  created_at: string;
}

interface DiffResponse {
  diff: {
    snapshotA: SnapshotContent;
    snapshotB: SnapshotContent;
    wordCountDelta: number;
  };
}

interface DraftVersionsProps {
  documentId: string;
  documentTitle?: string;
}

export function DraftVersions({ documentId, documentTitle }: DraftVersionsProps) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Diff comparison state
  const [selectedA, setSelectedA] = useState<string | null>(null);
  const [selectedB, setSelectedB] = useState<string | null>(null);
  const [diffData, setDiffData] = useState<DiffResponse['diff'] | null>(null);
  const [diffSegments, setDiffSegments] = useState<DiffSegment[]>([]);
  const [comparing, setComparing] = useState(false);

  const loadSnapshots = useCallback(async () => {
    try {
      setLoading(true);
      const result = await get<{ snapshots: Snapshot[] }>(
        `/api/documents/${documentId}/snapshots`
      );
      setSnapshots(result.snapshots);
      setError(null);
    } catch (err) {
      setError('Failed to load snapshots');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => {
    loadSnapshots();
  }, [loadSnapshots]);

  const createSnapshot = async () => {
    try {
      setCreating(true);
      await post(`/api/documents/${documentId}/snapshots`);
      await loadSnapshots();
    } catch (err) {
      setError('Failed to create snapshot');
      console.error(err);
    } finally {
      setCreating(false);
    }
  };

  const deleteSnapshot = async (snapshotId: string) => {
    try {
      await del(`/api/snapshots/${snapshotId}`);
      setSnapshots((prev) => prev.filter((s) => s.id !== snapshotId));
      if (selectedA === snapshotId) setSelectedA(null);
      if (selectedB === snapshotId) setSelectedB(null);
      setDiffData(null);
      setDiffSegments([]);
    } catch (err) {
      setError('Failed to delete snapshot');
      console.error(err);
    }
  };

  const compareDiff = async () => {
    if (!selectedA || !selectedB) return;

    try {
      setComparing(true);
      const result = await get<DiffResponse>(
        `/api/documents/${documentId}/snapshots/diff?a=${selectedA}&b=${selectedB}`
      );
      setDiffData(result.diff);
      setDiffSegments(
        computeWordDiff(result.diff.snapshotA.content, result.diff.snapshotB.content)
      );
    } catch (err) {
      setError('Failed to compare snapshots');
      console.error(err);
    } finally {
      setComparing(false);
    }
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">
            Draft Versions
          </h3>
          {documentTitle && (
            <p className="text-sm text-gray-500 mt-1">{documentTitle}</p>
          )}
        </div>
        <button
          onClick={createSnapshot}
          disabled={creating}
          className="inline-flex items-center px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {creating ? 'Creating...' : '+ Create Snapshot'}
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
          {error}
        </div>
      )}

      {/* Snapshot List */}
      {snapshots.length === 0 ? (
        <div className="text-center py-8 bg-gray-50 rounded-lg border border-gray-200">
          <p className="text-gray-500">No snapshots yet.</p>
          <p className="text-sm text-gray-400 mt-1">
            Create a snapshot to save the current state of this document.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Selection for comparison */}
          <div className="bg-gray-50 rounded-lg border border-gray-200 p-4">
            <p className="text-sm font-medium text-gray-700 mb-3">
              Select two snapshots to compare:
            </p>
            <div className="space-y-2">
              {snapshots.map((snapshot) => (
                <div
                  key={snapshot.id}
                  className="flex items-center justify-between bg-white rounded-md border border-gray-200 px-4 py-3"
                >
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-1 text-xs text-gray-500">
                        <input
                          type="radio"
                          name="snapshotA"
                          checked={selectedA === snapshot.id}
                          onChange={() => setSelectedA(snapshot.id)}
                          className="text-indigo-600"
                        />
                        A
                      </label>
                      <label className="flex items-center gap-1 text-xs text-gray-500">
                        <input
                          type="radio"
                          name="snapshotB"
                          checked={selectedB === snapshot.id}
                          onChange={() => setSelectedB(snapshot.id)}
                          className="text-indigo-600"
                        />
                        B
                      </label>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        {formatDate(snapshot.created_at)}
                      </p>
                      <p className="text-xs text-gray-500">
                        {snapshot.word_count?.toLocaleString() ?? 0} words •{' '}
                        <span className="capitalize">{snapshot.trigger.replace('_', ' ')}</span>
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => deleteSnapshot(snapshot.id)}
                    className="text-red-400 hover:text-red-600 text-sm transition-colors"
                    title="Delete snapshot"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>

            <button
              onClick={compareDiff}
              disabled={!selectedA || !selectedB || selectedA === selectedB || comparing}
              className="mt-3 inline-flex items-center px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {comparing ? 'Comparing...' : 'Compare Selected'}
            </button>
          </div>

          {/* Diff Viewer */}
          {diffData && (
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              {/* Diff Header */}
              <div className="bg-gray-50 border-b border-gray-200 px-4 py-3 flex items-center justify-between">
                <h4 className="text-sm font-medium text-gray-700">Comparison</h4>
                <div className="flex items-center gap-3 text-sm">
                  <span className="text-gray-500">
                    Word count delta:{' '}
                    <span
                      className={
                        diffData.wordCountDelta > 0
                          ? 'text-green-600 font-medium'
                          : diffData.wordCountDelta < 0
                            ? 'text-red-600 font-medium'
                            : 'text-gray-600'
                      }
                    >
                      {diffData.wordCountDelta > 0 ? '+' : ''}
                      {diffData.wordCountDelta}
                    </span>
                  </span>
                </div>
              </div>

              {/* Side-by-side diff content */}
              <div className="grid grid-cols-2 divide-x divide-gray-200">
                {/* Snapshot A (older) */}
                <div className="p-4">
                  <p className="text-xs text-gray-500 mb-2 font-medium">
                    Snapshot A — {formatDate(diffData.snapshotA.created_at)}
                  </p>
                  <div className="text-sm leading-relaxed whitespace-pre-wrap font-mono">
                    {diffSegments.map((segment, i) => {
                      if (segment.type === 'equal') {
                        return <span key={i}>{segment.text}</span>;
                      }
                      if (segment.type === 'remove') {
                        return (
                          <span
                            key={i}
                            className="bg-red-100 text-red-800 line-through"
                          >
                            {segment.text}
                          </span>
                        );
                      }
                      // 'add' segments don't appear in the A side
                      return null;
                    })}
                  </div>
                </div>

                {/* Snapshot B (newer) */}
                <div className="p-4">
                  <p className="text-xs text-gray-500 mb-2 font-medium">
                    Snapshot B — {formatDate(diffData.snapshotB.created_at)}
                  </p>
                  <div className="text-sm leading-relaxed whitespace-pre-wrap font-mono">
                    {diffSegments.map((segment, i) => {
                      if (segment.type === 'equal') {
                        return <span key={i}>{segment.text}</span>;
                      }
                      if (segment.type === 'add') {
                        return (
                          <span
                            key={i}
                            className="bg-green-100 text-green-800"
                          >
                            {segment.text}
                          </span>
                        );
                      }
                      // 'remove' segments don't appear in the B side
                      return null;
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
