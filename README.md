# Quinn Writing Studio

A comprehensive AI-powered writing coaching platform built with React, Express, and Claude. Quinn serves as a creative writing partner for memoir and essay writers, providing coaching sessions, corpus management, intelligence curation, and accountability tools.

## Architecture

- **Frontend:** React + TypeScript + Vite + TailwindCSS (deployed to Netlify)
- **Backend:** Express + TypeScript + PostgreSQL + Redis (deployed to Railway)
- **AI:** Anthropic Claude API (Sonnet for everyday tasks, Opus for deep analysis)

## Local Development

### Prerequisites

- Node.js 20+
- PostgreSQL 15+
- Redis 7+
- Anthropic API key

### Setup

```bash
# Install dependencies
npm install

# Copy environment variables
cp packages/backend/.env.example packages/backend/.env
# Edit .env with your values

# Run database migrations
npm run migrate:up -w @quinn/backend

# Seed default data (Quinn persona, default settings)
npm run seed -w @quinn/backend

# Start development servers
npm run dev -w @quinn/backend   # Backend on :3001
npm run dev -w @quinn/frontend  # Frontend on :5173
```

## Environment Variables

### Backend (`packages/backend/.env`)

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@localhost:5432/quinn` |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude | `sk-ant-...` |
| `ENCRYPTION_KEY` | 64-char hex string for AES-256-GCM | `(generate with: openssl rand -hex 32)` |
| `JWT_SECRET` | Secret for JWT signing (min 32 chars) | `(generate with: openssl rand -base64 48)` |
| `CORS_ORIGIN` | Frontend URL for CORS | `http://localhost:5173` |
| `NODE_ENV` | Environment mode | `development` / `production` |
| `PORT` | Server port | `3001` |

### Frontend

| Variable | Description | Example |
|----------|-------------|---------|
| `VITE_API_URL` | Backend API base URL | `http://localhost:3001` |

## Deployment

### Netlify (Frontend)

1. Connect your repository to Netlify
2. Set the build settings:
   - **Base directory:** `packages/frontend`
   - **Build command:** `npm run build`
   - **Publish directory:** `packages/frontend/dist`
3. Set environment variables in Netlify dashboard:
   - `VITE_API_URL` = your Railway backend URL (e.g., `https://quinn-api.up.railway.app`)
4. Deploy — Netlify will handle SPA routing via `netlify.toml`

### Railway (Backend)

1. Create a new project on Railway
2. Provision services:
   - **PostgreSQL** — Railway provides managed Postgres. Copy the `DATABASE_URL` from the service variables.
   - **Redis** — Add a Redis service. Copy the `REDIS_URL`.
3. Add a new service from your repository:
   - Set the **root directory** to the repo root
   - Railway will detect the Dockerfile at `packages/backend/Dockerfile`
4. Set environment variables in Railway:
   - `DATABASE_URL` (from Postgres service)
   - `REDIS_URL` (from Redis service)
   - `ANTHROPIC_API_KEY`
   - `ENCRYPTION_KEY` (generate: `openssl rand -hex 32`)
   - `JWT_SECRET` (generate: `openssl rand -base64 48`)
   - `CORS_ORIGIN` = your Netlify frontend URL
   - `NODE_ENV` = `production`
   - `PORT` = `3001` (Railway sets this automatically)
5. Deploy

### Initial Database Setup

After deploying the backend with PostgreSQL provisioned:

```bash
# Run migrations (from local machine with DATABASE_URL pointing to Railway)
DATABASE_URL="postgresql://..." npm run migrate:up -w @quinn/backend

# Seed default data
DATABASE_URL="postgresql://..." npm run seed -w @quinn/backend
```

Or use Railway's CLI:
```bash
railway run npm run migrate:up -w @quinn/backend
railway run npm run seed -w @quinn/backend
```

## Project Structure

```
packages/
├── backend/
│   ├── src/
│   │   ├── config.ts          # Environment validation
│   │   ├── server.ts          # Express app setup
│   │   ├── db/                # Database connection, migrations, seed
│   │   ├── middleware/        # Auth, error handling, rate limiting
│   │   ├── routes/            # API route handlers
│   │   ├── services/          # Business logic (Claude, coaching, etc.)
│   │   ├── jobs/              # Background jobs (intelligence scanners)
│   │   └── utils/             # Encryption, RTF parsing
│   ├── Dockerfile
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── App.tsx            # Router setup
│   │   ├── components/        # UI components by feature
│   │   ├── services/          # API client, SSE client
│   │   ├── stores/            # Zustand state management
│   │   └── hooks/             # Custom React hooks
│   ├── netlify.toml
│   └── package.json
```

## Key Features

- **Coaching Sessions** — Real-time streaming conversations with Quinn via Claude
- **Corpus Management** — Scrivener .scriv import with change detection
- **Quick Capture** — Mobile-optimized thought capture
- **Intelligence Feed** — Curated grants, AI news, and publishing opportunities
- **Goal Tracking** — Word count, session frequency, and milestone goals
- **Nudge System** — Gentle accountability with escalating check-ins
- **Theme Mapping** — Cross-project thematic connection discovery
- **Promptly Pipeline** — AI news demystification content coaching
- **Data Export** — Full data portability as ZIP archive

## Scripts

```bash
# Type checking
npm run typecheck -w @quinn/backend
npm run typecheck -w @quinn/frontend

# Build
npm run build -w @quinn/backend
npm run build -w @quinn/frontend

# Development
npm run dev -w @quinn/backend
npm run dev -w @quinn/frontend
```
