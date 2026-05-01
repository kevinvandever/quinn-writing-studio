import { useState, useEffect, useCallback } from 'react';
import { get, put, post } from '../../services/api-client';

interface ValidationError {
  path: string;
  message: string;
}

interface PersonaResponse {
  persona: {
    id: string;
    name: string;
    is_active: boolean;
    config: unknown;
    created_at: string;
    updated_at: string;
  };
}

interface PersonaListResponse {
  personas: Array<{
    id: string;
    name: string;
    is_active: boolean;
    config: unknown;
    created_at: string;
    updated_at: string;
  }>;
}

interface ValidateResponse {
  valid: boolean;
  errors: ValidationError[];
}

export function PersonaEditor() {
  const [personaId, setPersonaId] = useState<string | null>(null);
  const [configJson, setConfigJson] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const [successMessage, setSuccessMessage] = useState('');
  const [parseError, setParseError] = useState('');

  const loadPersona = useCallback(async () => {
    try {
      setLoading(true);
      const data = await get<PersonaListResponse>('/api/personas');
      const active = data.personas.find((p) => p.is_active);

      if (active) {
        setPersonaId(active.id);
        setConfigJson(JSON.stringify(active.config, null, 2));
      } else {
        const first = data.personas[0];
        if (first) {
          setPersonaId(first.id);
          setConfigJson(JSON.stringify(first.config, null, 2));
        }
      }
    } catch (err) {
      console.error('Failed to load persona:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPersona();
  }, [loadPersona]);

  const handleJsonChange = (value: string) => {
    setConfigJson(value);
    setParseError('');
    setErrors([]);
    setSuccessMessage('');
  };

  const parseConfig = (): unknown | null => {
    try {
      const parsed = JSON.parse(configJson);
      setParseError('');
      return parsed;
    } catch (e) {
      setParseError(e instanceof Error ? e.message : 'Invalid JSON');
      return null;
    }
  };

  const handleValidate = async () => {
    const config = parseConfig();
    if (!config || !personaId) return;

    try {
      setValidating(true);
      setErrors([]);
      setSuccessMessage('');

      const result = await post<ValidateResponse>(
        `/api/personas/${personaId}/validate`,
        config
      );

      if (result.valid) {
        setSuccessMessage('Configuration is valid');
      } else {
        setErrors(result.errors);
      }
    } catch (err) {
      console.error('Validation failed:', err);
    } finally {
      setValidating(false);
    }
  };

  const handleSave = async () => {
    const config = parseConfig();
    if (!config || !personaId) return;

    try {
      setSaving(true);
      setErrors([]);
      setSuccessMessage('');

      const result = await put<PersonaResponse>(
        `/api/personas/${personaId}`,
        config
      );

      setConfigJson(JSON.stringify(result.persona.config, null, 2));
      setSuccessMessage('Persona configuration saved successfully');
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'details' in err) {
        const apiErr = err as { details?: ValidationError[] };
        if (Array.isArray(apiErr.details)) {
          setErrors(apiErr.details);
        }
      } else {
        console.error('Save failed:', err);
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <p className="text-gray-500">Loading persona configuration...</p>
      </div>
    );
  }

  if (!personaId) {
    return (
      <div className="p-6">
        <p className="text-gray-500">No persona configuration found.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900">
          Persona Configuration
        </h3>
        <div className="flex gap-2">
          <button
            onClick={handleValidate}
            disabled={validating || !configJson.trim()}
            className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {validating ? 'Validating...' : 'Validate'}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !configJson.trim()}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {successMessage && (
        <div className="rounded-md bg-green-50 border border-green-200 p-3">
          <p className="text-sm text-green-800">{successMessage}</p>
        </div>
      )}

      {parseError && (
        <div className="rounded-md bg-red-50 border border-red-200 p-3">
          <p className="text-sm font-medium text-red-800">JSON Parse Error</p>
          <p className="text-sm text-red-700 mt-1">{parseError}</p>
        </div>
      )}

      {errors.length > 0 && (
        <div className="rounded-md bg-red-50 border border-red-200 p-3">
          <p className="text-sm font-medium text-red-800">Validation Errors</p>
          <ul className="mt-2 space-y-1">
            {errors.map((error, i) => (
              <li key={i} className="text-sm text-red-700">
                <span className="font-mono text-red-900">{error.path}</span>
                {': '}
                {error.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <textarea
        value={configJson}
        onChange={(e) => handleJsonChange(e.target.value)}
        className="w-full h-96 rounded-md border border-gray-300 bg-gray-50 p-4 font-mono text-sm text-gray-900 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 resize-y"
        spellCheck={false}
        aria-label="Persona configuration JSON editor"
      />

      <p className="text-xs text-gray-500">
        Edit the JSON configuration above. Use Validate to check for errors
        without saving, or Save to persist changes.
      </p>
    </div>
  );
}
