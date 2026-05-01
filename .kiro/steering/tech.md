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
