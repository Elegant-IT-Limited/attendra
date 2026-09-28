# One image for the voice service and the migrate/seed jobs. v0.1 runs TypeScript
# directly through tsx; a compiled production build lands with the dashboard in v0.2.
FROM node:22-slim
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/voice/package.json apps/voice/
COPY packages/agent/package.json packages/agent/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/observability/package.json packages/observability/
COPY packages/scheduling/package.json packages/scheduling/
COPY packages/telephony/package.json packages/telephony/
COPY packages/voice-engine/package.json packages/voice-engine/
COPY evals/package.json evals/
RUN pnpm install --frozen-lockfile
COPY . .
USER node
EXPOSE 8080
