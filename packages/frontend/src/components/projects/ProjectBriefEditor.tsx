import { useState, useEffect } from 'react';
import { useProjectStore, Project } from '../../stores/projectStore';

/**
 * Editor for a project's "brief" — the description that Quinn reads on every
 * coaching turn. The natural home for review-scope instructions (which folders
 * are the active manuscript vs. scratched/reference).
 */
export function ProjectBriefEditor({ project }: { project: Project }) {
  const updateProject = useProjectStore((s) => s.updateProject);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(project.description ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  // Keep the textarea in sync if the active project changes.
  useEffect(() => {
    setText(project.description ?? '');
    setJustSaved(false);
    setError(null);
  }, [project.id, project.description]);

  const dirty = text !== (project.description ?? '');

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateProject(project.id, { description: text });
      setJustSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mb-6 border border-warm-200 rounded-xl bg-warm-50">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-3 text-left"
        aria-expanded={open}
      >
        <span className="font-serif text-ink font-medium">Quinn&apos;s brief for this project</span>
        <span className="text-sm text-ink-muted">{open ? 'Hide' : 'Edit'}</span>
      </button>

      {open && (
        <div className="px-5 pb-5">
          <p className="text-sm text-ink-muted mb-3 leading-relaxed">
            Quinn reads this every session. Use it to set scope — which folders are the active
            manuscript, and which to treat as scratched or reference. She&apos;ll still see the full
            binder, but she&apos;ll follow what you say here.
          </p>
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setJustSaved(false);
            }}
            rows={10}
            className="w-full resize-y rounded-lg border border-warm-300 bg-white px-3 py-2 text-sm text-ink leading-relaxed focus:outline-none focus:ring-2 focus:ring-sage-400 focus:border-transparent"
            placeholder="Describe the project and tell Quinn what to focus on..."
            aria-label="Project brief"
          />
          <div className="flex items-center gap-3 mt-3">
            <button
              onClick={handleSave}
              disabled={!dirty || saving}
              className="px-4 py-2 text-sm font-medium text-white bg-sage-600 rounded-lg hover:bg-sage-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? 'Saving...' : 'Save brief'}
            </button>
            {justSaved && !dirty && <span className="text-sm text-sage-700">Saved</span>}
            {error && <span className="text-sm text-red-700">{error}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
