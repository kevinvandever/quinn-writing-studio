# ---- Build Stage ----
FROM node:20-alpine AS builder

WORKDIR /app

# Copy root workspace files for dependency resolution
COPY package.json package-lock.json ./
COPY packages/backend/package.json ./packages/backend/

# Install all dependencies (including devDependencies for build)
RUN npm ci --workspace=packages/backend --include-workspace-root

# Copy backend source code
COPY packages/backend/ ./packages/backend/

# Build TypeScript
RUN npm run build --workspace=packages/backend

# ---- Production Stage ----
FROM node:20-alpine AS production

WORKDIR /app

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy root workspace files
COPY package.json package-lock.json ./
COPY packages/backend/package.json ./packages/backend/

# Install production dependencies only
RUN npm ci --workspace=packages/backend --include-workspace-root --omit=dev

# Copy built output from builder stage
COPY --from=builder /app/packages/backend/dist ./packages/backend/dist

# Set ownership to non-root user
RUN chown -R appuser:appgroup /app

# Switch to non-root user
USER appuser

# Railway uses PORT env var dynamically — expose default for local dev
EXPOSE 3001

# Health check — Railway also uses this for readiness
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-3001}/api/health || exit 1

# Graceful shutdown support
STOPSIGNAL SIGTERM

# Start the server
CMD ["node", "packages/backend/dist/server.js"]
