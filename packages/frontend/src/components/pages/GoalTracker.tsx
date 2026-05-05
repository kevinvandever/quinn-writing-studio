import { useState } from 'react';
import { GoalTracker as GoalTrackerComponent } from '../accountability/GoalTracker';
import { useProjectStore } from '../../stores/projectStore';

/**
 * Goals page with project selector for creating goals.
 * Shows the cross-project dashboard, plus a project picker
 * that enables the "New Goal" button.
 */
export function GoalTracker() {
  const { projects } = useProjectStore();
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(undefined);

  return (
    <div className="space-y-4">
      {/* Project selector for goal creation */}
      <div className="flex items-center gap-3">
        <label htmlFor="goal-project" className="text-sm font-medium text-gray-700">
          Project:
        </label>
        <select
          id="goal-project"
          value={selectedProjectId || ''}
          onChange={(e) => setSelectedProjectId(e.target.value || undefined)}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
        >
          <option value="">All projects (dashboard)</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      <GoalTrackerComponent projectId={selectedProjectId} />
    </div>
  );
}
