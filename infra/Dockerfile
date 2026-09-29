# One image for the voice service, the dashboard API, the worker and the migrate/seed jobs. They
# run TypeScript directly through tsx. The dashboard itself has its own image
# (web.Dockerfile), a compiled Next.js build.
FROM node:22-slim
# pnpm is fetched once here, into a directory the node user can read at runtime
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_HOME=/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack install -g pnpm@10.34.5 && chmod -R a+rX /corepack
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
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
COPY evals/package.json evals/
RUN pnpm install --frozen-lockfile
COPY . .
USER node
EXPOSE 8080 8081
