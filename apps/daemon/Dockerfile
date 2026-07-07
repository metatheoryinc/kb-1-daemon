FROM node:22-slim AS deps

WORKDIR /app
RUN corepack enable
ENV NX_DAEMON=false

COPY . .
RUN pnpm install --frozen-lockfile

FROM deps AS build
RUN pnpm --filter @kb-1/web build
RUN pnpm --filter @kb-1/daemon... build
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
  && pnpm install --prod --frozen-lockfile --filter @kb-1/daemon...
RUN mkdir -p /runtime/apps/daemon /runtime/apps/web /runtime/packages \
  && cp package.json pnpm-lock.yaml pnpm-workspace.yaml /runtime/ \
  && cp -a node_modules /runtime/node_modules \
  && cp apps/daemon/package.json /runtime/apps/daemon/package.json \
  && cp -a apps/daemon/node_modules /runtime/apps/daemon/node_modules \
  && cp -a apps/daemon/dist /runtime/apps/daemon/dist \
  && cp -a apps/web/build /runtime/apps/web/build \
  && for package_dir in packages/*; do \
    if [ -f "$package_dir/package.json" ]; then \
      mkdir -p "/runtime/$package_dir"; \
      cp "$package_dir/package.json" "/runtime/$package_dir/package.json"; \
      if [ -d "$package_dir/dist" ]; then cp -a "$package_dir/dist" "/runtime/$package_dir/dist"; fi; \
      if [ -d "$package_dir/node_modules" ]; then cp -a "$package_dir/node_modules" "/runtime/$package_dir/node_modules"; fi; \
    fi; \
  done

FROM node:22-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV KB1_HOME=/data/kb1
ENV KB1_HOST=0.0.0.0
ENV KB1_PORT=7382

COPY --from=build /runtime ./
COPY apps/daemon/scripts/docker-entrypoint.sh /usr/local/bin/kb1-docker-entrypoint

VOLUME ["/data/kb1", "/data/kb2"]
EXPOSE 7382

ENTRYPOINT ["kb1-docker-entrypoint"]
CMD ["node", "apps/daemon/dist/main.js"]
