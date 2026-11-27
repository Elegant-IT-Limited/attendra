# One image for the voice service, the dashboard API, the worker and the migrate/seed jobs. They
# run TypeScript directly through tsx. The dashboard itself has its own image
# (web.Dockerfile), a compiled Next.js build.
FROM node:24-slim
# pnpm is fetched once here, into a directory the node user can read at runtime
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_HOME=/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack install -g pnpm@12.8.1 && chmod -R a+rX /corepack
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/mcp/package.json apps/mcp/
COPY apps/voice/package.json apps/voice/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/agent/package.json packages/agent/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/knowledge/package.json packages/knowledge/
COPY packages/observability/package.json packages/observability/
COPY packages/scheduling/package.json packages/scheduling/
COPY packages/telephony/package.json packages/telephony/
COPY packages/voice-engine/package.json packages/voice-engine/
COPY packages/webhooks/package.json packages/webhooks/
COPY evals/package.json evals/
RUN pnpm install --frozen-lockfile
COPY . .
# The services run as node, so the app is node's: pnpm checks the installed packages before each
# `pnpm <script>` and rewrites their links, which a root-owned /app refused at start
# (ERR_PNPM_CMD_SHIM_CHMOD). And a built image never installs anything when it starts.
RUN chown -R node:node /app
ENV npm_config_verify_deps_before_run=false
# Which build this is, for GET /api/v1/version and the dashboard's footer. A release image is built from a git archive,
# which has no .git: the deploy passes the commit, the build number (commits up to it) and dirty (false for an archive).
# Left empty, the API asks git when there is one, else says "unknown". Last, so a new commit rebuilds only this layer.
ARG ATTENDRA_COMMIT=
ARG ATTENDRA_BUILD=
ARG ATTENDRA_DIRTY=
ENV ATTENDRA_COMMIT=$ATTENDRA_COMMIT ATTENDRA_BUILD=$ATTENDRA_BUILD ATTENDRA_DIRTY=$ATTENDRA_DIRTY
USER node
EXPOSE 8080 8081 8082
