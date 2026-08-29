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
│   │   │   │   ├── claude-api.service.ts        # Model routing + streaming + prompt assembly
│   │   │   │   ├── coaching.service.ts          # Session lifecycle, manuscript map, slash commands
│   │   │   │   ├── coaching-workflows.ts        # Workflow + prompt-command registry (BMAD menu)
│   │   │   │   ├── corpus-summary.service.ts    # Per-document logline/theme index
│   │   │   │   ├── submission-tracking.service.ts  # Earmarks, first-rights conflicts, opportunities
│   │   │   │   ├── target-venues.ts             # Curated journal shortlist (EDIT HERE to add venues)
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
│       │   │   ├── layout/              # AppShell
│       │   │   ├── auth/                # AuthGate, LoginForm
│       │   │   ├── pages/               # Route targets — SOMETIMES thin wrappers, sometimes the whole UI
│       │   │   ├── coaching/            # CoachingWorkspace, MessageBubble, StreamingResponse
│       │   │   ├── corpus/              # CorpusBrowser (feature impl), document tree, upload
│       │   │   ├── projects/            # ProjectBriefEditor (project description Quinn reads)
│       │   │   ├── drafts/              # DraftVersions, diff viewer
│       │   │   ├── capture/             # QuickCapture, CaptureInbox
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
└── README.md

Note: earlier versions of this doc listed `analysis/`, `bmb-creations/`, and
`implementation-artifacts/` at the repo root. They are NOT in the working tree.
The original BMAD agent definitions live outside this repo — see the BMAD origins
section in `tech.md` for the path.
```

## Conventions

- **Backend routes**: One file per domain, named `{domain}.routes.ts`. Mounted under `/api/` prefix in `server.ts`.
- **Backend services**: Business logic in `{domain}.service.ts`. Routes call services, services call DB/external APIs.
- **Frontend pages**: `components/pages/` holds the components the router actually renders. The pattern is INCONSISTENT — some are thin wrappers that delegate to a feature folder (e.g. `pages/CorpusBrowser.tsx` renders `corpus/CorpusBrowser.tsx`), while others contain the entire UI themselves (e.g. `pages/IntelligenceFeed.tsx`). **Before editing any frontend component, verify it is actually imported** (`grep -rn "ComponentName" src/`). Two files can share a name, and the one in the feature folder may be dead. Editing an unreferenced component produces a successful build and deploy with no visible change — a genuinely confusing failure mode.

### Orphaned components

As of the last audit there are **none** — every component under `components/` is
reachable. Three were found and resolved: `intelligence/IntelligenceFeed.tsx` and
`layout/ProjectSwitcher.tsx` were deleted, and `settings/UsageDashboard.tsx` was
wired into `settings/SettingsPanel.tsx` against the new `/api/usage` endpoint.

Before editing a component, confirm something imports it:
```bash
grep -rn "ComponentName" packages/frontend/src/   # no import = orphaned
```

After a frontend change, confirm the new string actually reached the bundle —
this catches editing-dead-code, which otherwise builds and deploys silently:
```bash
npm run build -w @quinn/frontend && grep -ro "Your New String" packages/frontend/dist/assets/ | head
```
- **Frontend components**: Organized by feature domain (coaching, corpus, capture, etc.), not by component type.
- **API pattern**: REST with JSON. SSE for streaming Claude responses during coaching sessions.
- **Migrations**: Sequential numbered files (`001_`, `002_`, etc.) in `src/db/migrations/`.
