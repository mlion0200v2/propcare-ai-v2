# syntax=docker/dockerfile:1.7
#
# Production image for Google Cloud Run. Three stages keep the runtime image
# small: dependencies, build (Next.js standalone output), and a non-root Node
# runtime.
#
# Public build-time values (NEXT_PUBLIC_*) are inlined into the browser bundle,
# so they are build args. Secrets never enter the image; Cloud Run injects them
# at run time from Secret Manager.

ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder-anon-key
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ARG APP_VERSION=dev
ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL} \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY} \
    NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL} \
    APP_VERSION=${APP_VERSION} \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production
# Some modules create API clients at import time, which `next build` runs while
# collecting page data. Placeholders (as in CI) satisfy that; they exist only in
# this build stage and never reach the runtime image, where Cloud Run injects
# the real values.
RUN OPENAI_API_KEY=build-placeholder \
    PINECONE_API_KEY=build-placeholder \
    PINECONE_INDEX=build-placeholder \
    SUPABASE_SERVICE_ROLE_KEY=build-placeholder \
    npm run build

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=8080
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

# Standalone output holds server.js and the minimal node_modules it needs;
# static assets and public files are copied alongside as Next.js expects.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

USER node
EXPOSE 8080
CMD ["node", "server.js"]
