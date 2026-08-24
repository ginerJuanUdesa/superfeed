# --- deps: only package files, so this layer caches until deps change ---
# Node 22 is required by better-sqlite3 v13 — v20 loads its musl prebuild
# but segfaults on the first DB call.
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci

# --- build: bring in the source, produce .next ---
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- runtime: prod deps + built app, nothing else ---
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Force IPv4 first for DNS. Node 22's undici follows the DNS order verbatim,
# and public APIs (huggingface.co in particular) return every v6 address
# before any v4. On hosts whose network has no working IPv6 upstream (Juan's
# laptop), every outbound fetch would then time out trying v6 before ever
# reaching v4. This flag flips the resolver so v4 wins.
ENV NODE_OPTIONS=--dns-result-order=ipv4first

# Prod deps only — devDependencies are not needed at runtime. Toolchain is
# needed because `npm ci` here re-runs better-sqlite3's install script; if
# the prebuild download fails, it falls back to compiling from source.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.ts ./next.config.ts

EXPOSE 3000
CMD ["npx", "next", "start", "-H", "0.0.0.0", "-p", "3000"]
