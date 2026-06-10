FROM node:22-slim AS deps

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml nx.json tsconfig.base.json ./
COPY apps/daemon/package.json apps/daemon/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY apps/daemon apps/daemon
COPY apps/web apps/web
RUN pnpm --filter @kb-2/web build
RUN pnpm --filter @kb-2/daemon build

FROM node:22-slim AS runtime

WORKDIR /app
RUN corepack enable

ENV NODE_ENV=production
ENV KB2_HOME=/data/kb2
ENV KB2_HOST=0.0.0.0
ENV KB2_PORT=7382

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/daemon/package.json apps/daemon/package.json
RUN pnpm install --prod --frozen-lockfile --filter @kb-2/daemon
COPY --from=build /app/apps/daemon/dist apps/daemon/dist
COPY --from=build /app/apps/web/build apps/web/build

VOLUME ["/data/kb2"]
EXPOSE 7382

CMD ["node", "apps/daemon/dist/main.js"]
