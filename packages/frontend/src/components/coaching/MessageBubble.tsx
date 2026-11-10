import { useState } from 'react';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model_used: string | null;
  model_reason: string | null;
  created_at: string;
}

interface MessageBubbleProps {
  message: Message;
  isStreaming?: boolean;
  /** Keep this reply as an example of Quinn's voice. Omit to hide the option. */
  onKeepExample?: (message: Message) => Promise<void>;
}

/** Longest reply the server accepts as a voice example (about 400 words). */
const MAX_EXAMPLE_CHARS = 2_500;

// ─── Component ───────────────────────────────────────────────────────────────

export function MessageBubble({ message, isStreaming = false, onKeepExample }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isOpus = message.model_used === 'opus';
  const [keep, setKeep] = useState<{ state: 'idle' | 'saving' | 'kept' | 'error'; note?: string }>({ state: 'idle' });
  const canKeep =
    !!onKeepExample &&
    !isStreaming &&
    message.model_reason !== 'Workflow command' &&
    message.content.trim().length > 0 &&
    message.content.trim().length <= MAX_EXAMPLE_CHARS;

  const keepExample = async () => {
    if (!onKeepExample) return;
    setKeep({ state: 'saving' });
    try {
      await onKeepExample(message);
      setKeep({ state: 'kept' });
    } catch (err) {
      setKeep({ state: 'error', note: err instanceof Error ? err.message : "Couldn't keep it." });
    }
  };

  const timestamp = new Date(message.created_at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  if (isUser) {
    return (
      <div className="flex items-start gap-3 justify-end">
        <div className="max-w-[80%]">
          <div className="bg-sage-600 text-white rounded-2xl rounded-tr-sm px-5 py-3">
            <p className="text-coaching whitespace-pre-wrap leading-relaxed">{message.content}</p>
          </div>
          <p className="text-xs text-warm-400 mt-1.5 text-right">{timestamp}</p>
        </div>
      </div>
    );
  }

  // Quinn (assistant) message
  return (
    <div className="flex items-start gap-3">
      <div className="w-9 h-9 rounded-full bg-sage-100 flex items-center justify-center flex-shrink-0 mt-0.5">
        <span className="text-sm">🖋️</span>
      </div>
      <div className="max-w-[80%]">
        {/* Stepping up notification when Opus is used */}
        {isOpus && message.model_reason && (
          <div className="mb-2 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-lg">
            <div className="flex items-center gap-1.5">
              <span className="text-xs">⚡</span>
              <span className="text-xs text-amber-800 font-medium">Deep analysis</span>
            </div>
            <p className="text-xs text-amber-700 mt-0.5">{message.model_reason}</p>
          </div>
        )}

        <div className="bg-warm-100 rounded-2xl rounded-tl-sm px-5 py-3">
          <p className="text-coaching text-ink whitespace-pre-wrap leading-relaxed">
            {message.content}
            {isStreaming && (
              <span className="inline-block w-1.5 h-4 bg-sage-600 ml-0.5 animate-pulse rounded-sm" />
            )}
          </p>
        </div>

        <div className="flex items-center gap-2 mt-1.5">
          <p className="text-xs text-warm-400">{timestamp}</p>
          {/* Model indicator badge */}
          {message.model_used && (
            <span
              className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${
                isOpus
                  ? 'bg-amber-100 text-amber-800'
                  : 'bg-warm-200 text-warm-600'
              }`}
            >
              {message.model_used === 'opus' ? 'Opus' : 'Sonnet'}
            </span>
          )}
          {canKeep && (
            <button
              type="button"
              onClick={keepExample}
              disabled={keep.state === 'saving' || keep.state === 'kept'}
              title="Quinn sees a few of her best replies as examples of how to sound"
              className="text-xs text-warm-400 hover:text-sage-700 disabled:hover:text-warm-400 disabled:cursor-default"
            >
              {keep.state === 'saving'
                ? 'Keeping…'
                : keep.state === 'kept'
                  ? 'Kept as a voice example ✓'
                  : 'Keep as a voice example'}
            </button>
          )}
        </div>
        {keep.state === 'error' && <p className="text-xs text-red-600 mt-1">{keep.note}</p>}
      </div>
    </div>
  );
}
