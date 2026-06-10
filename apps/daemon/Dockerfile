FROM node:22-slim AS deps

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml nx.json tsconfig.base.json ./
COPY apps/daemon/package.json apps/daemon/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY apps/daemon apps/daemon
RUN pnpm --filter @kb-2/daemon build

FROM node:22-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV KB2_HOME=/data/kb2
ENV KB2_HOST=0.0.0.0
ENV KB2_PORT=7382

COPY --from=build /app/apps/daemon/package.json apps/daemon/package.json
COPY --from=build /app/apps/daemon/dist apps/daemon/dist
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/apps/daemon/node_modules apps/daemon/node_modules

VOLUME ["/data/kb2"]
EXPOSE 7382

CMD ["node", "apps/daemon/dist/main.js"]
