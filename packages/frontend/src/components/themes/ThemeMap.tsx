import { useState, useEffect } from 'react';
import { get, post } from '../../services/api-client';

interface ThemeConnection {
  id: string;
  document_a_id: string;
  document_a_title: string;
  document_a_project: string;
  document_b_id: string;
  document_b_title: string;
  document_b_project: string;
  theme: string;
  explanation: string;
  strength: number;
  discovered_at: string;
}

interface ThemeGroup {
  theme: string;
  connectionCount: number;
  avgStrength: number;
  connections: ThemeConnection[];
}

interface ThemeMapResponse {
  connections: ThemeConnection[];
  themes: ThemeGroup[];
}

interface AnalyzeResponse {
  connections: ThemeConnection[];
  count: number;
  message: string;
}

export function ThemeMap() {
  const [themes, setThemes] = useState<ThemeGroup[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedTheme, setExpandedTheme] = useState<string | null>(null);

  useEffect(() => {
    loadThemes();
  }, []);

  async function loadThemes() {
    try {
      setIsLoading(true);
      const data = await get<ThemeMapResponse>('/api/themes');
      setThemes(data.themes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load themes');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleAnalyze() {
    setIsAnalyzing(true);
    setError(null);
    try {
      await post<AnalyzeResponse>('/api/themes/analyze');
      await loadThemes();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      setIsAnalyzing(false);
    }
  }

  function getStrengthLabel(strength: number): string {
    if (strength >= 0.8) return 'Strong';
    if (strength >= 0.6) return 'Moderate';
    return 'Light';
  }

  function getStrengthColor(strength: number): string {
    if (strength >= 0.8) return 'bg-indigo-100 text-indigo-800';
    if (strength >= 0.6) return 'bg-blue-100 text-blue-800';
    return 'bg-gray-100 text-gray-700';
  }

  if (isLoading) {
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
          <h2 className="text-2xl font-bold text-gray-900">Theme Map</h2>
          <p className="text-gray-600 text-sm mt-1">
            Cross-project thematic connections in your writing
          </p>
        </div>
        <button
          onClick={handleAnalyze}
          disabled={isAnalyzing}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium
                     hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isAnalyzing ? 'Analyzing...' : '🔍 Analyze Themes'}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-red-800 text-sm">
          {error}
        </div>
      )}

      {/* Empty state */}
      {themes.length === 0 && !error && (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
          <p className="text-lg text-gray-600">No themes discovered yet</p>
          <p className="text-sm text-gray-500 mt-2">
            Click "Analyze Themes" to scan your corpus for cross-project connections
          </p>
        </div>
      )}

      {/* Theme groups */}
      <div className="space-y-4">
        {themes.map((group) => (
          <div key={group.theme} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            {/* Theme header */}
            <button
              onClick={() => setExpandedTheme(expandedTheme === group.theme ? null : group.theme)}
              className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition-colors text-left"
              aria-expanded={expandedTheme === group.theme}
            >
              <div className="flex items-center gap-3">
                <span className="text-lg">🔗</span>
                <div>
                  <h3 className="font-semibold text-gray-900">{group.theme}</h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {group.connectionCount} connection{group.connectionCount !== 1 ? 's' : ''}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className={`text-xs px-2 py-0.5 rounded-full ${getStrengthColor(group.avgStrength)}`}>
                  {getStrengthLabel(group.avgStrength)}
                </span>
                <svg
                  className={`w-4 h-4 text-gray-400 transition-transform ${
                    expandedTheme === group.theme ? 'rotate-180' : ''
                  }`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </button>

            {/* Expanded connections */}
            {expandedTheme === group.theme && (
              <div className="border-t border-gray-100 divide-y divide-gray-50">
                {group.connections.map((conn) => (
                  <div key={conn.id} className="px-5 py-3">
                    <div className="flex items-center gap-2 text-sm">
                      <div className="flex-1 min-w-0">
                        <span className="font-medium text-gray-900">{conn.document_a_title}</span>
                        <span className="text-gray-400 mx-1">({conn.document_a_project})</span>
                      </div>
                      <span className="text-gray-300 flex-shrink-0">↔</span>
                      <div className="flex-1 min-w-0 text-right">
                        <span className="font-medium text-gray-900">{conn.document_b_title}</span>
                        <span className="text-gray-400 mx-1">({conn.document_b_project})</span>
                      </div>
                    </div>
                    <p className="text-sm text-gray-600 mt-2 italic">{conn.explanation}</p>
                    <div className="flex items-center gap-2 mt-2">
                      <div className="flex-1 bg-gray-200 rounded-full h-1.5">
                        <div
                          className="bg-indigo-500 h-1.5 rounded-full"
                          style={{ width: `${conn.strength * 100}%` }}
                        />
                      </div>
                      <span className="text-xs text-gray-500">{Math.round(conn.strength * 100)}%</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
