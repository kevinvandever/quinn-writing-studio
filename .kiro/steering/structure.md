# Project Structure

```
quinn-writing-studio/
├── packages/
│   ├── backend/                         # Express API (Railway)
│   │   ├── src/
│   │   │   ├── config.ts               # Env validation with zod
│   │   │   ├── server.ts               # Express app setup, middleware, route mounting
│   │   │   ├── index.ts                # Entry point (re-exports app)
│   │   │   ├── db/
│   │   │   │   ├── connection.ts        # PostgreSQL pool
│   │   │   │   ├── migrations/          # Numbered migrations (001_ through 020_)
│   │   │   │   └── seed.ts             # Default Quinn persona + settings
│   │   │   ├── middleware/
│   │   │   │   ├── auth.middleware.ts    # JWT extraction and validation
│   │   │   │   ├── error-handler.middleware.ts  # Global error handler
│   │   │   │   └── rate-limit.middleware.ts     # Redis-backed rate limiting
│   │   │   ├── routes/                  # One file per domain (auth, projects, sessions, etc.)
│   │   │   ├── services/               # Business logic layer
│   │   │   │   ├── claude-api.service.ts        # Model routing + streaming
│   │   │   │   ├── coaching.service.ts          # Session lifecycle
│   │   │   │   ├── ethics.service.ts            # Writing ethics enforcement
│   │   │   │   ├── scrivener-parser.service.ts  # .scriv import
│   │   │   │   ├── substack-sync.service.ts     # RSS/API sync
│   │   │   │   ├── theme-analysis.service.ts    # Cross-project themes
│   │   │   │   ├── intelligence.service.ts      # Grant/news/publishing pipeline
│   │   │   │   ├── activity.service.ts          # Writing activity insights
│   │   │   │   ├── goal-tracking.service.ts     # Goal progress
│   │   │   │   ├── notification.service.ts      # Nudge generation
│   │   │   │   ├── export.service.ts            # Data export (ZIP)
│   │   │   │   └── usage-tracking.service.ts    # API cost tracking
│   │   │   ├── jobs/                    # Background intelligence scanners
│   │   │   │   ├── job-scheduler.ts     # Bull + node-cron setup
│   │   │   │   ├── grant-scanner.job.ts
│   │   │   │   ├── ai-news-scanner.job.ts
│   │   │   │   ├── publishing-scanner.job.ts
│   │   │   │   └── nudge-checker.job.ts
│   │   │   ├── schemas/                 # Zod schemas (persona validation)
│   │   │   ├── types/                   # TypeScript type extensions
│   │   │   └── utils/
│   │   │       ├── encryption.ts        # AES-256-GCM encrypt/decrypt
│   │   │       └── rtf-parser.ts        # RTF to plain text
│   │   ├── Dockerfile
│   │   ├── railway.toml
│   │   └── tsconfig.json
│   │
│   └── frontend/                        # React SPA (Netlify)
│       ├── src/
│       │   ├── App.tsx                  # Router with lazy-loaded pages
│       │   ├── main.tsx                 # React entry point
│       │   ├── index.css                # TailwindCSS imports
│       │   ├── components/
│       │   │   ├── layout/              # AppShell, Navigation, ProjectSwitcher
│       │   │   ├── auth/                # AuthGate, LoginForm
│       │   │   ├── pages/               # Page-level wrappers (thin, delegate to feature components)
│       │   │   ├── coaching/            # CoachingWorkspace, MessageBubble, StreamingResponse
│       │   │   ├── corpus/              # CorpusBrowser, document tree, upload
│       │   │   ├── drafts/              # DraftVersions, diff viewer
│       │   │   ├── capture/             # QuickCapture, CaptureInbox
│       │   │   ├── intelligence/        # IntelligenceFeed (grants, AI news, publishing tabs)
│       │   │   ├── promptly/            # PromptlyQueue, content pipeline
│       │   │   ├── accountability/      # GoalTracker, ActivityDashboard
│       │   │   ├── themes/              # ThemeMap, connection explorer
│       │   │   ├── notifications/       # NotificationCenter (nudges overlay)
│       │   │   └── settings/            # SettingsPanel, PersonaEditor, SubstackSettings, UsageDashboard
│       │   ├── services/
│       │   │   ├── api-client.ts        # HTTP client with auth handling
│       │   │   └── sse-client.ts        # Server-Sent Events for streaming
│       │   ├── stores/                  # Zustand state (authStore, projectStore)
│       │   ├── hooks/                   # Custom hooks (useAuth)
│       │   └── utils/                   # Utilities (diff)
│       ├── netlify.toml
│       └── postcss.config.js
│
├── analysis/                            # Brainstorming and planning docs
├── bmb-creations/                       # Agent definitions and sidecar configs
└── implementation-artifacts/            # (empty, for future use)
```

## Conventions

- **Backend routes**: One file per domain, named `{domain}.routes.ts`. Mounted under `/api/` prefix in `server.ts`.
- **Backend services**: Business logic in `{domain}.service.ts`. Routes call services, services call DB/external APIs.
- **Frontend pages**: Thin wrappers in `components/pages/` that render feature components from domain folders.
- **Frontend components**: Organized by feature domain (coaching, corpus, capture, etc.), not by component type.
- **API pattern**: REST with JSON. SSE for streaming Claude responses during coaching sessions.
- **Migrations**: Sequential numbered files (`001_`, `002_`, etc.) in `src/db/migrations/`.
