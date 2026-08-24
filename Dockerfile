# --- deps: only package files, so this layer caches until deps change ---
FROM node:20-alpine AS deps
WORKDIR /app
# `better-sqlite3` is a native module. Alpine ships no prebuilt binary, so
# node-gyp needs a toolchain to compile it during `npm ci`. These pkgs are
# only in the deps/runtime layers, not baked into the final image.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci

# --- build: bring in the source, produce .next ---
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- runtime: prod deps + built app, nothing else ---
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Prod deps only — devDependencies are not needed at runtime. Native-module
# toolchain is needed here too because `npm ci --omit=dev` rebuilds
# better-sqlite3 from source.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.ts ./next.config.ts

EXPOSE 3000
CMD ["npx", "next", "start", "-H", "0.0.0.0", "-p", "3000"]
