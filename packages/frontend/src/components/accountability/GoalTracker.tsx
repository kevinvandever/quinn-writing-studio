import { useState, useEffect } from 'react';
import { get, post, put } from '../../services/api-client';

interface Goal {
  id: string;
  project_id: string;
  project_name?: string;
  goal_type: string;
  title: string;
  target_value: number;
  target_unit: string;
  period: string;
  current_value: number;
  status: string;
  behind_threshold: number;
  created_at: string;
  due_date: string | null;
}

interface DashboardResponse {
  goals: Goal[];
  summary: {
    totalGoals: number;
    onTrack: number;
    behindSchedule: number;
  };
}

interface GoalsListResponse {
  goals: Goal[];
}

interface GoalResponse {
  goal: Goal;
}

interface CreateGoalForm {
  goal_type: string;
  title: string;
  target_value: string;
  target_unit: string;
  period: string;
  due_date: string;
}

const INITIAL_FORM: CreateGoalForm = {
  goal_type: 'word_count',
  title: '',
  target_value: '',
  target_unit: 'words',
  period: 'weekly',
  due_date: '',
};

export function GoalTracker({ projectId }: { projectId?: string }) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [summary, setSummary] = useState<DashboardResponse['summary'] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<CreateGoalForm>(INITIAL_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadGoals();
  }, [projectId]);

  async function loadGoals() {
    try {
      if (projectId) {
        const data = await get<GoalsListResponse>(`/api/projects/${projectId}/goals`);
        setGoals(data.goals);
        setSummary(null);
      } else {
        const data = await get<DashboardResponse>('/api/goals/dashboard');
        setGoals(data.goals);
        setSummary(data.summary);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load goals');
    }
  }

  async function handleCreateGoal(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);

    try {
      await post<GoalResponse>(`/api/projects/${projectId}/goals`, {
        goal_type: form.goal_type,
        title: form.title,
        target_value: Number(form.target_value),
        target_unit: form.target_unit,
        period: form.period,
        due_date: form.due_date || undefined,
      });

      setForm(INITIAL_FORM);
      setShowForm(false);
      await loadGoals();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create goal');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleMarkComplete(goalId: string) {
    try {
      await put<GoalResponse>(`/api/goals/${goalId}`, { status: 'completed' });
      await loadGoals();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update goal');
    }
  }

  function getProgressPercentage(goal: Goal): number {
    if (goal.target_value === 0) return 0;
    return Math.min(100, Math.round((goal.current_value / goal.target_value) * 100));
  }

  function getProgressColor(goal: Goal): string {
    const ratio = goal.current_value / goal.target_value;
    if (ratio >= 1) return 'bg-green-500';
    if (ratio >= goal.behind_threshold) return 'bg-indigo-500';
    return 'bg-amber-500';
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">
            {projectId ? 'Project Goals' : 'Goals Dashboard'}
          </h2>
          <p className="text-gray-600 text-sm mt-1">
            {projectId
              ? 'Track your writing goals for this project'
              : 'All active goals across your projects'}
          </p>
        </div>
        {projectId && (
          <button
            onClick={() => setShowForm(!showForm)}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium
                       hover:bg-indigo-700 transition-colors"
          >
            {showForm ? 'Cancel' : '+ New Goal'}
          </button>
        )}
      </div>

      {/* Summary cards (dashboard mode) */}
      {summary && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <p className="text-sm text-gray-500">Active Goals</p>
            <p className="text-2xl font-bold text-gray-900">{summary.totalGoals}</p>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <p className="text-sm text-gray-500">On Track</p>
            <p className="text-2xl font-bold text-green-600">{summary.onTrack}</p>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <p className="text-sm text-gray-500">Behind Schedule</p>
            <p className="text-2xl font-bold text-amber-600">{summary.behindSchedule}</p>
          </div>
        </div>
      )}

      {/* Error display */}
      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-red-800 text-sm">
          {error}
        </div>
      )}

      {/* Create goal form */}
      {showForm && projectId && (
        <form onSubmit={handleCreateGoal} className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
          <h3 className="text-lg font-semibold text-gray-900">Create New Goal</h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="goal-type" className="block text-sm font-medium text-gray-700 mb-1">
                Goal Type
              </label>
              <select
                id="goal-type"
                value={form.goal_type}
                onChange={(e) => setForm({ ...form, goal_type: e.target.value })}
                className="w-full rounded-lg border border-gray-300 p-2.5 text-sm"
              >
                <option value="word_count">Word Count</option>
                <option value="session_frequency">Session Frequency</option>
                <option value="milestone">Milestone</option>
              </select>
            </div>

            <div>
              <label htmlFor="goal-period" className="block text-sm font-medium text-gray-700 mb-1">
                Period
              </label>
              <select
                id="goal-period"
                value={form.period}
                onChange={(e) => setForm({ ...form, period: e.target.value })}
                className="w-full rounded-lg border border-gray-300 p-2.5 text-sm"
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="total">Total</option>
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="goal-title" className="block text-sm font-medium text-gray-700 mb-1">
              Title
            </label>
            <input
              id="goal-title"
              type="text"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="e.g., Write 1000 words per week"
              className="w-full rounded-lg border border-gray-300 p-2.5 text-sm"
              required
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="goal-target" className="block text-sm font-medium text-gray-700 mb-1">
                Target Value
              </label>
              <input
                id="goal-target"
                type="number"
                value={form.target_value}
                onChange={(e) => setForm({ ...form, target_value: e.target.value })}
                placeholder="1000"
                min="1"
                className="w-full rounded-lg border border-gray-300 p-2.5 text-sm"
                required
              />
            </div>

            <div>
              <label htmlFor="goal-unit" className="block text-sm font-medium text-gray-700 mb-1">
                Unit
              </label>
              <input
                id="goal-unit"
                type="text"
                value={form.target_unit}
                onChange={(e) => setForm({ ...form, target_unit: e.target.value })}
                placeholder="words"
                className="w-full rounded-lg border border-gray-300 p-2.5 text-sm"
              />
            </div>
          </div>

          <div>
            <label htmlFor="goal-due-date" className="block text-sm font-medium text-gray-700 mb-1">
              Due Date (optional)
            </label>
            <input
              id="goal-due-date"
              type="date"
              value={form.due_date}
              onChange={(e) => setForm({ ...form, due_date: e.target.value })}
              className="w-full rounded-lg border border-gray-300 p-2.5 text-sm"
            />
          </div>

          <button
            type="submit"
            disabled={isSubmitting || !form.title || !form.target_value}
            className="w-full py-3 px-4 bg-indigo-600 text-white rounded-lg font-medium
                       hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isSubmitting ? 'Creating...' : 'Create Goal'}
          </button>
        </form>
      )}

      {/* Goals list */}
      <div className="space-y-3">
        {goals.length === 0 && !showForm && (
          <div className="text-center py-12 text-gray-500">
            <p className="text-lg">No goals yet</p>
            <p className="text-sm mt-1">
              {projectId ? 'Create a goal to start tracking your progress' : 'Set goals on your projects to see them here'}
            </p>
          </div>
        )}

        {goals.map((goal) => {
          const percentage = getProgressPercentage(goal);
          const progressColor = getProgressColor(goal);

          return (
            <div key={goal.id} className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-start justify-between mb-2">
                <div>
                  <h4 className="font-medium text-gray-900">{goal.title}</h4>
                  <div className="flex items-center gap-2 mt-1">
                    {goal.project_name && (
                      <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">
                        {goal.project_name}
                      </span>
                    )}
                    <span className="text-xs text-gray-500 capitalize">{goal.goal_type.replace('_', ' ')}</span>
                    <span className="text-xs text-gray-400">•</span>
                    <span className="text-xs text-gray-500 capitalize">{goal.period}</span>
                  </div>
                </div>
                <button
                  onClick={() => handleMarkComplete(goal.id)}
                  className="text-xs px-2 py-1 text-green-700 bg-green-50 rounded hover:bg-green-100 transition-colors"
                  aria-label={`Mark ${goal.title} as complete`}
                >
                  ✓ Complete
                </button>
              </div>

              {/* Progress bar */}
              <div className="mt-3">
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-gray-600">
                    {goal.current_value} / {goal.target_value} {goal.target_unit}
                  </span>
                  <span className="font-medium text-gray-900">{percentage}%</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2.5">
                  <div
                    className={`h-2.5 rounded-full transition-all ${progressColor}`}
                    style={{ width: `${percentage}%` }}
                    role="progressbar"
                    aria-valuenow={goal.current_value}
                    aria-valuemin={0}
                    aria-valuemax={goal.target_value}
                  />
                </div>
              </div>

              {/* Due date */}
              {goal.due_date && (
                <p className="text-xs text-gray-500 mt-2">
                  Due: {new Date(goal.due_date).toLocaleDateString()}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
