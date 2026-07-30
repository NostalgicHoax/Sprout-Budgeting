# syntax=docker/dockerfile:1

# Sprout is a single container: one Express process serves both the API and the
# built React client on one port. All state lives in /data — system.db plus one
# encrypted SQLite file per budget. That directory MUST be a volume: the budget
# files are encrypted with the user's password and cannot be regenerated if the
# container is replaced.
#
# Debian (not Alpine) on purpose: better-sqlite3-multiple-ciphers publishes
# prebuilt binaries for glibc, and falls back to compiling from source, which
# needs a toolchain. Both paths are handled in the `deps` stage so the runtime
# image carries neither the toolchain nor the dev dependencies.

ARG NODE_VERSION=22-bookworm-slim

# ---------------------------------------------------------------------------
# deps — full dependency tree, including the native SQLite build
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY budget-app/package.json budget-app/package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# build — compile the client into dist/
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY budget-app/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# prod-deps — same compiled native binaries, dev dependencies dropped
# ---------------------------------------------------------------------------
FROM deps AS prod-deps
WORKDIR /app
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production \
    PORT=3178 \
    DATA_DIR=/data
WORKDIR /app

# The container starts with `node server/index.js` and never shells out to a
# package manager, so npm, corepack and yarn are unused at runtime — and they
# are where every fixable CVE in this image lives. The npm CLI bundles its own
# copy of tar, sigstore, brace-expansion and picomatch, none of which appear in
# the application's dependency tree. Deleting the tooling removes those findings
# outright rather than chasing patched versions of software we do not run.
# Note: apt-get upgrade would not touch these; they are npm packages, not deb.
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg \
           /opt/yarn-*

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build     /app/dist         ./dist
COPY budget-app/package.json ./package.json
COPY budget-app/server       ./server
COPY budget-app/shared       ./shared

# Created in the image so a fresh named volume inherits `node` ownership and the
# server can write it without running as root. A bind mount from the host keeps
# the host's ownership instead — see the Docker section of the README.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

USER node
EXPOSE 3178

# `/` is the built client, so this proves static serving and the HTTP listener
# are both up. Uses global fetch rather than adding curl to the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3178)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
