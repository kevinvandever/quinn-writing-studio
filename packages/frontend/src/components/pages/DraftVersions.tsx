import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get } from '../../services/api-client';
import { DraftVersions as DraftVersionsPanel } from '../drafts/DraftVersions';

interface DocumentDetail {
  id: string;
  title: string;
  content: string | null;
  word_count: number | null;
  is_folder: boolean;
}

/**
 * Route target for /projects/:id/drafts/:docId: a piece's saved versions
 * (Scrivener snapshots, the text before each sync changed it, and versions
 * saved here), compared with each other or with the current text.
 */
export function DraftVersions() {
  const { id: projectId, docId } = useParams<{ id: string; docId: string }>();
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!docId) return;
    let cancelled = false;
    setDoc(null);
    setError(null);
    get<{ document: DocumentDetail }>(`/api/corpus/documents/${docId}`)
      .then((data) => {
        if (!cancelled) setDoc(data.document);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't load the piece.");
      });
    return () => {
      cancelled = true;
    };
  }, [docId]);

  return (
    <div className="space-y-4">
      <Link to={`/projects/${projectId}/corpus`} className="text-sm text-indigo-600 hover:text-indigo-800">
        ← Back to the corpus
      </Link>
      {error ? (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>
      ) : !doc || !docId ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
        </div>
      ) : (
        <DraftVersionsPanel
          documentId={docId}
          documentTitle={doc.title}
          currentText={doc.content ?? ''}
          currentWords={doc.word_count ?? 0}
        />
      )}
    </div>
  );
}
