import { useState, useEffect, useCallback } from 'react';
import { get, post } from '../../services/api-client';

interface CorpusDoc {
  id: string;
  title: string | null;
  source_type: string;
  word_count: number | null;
  is_folder?: boolean;
  children?: CorpusDoc[];
}

function flatten(docs: CorpusDoc[]): CorpusDoc[] {
  return docs.flatMap((d) => [d, ...(d.children ? flatten(d.children) : [])]);
}

/**
 * Add standalone drafts to a project's corpus (source_type='manual_upload') so
 * Quinn can analyze them by name without the writer pasting the text each time.
 * Used for Substack/Promptly projects, which have no Scrivener import.
 */
export function DraftUploader({ projectId }: { projectId: string }) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<CorpusDoc[]>([]);

  const loadDrafts = useCallback(async () => {
    try {
      const data = await get<{ documents: CorpusDoc[] }>(`/api/projects/${projectId}/corpus`);
      const manual = flatten(data.documents ?? []).filter(
        (d) => !d.is_folder && d.source_type === 'manual_upload'
      );
      setDrafts(manual);
    } catch {
      // Non-fatal — the list is a convenience.
    }
  }, [projectId]);

  useEffect(() => {
    void loadDrafts();
  }, [loadDrafts]);

  const handleAdd = async () => {
    if (!title.trim() || !content.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await post(`/api/projects/${projectId}/drafts/upload`, {
        title: title.trim(),
        content,
      });
      setTitle('');
      setContent('');
      await loadDrafts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add draft');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-6 border border-warm-200 rounded-xl bg-white p-5">
      <h3 className="font-serif text-lg text-ink">Add a draft for Quinn</h3>
      <p className="text-sm text-ink-muted mt-1 mb-4 leading-relaxed">
        Paste a draft here once and it joins this project&apos;s corpus. After that, just name it in
        a session (e.g. &ldquo;<span className="italic">analyze my draft &lsquo;Title&rsquo;</span>&rdquo;
        or <span className="font-mono">/editorial-pass Title</span>) and Quinn works from the full
        text — no re-pasting.
      </p>

      {drafts.length > 0 && (
        <div className="mb-4">
          <p className="text-xs font-medium text-warm-500 uppercase tracking-wide mb-2">
            Drafts in this corpus
          </p>
          <ul className="space-y-1">
            {drafts.map((d) => (
              <li key={d.id} className="text-sm text-ink flex items-baseline justify-between gap-3">
                <span className="truncate">{d.title || 'Untitled'}</span>
                <span className="text-warm-400 flex-shrink-0">
                  {(d.word_count ?? 0).toLocaleString()} words
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-3">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Draft title (how you'll refer to it)"
          className="w-full rounded-lg border border-warm-300 bg-white px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-sage-400 focus:border-transparent"
        />
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={10}
          placeholder="Paste the draft text..."
          className="w-full resize-y rounded-lg border border-warm-300 bg-white px-3 py-2 text-sm text-ink leading-relaxed focus:outline-none focus:ring-2 focus:ring-sage-400 focus:border-transparent"
        />
        <div className="flex items-center gap-3">
          <button
            onClick={handleAdd}
            disabled={!title.trim() || !content.trim() || saving}
            className="px-4 py-2 text-sm font-medium text-white bg-sage-600 rounded-lg hover:bg-sage-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? 'Adding...' : 'Add draft'}
          </button>
          {error && <span className="text-sm text-red-700">{error}</span>}
        </div>
      </div>
    </div>
  );
}
