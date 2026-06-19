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
- **AI**: `@anthropic-ai/sdk` — Claude Sonnet (everyday) and Opus (deep analysis)
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

Only the **Scrivener watcher** (`npm run scriv:watch -w @quinn/backend`). The local `packages/backend/.env` is **watcher-only** config:
- `SCRIV_BACKUP_DIR`, `SCRIV_PROJECT_NAME`, `SCRIV_PROJECT_ID`, `SCRIV_DEBOUNCE_MS`
- `QUINN_API_URL` (the Railway backend URL the watcher syncs to)
- `QUINN_EMAIL` / `QUINN_PASSWORD` (login creds for the watcher)

It is NOT a full backend `.env` and cannot run the backend. The watcher detects new Scrivener backups and POSTs parsed corpus data to the Railway backend's `/corpus/sync` endpoint.

### Practical implications

- To ship a backend fix: verify locally with `npm run build`/`typecheck -w @quinn/backend` (build only, never run), then commit + push to `main` for the owner to test against Railway.
- Corpus/import changes that capture new fields at import time only take effect after a **fresh Scrivener re-sync** (the watcher syncs on the next backup, or re-upload the `.scriv`). Existing rows keep their old shape until then.

### BMAD origins

Quinn began as a BMAD agent (Breakthrough Method for Agile AI-Driven Development). That history matters: her **persona** (voice, principles, Sedaris craft, ethics) was ported into the app and is seeded in `packages/backend/src/db/seed-kevin.ts` from the original BMAD agent YAML + sidecar. What did NOT come across is BMAD's structured machinery — command menus, step-gated workflows/tasks, advanced elicitation — which is why coaching currently feels like free-form chat rather than a methodical process. (Note: `structure.md` lists a `bmb-creations/` folder for agent definitions, but it is not present in the working tree.)
