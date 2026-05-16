# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

COPY backend/package.json ./
COPY backend/prisma ./prisma/
COPY backend/tsconfig.json ./
COPY backend/src ./src/

# Docker Desktop for Windows has an AES-GCM SSL bug that breaks npm over HTTPS.
# Using the plain HTTP registry URL avoids the cipher operation failure.
RUN npm install --no-audit \
      --registry http://registry.npmjs.org

# Prisma 7.x requires DATABASE_URL even during prisma generate
ENV DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy"
RUN node_modules/.bin/prisma generate
RUN node_modules/.bin/tsc && node_modules/.bin/tsc-alias

# ── Runtime stage ─────────────────────────────────────────────────────────────
# mcr.microsoft.com/playwright has Chromium + all system deps pre-installed.
# Tag v1.42.0 matches playwright ^1.42.1 in package.json.
FROM mcr.microsoft.com/playwright:v1.42.0-jammy AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV DISPLAY=:99

# Install Xvfb for virtual display (headed browser = harder to detect as bot)
RUN apt-get update && apt-get install -y --no-install-recommends xvfb \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules/
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./

# Re-run prisma generate in the runtime environment so the correct OpenSSL binary
# (debian-openssl-3.0.x on Jammy) is produced — the builder stage may use a different libc.
ENV DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy"
RUN node_modules/.bin/prisma generate

RUN mkdir -p /app/sessions

EXPOSE 3001

CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x720x24 -nolisten tcp & sleep 1 && node_modules/.bin/prisma migrate deploy && node dist/index.js"]
