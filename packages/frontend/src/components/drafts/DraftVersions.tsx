import { useState, useEffect, useCallback } from 'react';
import { get, post, del } from '../../services/api-client';
import { computeWordDiff, type DiffSegment } from '../../utils/diff';

interface Snapshot {
  id: string;
  document_id: string;
  word_count: number;
  trigger: string;
  created_at: string;
  /** Set for snapshots that came from Scrivener ('Untitled Snapshot' when unnamed). */
  scrivener_title?: string | null;
}

interface SnapshotContent {
  id: string;
  content: string;
  word_count: number;
  /** Null for the current text. */
  created_at: string | null;
}

interface DiffData {
  snapshotA: SnapshotContent;
  snapshotB: SnapshotContent;
  wordCountDelta: number;
}

interface DraftVersionsProps {
  documentId: string;
  documentTitle?: string;
  /** The piece's text as of the last sync, offered as a version to compare with. */
  currentText?: string;
  currentWords?: number;
}

/** Selection id for the current text. */
const CURRENT = 'current';

/** Where a version came from, in words. */
function kindOf(snapshot: Snapshot): string {
  if (snapshot.trigger === 'pre_import_update') return 'The text before a sync changed it';
  if (snapshot.trigger === 'manual') {
    if (!snapshot.scrivener_title) return 'Saved in the app';
    return snapshot.scrivener_title === 'Untitled Snapshot'
      ? 'Scrivener snapshot'
      : `Scrivener snapshot: “${snapshot.scrivener_title}”`;
  }
  return snapshot.trigger.replace(/_/g, ' ');
}

export function DraftVersions({ documentId, documentTitle, currentText, currentWords }: DraftVersionsProps) {
  const hasCurrent = typeof currentText === 'string' && currentText.trim() !== '';
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Diff comparison state
  const [selectedA, setSelectedA] = useState<string | null>(null);
  const [selectedB, setSelectedB] = useState<string | null>(null);
  const [diffData, setDiffData] = useState<DiffData | null>(null);
  const [diffSegments, setDiffSegments] = useState<DiffSegment[]>([]);
  const [comparing, setComparing] = useState(false);

  const loadSnapshots = useCallback(async () => {
    try {
      setLoading(true);
      const result = await get<{ snapshots: Snapshot[] }>(
        `/api/documents/${documentId}/snapshots`
      );
      setSnapshots(result.snapshots);
      // Ready to compare the newest version with the current text.
      const newest = result.snapshots[0];
      if (newest && hasCurrent) {
        setSelectedA((a) => a ?? newest.id);
        setSelectedB((b) => b ?? CURRENT);
      }
      setError(null);
    } catch (err) {
      setError('Failed to load snapshots');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [documentId, hasCurrent]);

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

  const versionOf = async (id: string): Promise<SnapshotContent> =>
    id === CURRENT
      ? { id, content: currentText ?? '', word_count: currentWords ?? 0, created_at: null }
      : (await get<{ snapshot: SnapshotContent }>(`/api/snapshots/${id}`)).snapshot;

  const compareDiff = async () => {
    if (!selectedA || !selectedB) return;

    try {
      setComparing(true);
      const [a, b] = await Promise.all([versionOf(selectedA), versionOf(selectedB)]);
      setDiffData({ snapshotA: a, snapshotB: b, wordCountDelta: (b.word_count || 0) - (a.word_count || 0) });
      setDiffSegments(computeWordDiff(a.content, b.content));
    } catch (err) {
      setError('Failed to compare versions');
      console.error(err);
    } finally {
      setComparing(false);
    }
  };

  const versionLabel = (version: SnapshotContent): string =>
    version.created_at ? formatDate(version.created_at) : 'Current text';

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
          {creating ? 'Saving...' : '+ Save the current text as a version'}
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
          <p className="text-gray-500">No earlier versions yet.</p>
          <p className="text-sm text-gray-400 mt-1">
            Snapshots you take in Scrivener arrive with the next sync, and a sync that changes
            this piece keeps the text it replaced. You can also save the current text here.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Selection for comparison */}
          <div className="bg-gray-50 rounded-lg border border-gray-200 p-4">
            <p className="text-sm font-medium text-gray-700 mb-3">
              Pick two versions to compare (A is shown as the earlier one):
            </p>
            <div className="space-y-2">
              {hasCurrent && (
                <div className="flex items-center justify-between bg-white rounded-md border border-gray-200 px-4 py-3">
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-1 text-xs text-gray-500">
                        <input
                          type="radio"
                          name="snapshotA"
                          checked={selectedA === CURRENT}
                          onChange={() => setSelectedA(CURRENT)}
                          className="text-indigo-600"
                        />
                        A
                      </label>
                      <label className="flex items-center gap-1 text-xs text-gray-500">
                        <input
                          type="radio"
                          name="snapshotB"
                          checked={selectedB === CURRENT}
                          onChange={() => setSelectedB(CURRENT)}
                          className="text-indigo-600"
                        />
                        B
                      </label>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900">Current text</p>
                      <p className="text-xs text-gray-500">
                        {(currentWords ?? 0).toLocaleString()} words • As of the last Scrivener sync
                      </p>
                    </div>
                  </div>
                </div>
              )}
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
                        {snapshot.word_count?.toLocaleString() ?? 0} words • {kindOf(snapshot)}
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
              {comparing ? 'Comparing...' : 'Compare'}
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
                    A — {versionLabel(diffData.snapshotA)}
                  </p>
                  <div className="text-sm leading-relaxed whitespace-pre-wrap font-serif">
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
                    B — {versionLabel(diffData.snapshotB)}
                  </p>
                  <div className="text-sm leading-relaxed whitespace-pre-wrap font-serif">
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
