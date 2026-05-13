const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// Log the API URL on startup for debugging
console.log('[API Client] Base URL:', BASE_URL);

// Lazy import to avoid circular dependency
function getToken(): string | null {
  try {
    return localStorage.getItem('quinn_token');
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public override message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function parseErrorResponse(response: Response): Promise<ApiError> {
  try {
    const body = await response.json();
    return new ApiError(
      response.status,
      body.code || 'UNKNOWN_ERROR',
      body.message || response.statusText,
      body.details
    );
  } catch {
    return new ApiError(
      response.status,
      'UNKNOWN_ERROR',
      response.statusText
    );
  }
}

function handle401(message: string): never {
  // Don't redirect if already on login page (prevents flash loop)
  if (window.location.pathname !== '/login') {
    window.location.href = '/login';
  }
  throw new ApiError(401, 'UNAUTHORIZED', message);
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const headers: Record<string, string> = {};

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  let response: Response;
  try {
    const token = getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      credentials: 'include',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // Network error, CORS block, or server unreachable
    const message = err instanceof Error ? err.message : 'Network request failed';
    throw new ApiError(0, 'NETWORK_ERROR', `Unable to reach the server: ${message}`);
  }

  if (response.status === 401) {
    // Parse the actual error from the server before handling
    const error = await parseErrorResponse(response);
    // Only redirect to login for session/auth failures on non-auth endpoints
    // Auth endpoints (login/register) should surface the real error message
    const isAuthEndpoint = path.startsWith('/api/auth/login') || path.startsWith('/api/auth/register');
    if (isAuthEndpoint) {
      throw error;
    }
    handle401(error.message || 'Session expired');
  }

  if (!response.ok) {
    throw await parseErrorResponse(response);
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export function get<T>(path: string): Promise<T> {
  return request<T>('GET', path);
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('POST', path, body);
}

export function put<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('PUT', path, body);
}

export function del<T>(path: string): Promise<T> {
  return request<T>('DELETE', path);
}
