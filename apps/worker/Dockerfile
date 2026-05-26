FROM node:20-alpine AS base
RUN npm install -g pnpm

WORKDIR /app

COPY package.json pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/dashboard/package.json ./apps/dashboard/
COPY e2e/package.json ./e2e/

RUN pnpm install

COPY packages/shared ./packages/shared
COPY apps/worker ./apps/worker

RUN pnpm --filter @task-queue/worker build

FROM node:20-alpine AS runner
RUN npm install -g pnpm

WORKDIR /app

COPY --from=base /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=base /app/packages/shared/package.json ./packages/shared/
COPY --from=base /app/apps/api/package.json ./apps/api/
COPY --from=base /app/apps/worker/package.json ./apps/worker/
COPY --from=base /app/apps/dashboard/package.json ./apps/dashboard/
COPY --from=base /app/e2e/package.json ./e2e/

RUN pnpm install --prod

COPY --from=base /app/packages/shared/src ./packages/shared/src
COPY --from=base /app/apps/worker/dist ./apps/worker/dist

EXPOSE 9091
CMD ["node", "apps/worker/dist/index.js"]
