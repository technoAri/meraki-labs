FROM node:20-alpine AS base
RUN npm install -g pnpm

WORKDIR /app

COPY package.json pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/

RUN pnpm install

COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

RUN pnpm --filter @task-queue/api build

FROM node:20-alpine AS runner
RUN npm install -g pnpm

WORKDIR /app

COPY --from=base /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=base /app/packages/shared/package.json ./packages/shared/
COPY --from=base /app/apps/api/package.json ./apps/api/

RUN pnpm install --prod

COPY --from=base /app/packages/shared/src ./packages/shared/src
COPY --from=base /app/apps/api/dist ./apps/api/dist
COPY --from=base /app/apps/api/src/db/migrations ./apps/api/dist/db/migrations

EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
