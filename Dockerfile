# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# build — full deps, `next build` (which also type-checks and lints)
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# git 2.38+ is a hard requirement — the conflict replay uses
# `git merge-tree --write-tree`, and the tool refuses to run without it rather
# than reporting a false 0% conflict rate. bookworm ships 2.39.
# gh is optional: without it every git-derived metric still works and the run
# records a warning, but PR titles, authors and reviews go missing.
ARG GH_VERSION=2.65.0
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends git ca-certificates curl; \
    arch="$(dpkg --print-architecture)"; \
    curl -fsSL -o /tmp/gh.tgz \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz"; \
    tar -xzf /tmp/gh.tgz -C /tmp; \
    install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${arch}/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh.tgz "/tmp/gh_${GH_VERSION}_linux_${arch}"; \
    apt-get purge -y --auto-remove curl; \
    rm -rf /var/lib/apt/lists/*; \
    git --version; gh --version

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# The CLI is TypeScript run through tsx rather than a build step, so the watcher
# service needs tsx at runtime even though the web service does not. Installed
# globally rather than into /app/node_modules: a production `npm install` prunes
# anything the lockfile does not list as a dependency, which quietly removes it.
# Keeping it out of the dev tree avoids dragging in eslint, typescript and vitest.
RUN npm install -g tsx@^4.21.0 && npm cache clean --force

COPY --from=build /app/.next ./.next
COPY next.config.mjs ./
# The CLI is TypeScript compiled on the fly, so the source is the artifact.
COPY src ./src
COPY bin ./bin
COPY tsconfig.json ./

# Mirror clones, reports and state. Created here so the named volume inherits
# the ownership rather than mounting in as root-owned.
RUN mkdir -p /data && chown -R node:node /data /app

COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh

USER node
ENV HOME=/home/node \
    MERGE_FORENSICS_HOME=/data \
    PORT=3737 \
    HOSTNAME=0.0.0.0
EXPOSE 3737

ENTRYPOINT ["entrypoint.sh"]
CMD ["npx", "next", "start", "-p", "3737"]
