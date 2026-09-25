FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.7.1 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY server ./server
COPY shared ./shared
COPY cli ./cli
COPY tests ./tests
COPY extensions/raycast/src ./extensions/raycast/src
COPY public ./public
RUN pnpm build

FROM build AS production-dependencies
RUN pnpm prune --prod

FROM node:22-bookworm-slim AS runtime
# Public build provenance only. Never pass credentials in these arguments.
ARG TRESTL_BUILD_COMMIT=""
ARG TRESTL_BUILD_REF=""
ARG TRESTL_BUILD_ID=""
ARG TRESTL_BUILD_DATE=""
ENV TRESTL_BUILD_COMMIT=$TRESTL_BUILD_COMMIT TRESTL_BUILD_REF=$TRESTL_BUILD_REF
ENV TRESTL_BUILD_ID=$TRESTL_BUILD_ID TRESTL_BUILD_DATE=$TRESTL_BUILD_DATE
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4317
WORKDIR /app
# tsx is a production dependency; compilers and other development tools stay out.
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --chown=node:node LICENSE ./LICENSE
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -p /app/.data && chown node:node /app/.data
USER node
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:4317/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "server/index.ts"]
