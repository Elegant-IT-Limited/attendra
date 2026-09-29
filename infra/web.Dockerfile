# The staff dashboard: a standalone Next.js build on a slim runtime image.
# API_URL is read at build time (Next bakes rewrites into the build), so build
# the image for the network it will run on; compose passes http://api:8081.
FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
ARG API_URL=http://api:8081
ENV API_URL=$API_URL
RUN pnpm --filter @attendra/web build

FROM node:22-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
