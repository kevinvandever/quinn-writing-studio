# Tech Stack and Build System

## Monorepo Structure

npm workspaces monorepo with two packages: `packages/frontend` and `packages/backend`. Each package builds and deploys independently.

## Frontend (`@quinn/frontend`)

- **Framework**: React 18 + TypeScript
- **Build**: Vite 6
- **Styling**: TailwindCSS 3 + PostCSS + Autoprefixer
- **Routing**: react-router-dom v6 with lazy-loaded page components
- **State**: Zustand 5 (stores in `src/stores/`)
- **Diff**: diff-match-patch for draft version comparison
- **Deployment**: Netlify (static SPA with `netlify.toml` redirect rules)

## Backend (`@quinn/backend`)

- **Framework**: Express 4 + TypeScript (ES2022, Node16 module resolution)
- **Database**: PostgreSQL via `pg`, migrations via `node-pg-migrate`
- **Cache/Queue**: Redis via `ioredis`, job queue via `bull`
- **Scheduling**: `node-cron` for background intelligence jobs
- **AI**: `@anthropic-ai/sdk` — Claude Sonnet 5.5 (everyday coaching, medium effort), Opus 5.5 (workflows and deep modes, high effort), Haiku 5.5 (background jobs: intelligence curation, nudges). IDs default in `claude-api.service.ts` and can be overridden with `CLAUDE_SONNET_MODEL` / `CLAUDE_OPUS_MODEL` / `CLAUDE_HAIKU_MODEL`; prices for cost tracking live in `usage-tracking.service.ts`. Current models think before answering and thinking counts toward `max_tokens`, so don't lower the caps casually. Dates/times in prompts use `WRITER_TIME_ZONE` (default `America/New_York`) because Railway runs in UTC.
- **Prompt caching (coaching turns)**: `assemblePrompt` in `claude-api.service.ts` builds two system blocks with 1-hour cache breakpoints (block 1: persona, ethics, task protocol, tools guide, brief, the full manuscript; block 2: binder map, first-rights, manuscript changes since the last session, Quinn's notebook, Session Memory), and per-turn context (time, activity, workflow step, retrieved material) that `buildApiMessages` attaches to the writer's newest message, plus a breakpoint on Quinn's last reply. Anything that changes per turn must stay out of the system blocks, and the blocks must be byte-identical across turns (deterministic ordering in every query that feeds them), or every turn pays a full cache write. For the same reason, long sittings drop old messages in 40k-character chunks rather than one message per turn. The archive tools (below) are part of the cached prefix too (tools come before the system prompt), so every coaching request sends the same `ARCHIVE_TOOLS`. `/analyze` and essay triage (`readsWholeCorpus`) also put everything outside the book (minus Trash) in block 1.
- **Auth**: `bcrypt` for password hashing, `jsonwebtoken` for JWT in HTTP-only cookies
- **Validation**: `zod` for request/env validation
- **Security**: `helmet`, `express-rate-limit` with Redis store, AES-256-GCM encryption for sensitive fields
- **File parsing**: `fast-xml-parser` for Scrivener .scrivx binder, custom RTF-to-text parser, `adm-zip` for .scriv packages
- **Other**: `rss-parser` for Substack RSS, `archiver` for ZIP exports, `multer` for file uploads
- **Deployment**: Railway (Docker container), managed PostgreSQL + Redis

## TypeScript Configuration

Backend uses strict mode with `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, and `noUncheckedIndexedAccess` enabled.

## Common Commands

```bash
# Install all dependencies (from repo root)
npm install

# Frontend
npm run dev -w @quinn/frontend        # Dev server on :5173
npm run build -w @quinn/frontend       # Production build (tsc + vite)
npm run typecheck -w @quinn/frontend   # Type check only

# Backend
npm run dev -w @quinn/backend          # Dev server on :3001 (tsx watch)
npm run build -w @quinn/backend        # Compile TypeScript
npm run typecheck -w @quinn/backend    # Type check only
npm run start -w @quinn/backend        # Run compiled JS

# Database
npm run migrate:up -w @quinn/backend   # Run pending migrations
npm run seed -w @quinn/backend         # Seed default data (Quinn persona, settings)
```

## Environment

- Node.js >= 18 (20+ recommended)
- PostgreSQL 15+
- Redis 7+
- Anthropic API key required for AI features

## Deployment & Runtime Reality (IMPORTANT)

There is **no local running instance of this app**. The owner does not run the backend or frontend on their machine. Do not suggest `npm run dev`/`npm start` as a way to test changes, and do not assume a server is listening on `localhost`.

- **Backend** runs only on **Railway**, built from the `Dockerfile` (`npm run build` → `node dist/server.js`). All backend env vars (DATABASE_URL, REDIS_URL, ANTHROPIC_API_KEY, JWT_SECRET, etc.) live in the Railway dashboard, not in any local `.env`.
- **Frontend** runs only on **Netlify**, built from source.
- **Both auto-deploy from the `main` branch.** The only way to make a change live is to commit and push to `main`. Railway rebuilds the backend; Netlify rebuilds the frontend.
- The compiled `packages/backend/dist/` directory on the machine is stale/irrelevant — Railway builds its own copy. Don't infer "what's deployed" from local `dist/` timestamps.

### What DOES run locally

Only the **Scrivener watcher** (`npm run scriv:watch -w @quinn/backend`) and, on demand, the quality check runner described below. The local `packages/backend/.env` is config for these local tools only:
- `SCRIV_BACKUP_DIR`, `SCRIV_PROJECT_NAME`, `SCRIV_PROJECT_ID`, `SCRIV_DEBOUNCE_MS`
- `QUINN_API_URL` (the Railway backend URL the watcher syncs to)
- `QUINN_EMAIL` / `QUINN_PASSWORD` (login creds for the watcher)

It is NOT a full backend `.env` and cannot run the backend. The watcher detects new Scrivener backups and POSTs parsed corpus data to the Railway backend's `/corpus/sync` endpoint. After every backup it also uploads any Scrivener snapshots the backend doesn't have yet (`GET /corpus/snapshots/keys`, then `POST /corpus/snapshots`). The watcher runs from source in this repo, so **restart it after changing watcher or parser code**; pushing to `main` doesn't update it.

The **quality check runner** (`npm run quality-check -w @quinn/backend`, see "Quality check" below) is the other local tool. It uses the same `.env` values to log in and runs test conversations against the Railway backend. It costs real API money, so don't run it casually.

### Practical implications

- To ship a backend fix: verify locally with `npm run build`/`typecheck -w @quinn/backend` (build only, never run), then commit + push to `main` for the owner to test against Railway.
- Corpus/import changes that capture new fields at import time only take effect after a **fresh Scrivener re-sync** (the watcher syncs on the next backup, or re-upload the `.scriv`). Existing rows keep their old shape until then.

### BMAD origins

Quinn began as a BMAD agent (Breakthrough Method for Agile AI-Driven Development). Her **persona** (voice, principles, Sedaris craft, ethics) was ported into the app and is seeded in `packages/backend/src/db/seed-kevin.ts`. Her BMAD **command menu and process** were re-implemented in-app.

### Coaching commands — where they live

Commands are typed into the coaching chat input (there is no separate palette). They are defined in **two** places, which matters when adding or changing one:

1. **`services/coaching-workflows.ts`** — the registry, and the source of truth for anything that drives the model:
   - *Workflows* (multi-step, step-gated): `/essay-triage` (Plan Collection), `/editorial-pass` (Review Essay)
   - *Prompt modes* (single-shot): `/analyze`, `/central-question`, `/submission-ready`, `/place-this`, `/revisions`, `/coach`, `/progress`, `/checkin`
   - Flags per entry: `projectTypes` (availability), `targetsSinglePiece` (forces full text), `preferOpus` (model routing), `readsWholeCorpus` (outside material in full), `includePublishingOpportunities` (injects Intelligence feed items), `includeRevisionHistory` (injects the named piece's versions)

2. **`services/coaching.service.ts` → `handleSlashCommand()`** — built-in commands that need DB writes or a static reply, so they are NOT in the registry:
   - `/help`, `/next`, `/back`, `/exit`
   - `/earmark`, `/unearmark`, `/earmarked` (first-publication rights)
   - `/notebook`, `/forget <number>` (Quinn's notebook, see below)

`/help` renders the registry dynamically, so registry additions appear automatically — but built-ins added in `handleSlashCommand` must also be added to `buildHelpMenu()` by hand, or they stay undiscoverable. When adding a command, update this list too.

The original BMAD agent definition lives OUTSIDE this repo at:
`/Volumes/Kevin SSD/kev-dev/_bmad-output/bmb-creations/memoir-writing-coach/`
(agent yaml + `.md`, plus a `-sidecar/` with instructions.md, memories.md, and knowledge/david-sedaris-craft-notes.md). The BMAD framework itself is at `/Volumes/Kevin SSD/kev-dev/_bmad/`. Reference these when refining Quinn's commands, voice, or craft knowledge.

### Quinn's notebook (long-term memory)

`services/notebook.service.ts`. Per project: coaching preferences, decisions, open threads, notes on pieces, patterns, breakthroughs. When a session ends, Sonnet reads the transcript plus the current notebook and returns edits (add/update/remove), applied in code with per-kind limits. The first notebook for a project reads back through the 12 most recent sessions (600k-character budget). A watermark of the last folded session means failed updates are retried by the hourly session-closer job. Stored migration-free as versioned `[[QUINN_NOTEBOOK]]` system messages (latest wins, 30 kept), written under a Postgres advisory lock so `/forget` and an update can't overwrite each other. It renders into cached block 2; the opener also gets the open threads. API spend is logged under the `notebook` feature area.

### Revision history

Versions of a piece live in `draft_snapshots`. Two sources: `pre_import_update` rows, which a sync writes with a piece's old text whenever it changes it; and Scrivener's own snapshots, parsed from `Snapshots/<UUID>.snapshots/` in the backup and stored as `manual` rows with `created_at` = when Scrivener took them. Migration-free: a Scrivener snapshot's title lives in the document's `metadata.scrivenerSnapshots` (`{ "<ISO time>": "<title>" }`), which is also the dedupe key the watcher checks, so a version deleted in the app isn't re-uploaded. Versions are compared with `utils/paragraph-diff.ts`, which ignores RTF extraction debris (comment-link ids, trailing backslashes, cp1252 quotes) so Scrivener's automatic snapshots don't read as edits.

Sync change detection (`detectChanges` in `scrivener-parser.service.ts`) covers text, renames, moves between folders, and reorders (`diff_summary.renamed/moved/reordered`), and the watcher's fingerprint includes titles and binder positions, so a move from SALVAGE into the book syncs even when no text changed.

**Text encoding.** Scrivener's RTF is `\ansicpg1252`; `stripRtf` decodes `\'XX` as Windows-1252, so `\'92` is ’ (before `f8b93d7` it was decoded as Latin-1, which stored curly quotes, apostrophes, dashes, and ellipses as control characters U+0080-U+009F). `applyScrivenerImport` also decodes those on the way in and computes `content_hash` itself, so any watcher version stores clean text. A piece whose stored text differs from the incoming text only by that decoding is updated quietly: no `pre_import_update` snapshot, no `updated_at` bump, `summaryHash` carried over, not in `diff_summary`, and a sync with nothing else in it records no import. Production's corpus was fixed that way by the watcher's first sync after `f8b93d7` (119 pieces, nothing else changed). Snapshot rows stored before then still have the control characters, so readers decode them (`paragraph-diff`, the snapshot routes, export). **Any other change to what the parser outputs for unchanged text makes the next sync treat every affected piece as revised** (snapshots, new "last changed" dates, re-summarizing, and Quinn seeing a revision); handle it the same way.

`revision-history.service.ts` feeds "Manuscript Changes Since Your Last Session" (passages cut, added, and rewritten since the last session ended; cached block 2, plus a smaller version for the opener) and the `/revisions <piece>` mode (timeline, earliest version in full, latest diffs).

### Quinn's archive tools

`services/archive-tools.service.ts` gives coaching turns four client tools: `search_writing` (Postgres full-text search, computed on the fly, over every document in the writer's active projects plus quick captures; title > logline > text weighting; all-words matches first, then any-word matches; Trash and dismissed captures only with `include_trash`), `read_document` (by id or title, cleaned of RTF debris, 30k-character parts; pieces already in the prompt return a pointer instead), `search_conversations` (past session messages in all projects, minus the part of the current session already in the request, slash commands, and static command replies), and `piece_history` (wraps `buildRevisionHistoryContext`). Every query is scoped to the user id. The usage guide (`ARCHIVE_TOOLS_GUIDE`) sits in cached block 1.

`streamToSSE` in `claude-api.service.ts` runs the loop: when a request stops with `tool_use`, it echoes the assistant content exactly as received (thinking blocks and signatures included; Sonnet/Opus 5.5 reject rebuilt turns and edits before a thinking block), runs every call, sends the results, and continues. The conversation is append-only within a turn and no cache breakpoints move. Limits: 6 rounds with real results, then one round of "limit reached" results, then the reply ends; 160k characters of results per reply. Text from all rounds streams as one reply (new paragraph after a tool round). Each lookup sends an `activity` SSE event (`{ label }`) that `CoachingWorkspace` shows as a status line. Only the final text is stored in `messages`; tool exchanges are not kept in later history.

Per-turn keyword retrieval (3k excerpts of every document matching words in the message) was removed when the tools arrived; only pieces the writer names (or a mode targets) are still loaded automatically. Forced tool use (`tool_choice: any/tool`) returns 400 on the 5.5 models, so steer tool use with the guide text, not `tool_choice`.

### Quality check (test conversations)

A set of test conversations that measure Quinn on the writer's real project, so prompt, model, and tool changes can be compared before and after. Cases live in `evals/quinn-cases.json` (format and placeholder list in `services/quality-check.schema.ts`). Run them with `npm run quality-check -w @quinn/backend` (`--list`, `--check` to validate the file, `--case <id>` for a subset, `--runs N` to run each case N times (1-5), `--yes` to skip the cost prompt). Measured costs: a full run is about $0.40 when a request in the last hour already cached Quinn's prompt (1-hour cache), plus about $0.50 when it has to write the cache first; each extra `--runs` round adds about $0.40. Ask Kevin before multi-run baselines.

- **No writing in the repo.** The repo is public, so cases use placeholders (`{{book_piece:a}}`, `{{outside_word:e}}`, `{{old_session_word:s}}`, ...) that the backend fills from the writer's files at run time, picking deterministically by slot name. Reports quote the manuscript, so `evals/reports/` is gitignored.
- **Picks.** Words to find outside the book come only from documents inside a binder folder with 200+ words (top-level documents tend to be Scrivener templates). The older-conversation word comes from the writer's own short messages (≤1,500 characters) in a session older than the 5 in Session Memory (ordered by start, like `loadSessionSummaries`), and appears in no other session, no document, and nothing Quinn already has (summaries, notebook).
- **Nothing stored.** `POST /api/projects/:id/quality-check` runs one case: `buildTurnRequest` (the same request builder as real coaching turns, with `assumeGreeted` so no welcome-back cues) and `runModelTurn` (the same tool loop), with no session, message, or notebook writes. Spend is logged under `quality_check`. The response is whitespace every 15 s, then JSON, to survive Railway's idle timeout.
- **Grading.** Plain checks (`mention`, `mentionAny`, `notMention`, `tools`, plus warnings for `noTools`, `maxWords`, and the ethics phrase check) and, when a case has a `rubric`, a Sonnet grader. The grader gets reference material from the writer's files (`reference`) and what else Quinn had in front of her: a binder outline, the Session Memory summaries, and her notebook (`Resolver.knowledge()`), so true details from those aren't marked as invented. Without that context it produced false "invented" verdicts. A run passes when every hard check and every rubric criterion passes. Fix a noisy grader with context, not by loosening the rubric.
- **Variance.** Quinn and the grader both vary between runs, so one failure can be noise. With `--runs N`, rounds run every case once each (skipped cases drop out), and the report shows a pass rate (`2/3`) and mean grade per case.
- Reports (`evals/reports/<date-time-to-the-second>.md` and `.json`) compare each run with the previous one by pass rate, and flag grades that moved by half a point or more.

When changing `sendSessionMessage`/`buildTurnRequest`, keep real turns identical: the refactor that split them was verified by capturing every request and stored message for a scripted set of turns before and after.
