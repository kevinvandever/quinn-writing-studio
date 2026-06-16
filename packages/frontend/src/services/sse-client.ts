const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ModelInfo {
  model: 'sonnet' | 'opus';
  reason: string;
}

export interface DoneEvent {
  inputTokens: number;
  outputTokens: number;
}

export interface RetryingEvent {
  attempt: number;
  delayMs: number;
}

export interface SSEStreamOptions {
  /** Request body to send with the POST request */
  body?: unknown;
  /** HTTP method (defaults to POST for coaching endpoints) */
  method?: 'GET' | 'POST';
}

export interface SSEStream {
  /** Called for each streaming text token */
  onToken: (callback: (token: string) => void) => SSEStream;
  /** Called when model selection info is received */
  onModelInfo: (callback: (info: ModelInfo) => void) => SSEStream;
  /** Called when the stream is complete */
  onDone: (callback: (event: DoneEvent) => void) => SSEStream;
  /** Called when the server is retrying after a transient error */
  onRetrying: (callback: (event: RetryingEvent) => void) => SSEStream;
  /** Called on error */
  onError: (callback: (error: Error) => void) => SSEStream;
  /** Abort the stream */
  abort: () => void;
}

// ─── SSE Client ──────────────────────────────────────────────────────────────

/**
 * Create an SSE stream connection using fetch + ReadableStream.
 * Uses fetch with credentials: 'include' for cookie-based auth.
 *
 * Handles SSE events:
 * - 'token': streaming text chunks
 * - 'model_info': model selection notification
 * - 'done': stream complete with token usage
 * - 'error': error from the server
 */
export function createSSEStream(
  url: string,
  options: SSEStreamOptions = {}
): SSEStream {
  const { body, method = 'POST' } = options;

  let tokenCallback: ((token: string) => void) | null = null;
  let modelInfoCallback: ((info: ModelInfo) => void) | null = null;
  let doneCallback: ((event: DoneEvent) => void) | null = null;
  let retryingCallback: ((event: RetryingEvent) => void) | null = null;
  let errorCallback: ((error: Error) => void) | null = null;

  const abortController = new AbortController();

  // Start the fetch request
  const token = (() => {
    try { return localStorage.getItem('quinn_token'); } catch { return null; }
  })();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const fetchPromise = fetch(`${BASE_URL}${url}`, {
    method,
    headers,
    credentials: 'include',
    signal: abortController.signal,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // Process the stream
  fetchPromise
    .then(async (response) => {
      if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(
          `SSE request failed: ${response.status} ${errorText}`
        );
        errorCallback?.(error);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        errorCallback?.(new Error('Response body is not readable'));
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process complete SSE messages from the buffer
          const messages = buffer.split('\n\n');
          // Keep the last incomplete chunk in the buffer
          buffer = messages.pop() ?? '';

          for (const message of messages) {
            if (!message.trim()) continue;
            processSSEMessage(message);
          }
        }

        // Process any remaining buffer
        if (buffer.trim()) {
          processSSEMessage(buffer);
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          errorCallback?.(err as Error);
        }
      }
    })
    .catch((err) => {
      if ((err as Error).name !== 'AbortError') {
        errorCallback?.(err as Error);
      }
    });

  function processSSEMessage(message: string): void {
    let eventType = 'message';
    let data = '';

    for (const line of message.split('\n')) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        data += line.slice(6);
      } else if (line.startsWith('data:')) {
        data += line.slice(5);
      }
    }

    if (!data) return;

    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;

      switch (eventType) {
        case 'token':
          if (tokenCallback && typeof parsed['token'] === 'string') {
            tokenCallback(parsed['token']);
          }
          break;

        case 'model_info':
          if (modelInfoCallback) {
            modelInfoCallback(parsed as unknown as ModelInfo);
          }
          break;

        case 'done':
          if (doneCallback) {
            doneCallback(parsed as unknown as DoneEvent);
          }
          break;

        case 'retrying':
          if (retryingCallback) {
            retryingCallback(parsed as unknown as RetryingEvent);
          }
          break;

        case 'error':
          if (errorCallback) {
            const msg =
              typeof parsed['message'] === 'string'
                ? parsed['message']
                : 'Unknown SSE error';
            errorCallback(new Error(msg));
          }
          break;
      }
    } catch {
      // Non-JSON data, ignore
    }
  }

  const stream: SSEStream = {
    onToken(callback) {
      tokenCallback = callback;
      return stream;
    },
    onModelInfo(callback) {
      modelInfoCallback = callback;
      return stream;
    },
    onDone(callback) {
      doneCallback = callback;
      return stream;
    },
    onRetrying(callback) {
      retryingCallback = callback;
      return stream;
    },
    onError(callback) {
      errorCallback = callback;
      return stream;
    },
    abort() {
      abortController.abort();
    },
  };

  return stream;
}
