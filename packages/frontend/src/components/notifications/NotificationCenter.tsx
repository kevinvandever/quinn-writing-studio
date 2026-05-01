import { useState, useEffect } from 'react';
import { get, put, post } from '../../services/api-client';

interface Nudge {
  id: string;
  nudge_type: string;
  urgency: string;
  content: string;
  reference_id: string | null;
  created_at: string;
}

interface NudgesResponse {
  nudges: Nudge[];
}

export function NotificationCenter() {
  const [nudges, setNudges] = useState<Nudge[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [showVacationForm, setShowVacationForm] = useState(false);
  const [vacationStart, setVacationStart] = useState('');
  const [vacationEnd, setVacationEnd] = useState('');
  const [isSettingVacation, setIsSettingVacation] = useState(false);

  useEffect(() => {
    loadNudges();
  }, []);

  async function loadNudges() {
    try {
      const data = await get<NudgesResponse>('/api/nudges');
      setNudges(data.nudges);
    } catch {
      // Silently fail — notifications are non-critical
    }
  }

  async function handleAcknowledge(nudgeId: string) {
    try {
      await put(`/api/nudges/${nudgeId}/acknowledge`);
      setNudges((prev) => prev.filter((n) => n.id !== nudgeId));
    } catch {
      // Silently fail
    }
  }

  async function handleDismissAll() {
    for (const nudge of nudges) {
      await handleAcknowledge(nudge.id);
    }
  }

  async function handleSetVacation(e: React.FormEvent) {
    e.preventDefault();
    if (!vacationStart || !vacationEnd) return;

    setIsSettingVacation(true);
    try {
      await post('/api/nudges/vacation', {
        start_date: vacationStart,
        end_date: vacationEnd,
      });
      setShowVacationForm(false);
      setVacationStart('');
      setVacationEnd('');
    } catch {
      // Handle error silently
    } finally {
      setIsSettingVacation(false);
    }
  }

  async function handleClearVacation() {
    try {
      await post('/api/nudges/vacation', { clear: true });
    } catch {
      // Handle error silently
    }
  }

  function getUrgencyColor(urgency: string): string {
    switch (urgency) {
      case 'high':
        return 'border-l-red-400';
      case 'medium':
        return 'border-l-amber-400';
      default:
        return 'border-l-indigo-400';
    }
  }

  function getUrgencyIcon(urgency: string): string {
    switch (urgency) {
      case 'high':
        return '🔴';
      case 'medium':
        return '🟡';
      default:
        return '🔵';
    }
  }

  return (
    <div className="relative">
      {/* Notification bell button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative p-2 rounded-lg text-gray-600 hover:bg-gray-100 transition-colors"
        aria-label={`Notifications${nudges.length > 0 ? ` (${nudges.length} pending)` : ''}`}
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
          />
        </svg>
        {nudges.length > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-red-500 text-white text-xs rounded-full flex items-center justify-center">
            {nudges.length}
          </span>
        )}
      </button>

      {/* Notification overlay */}
      {isOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
            aria-hidden="true"
          />

          {/* Panel */}
          <div className="absolute right-0 top-full mt-2 w-80 sm:w-96 bg-white rounded-lg shadow-xl border border-gray-200 z-50 max-h-[80vh] overflow-hidden flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
              <h3 className="font-semibold text-gray-900">Quinn's Notes</h3>
              <div className="flex items-center gap-2">
                {nudges.length > 0 && (
                  <button
                    onClick={handleDismissAll}
                    className="text-xs text-gray-500 hover:text-gray-700"
                  >
                    Dismiss all
                  </button>
                )}
              </div>
            </div>

            {/* Nudges list */}
            <div className="flex-1 overflow-y-auto">
              {nudges.length === 0 ? (
                <div className="px-4 py-8 text-center text-gray-500">
                  <p className="text-sm">No pending messages from Quinn</p>
                </div>
              ) : (
                <div className="divide-y divide-gray-50">
                  {nudges.map((nudge) => (
                    <div
                      key={nudge.id}
                      className={`px-4 py-3 border-l-4 ${getUrgencyColor(nudge.urgency)} hover:bg-gray-50`}
                    >
                      <div className="flex items-start gap-2">
                        <span className="text-sm mt-0.5">{getUrgencyIcon(nudge.urgency)}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-gray-800 leading-relaxed">{nudge.content}</p>
                          <div className="flex items-center justify-between mt-2">
                            <span className="text-xs text-gray-400">
                              {new Date(nudge.created_at).toLocaleDateString()}
                            </span>
                            <button
                              onClick={() => handleAcknowledge(nudge.id)}
                              className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
                            >
                              Got it
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Vacation mode section */}
            <div className="border-t border-gray-100 px-4 py-3">
              {!showVacationForm ? (
                <div className="flex items-center justify-between">
                  <button
                    onClick={() => setShowVacationForm(true)}
                    className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1"
                  >
                    🏖️ Set vacation mode
                  </button>
                  <button
                    onClick={handleClearVacation}
                    className="text-xs text-gray-400 hover:text-gray-600"
                  >
                    Clear vacation
                  </button>
                </div>
              ) : (
                <form onSubmit={handleSetVacation} className="space-y-2">
                  <p className="text-xs font-medium text-gray-700">Planned break</p>
                  <div className="flex gap-2">
                    <input
                      type="date"
                      value={vacationStart}
                      onChange={(e) => setVacationStart(e.target.value)}
                      className="flex-1 text-xs border border-gray-300 rounded px-2 py-1"
                      aria-label="Vacation start date"
                      required
                    />
                    <input
                      type="date"
                      value={vacationEnd}
                      onChange={(e) => setVacationEnd(e.target.value)}
                      className="flex-1 text-xs border border-gray-300 rounded px-2 py-1"
                      aria-label="Vacation end date"
                      required
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      disabled={isSettingVacation}
                      className="text-xs px-3 py-1 bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {isSettingVacation ? 'Setting...' : 'Set'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowVacationForm(false)}
                      className="text-xs px-3 py-1 text-gray-600 hover:text-gray-800"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
