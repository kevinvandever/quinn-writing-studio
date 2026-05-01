import { useState, useRef, useEffect } from 'react';
import { post } from '../../services/api-client';
import { useProjectStore, Project } from '../../stores/projectStore';

interface CreateCaptureResponse {
  capture: {
    id: string;
    user_id: string;
    project_id: string | null;
    content: string;
    status: string;
    created_at: string;
  };
}

export function QuickCapture() {
  const [content, setContent] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { projects, fetchProjects } = useProjectStore();

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  // Auto-focus the textarea on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleSubmit = async () => {
    if (!content.trim() || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);

    try {
      await post<CreateCaptureResponse>('/api/captures', {
        content: content.trim(),
        ...(selectedProjectId ? { project_id: selectedProjectId } : {}),
      });

      setContent('');
      setSelectedProjectId('');
      setShowSuccess(true);

      // Hide success message after 2 seconds
      setTimeout(() => {
        setShowSuccess(false);
        textareaRef.current?.focus();
      }, 2000);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save capture';
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-lg mx-auto px-4 py-6 space-y-5">
      <h2 className="text-2xl font-bold text-gray-900">Quick Capture</h2>
      <p className="text-gray-600 text-sm">
        Capture a thought, idea, or observation before it slips away.
      </p>

      {/* Success feedback */}
      {showSuccess && (
        <div className="rounded-lg bg-green-50 border border-green-200 p-4 text-green-800 text-sm font-medium animate-pulse">
          ✓ Captured successfully
        </div>
      )}

      {/* Error feedback */}
      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-red-800 text-sm">
          {error}
        </div>
      )}

      {/* Text input area */}
      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="What's on your mind?"
        rows={6}
        className="w-full rounded-lg border border-gray-300 p-4 text-base resize-none
                   focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500
                   placeholder-gray-400 min-h-[160px]"
        aria-label="Capture content"
      />

      {/* Optional project tag selector — horizontal scroll on mobile */}
      <div>
        <label htmlFor="project-select" className="block text-sm font-medium text-gray-700 mb-1">
          Tag with project (optional)
        </label>
        <select
          id="project-select"
          value={selectedProjectId}
          onChange={(e) => setSelectedProjectId(e.target.value)}
          className="w-full rounded-lg border border-gray-300 p-3 text-base
                     focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500
                     bg-white min-h-[48px] touch-manipulation"
          aria-label="Select project"
        >
          <option value="">No project (inbox)</option>
          {projects.map((project: Project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </div>

      {/* One-tap submit button — large touch target */}
      <button
        onClick={handleSubmit}
        disabled={!content.trim() || isSubmitting}
        className="w-full py-4 px-6 rounded-lg bg-indigo-600 text-white font-semibold text-lg
                   hover:bg-indigo-700 active:bg-indigo-800 active:scale-[0.98] transition-all
                   disabled:opacity-50 disabled:cursor-not-allowed
                   min-h-[56px] touch-manipulation"
        aria-label="Save capture"
      >
        {isSubmitting ? 'Saving...' : 'Capture'}
      </button>
    </div>
  );
}
