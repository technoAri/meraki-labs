FROM node:20-alpine AS base
RUN npm install -g pnpm

WORKDIR /app

COPY package.json pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/worker/package.json ./apps/worker/

RUN pnpm install

COPY packages/shared ./packages/shared
COPY apps/worker ./apps/worker

RUN pnpm --filter @task-queue/worker build

FROM node:20-alpine AS runner
RUN npm install -g pnpm

WORKDIR /app

COPY --from=base /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=base /app/packages/shared/package.json ./packages/shared/
COPY --from=base /app/apps/worker/package.json ./apps/worker/

RUN pnpm install --prod

COPY --from=base /app/packages/shared/src ./packages/shared/src
COPY --from=base /app/apps/worker/dist ./apps/worker/dist

EXPOSE 9091
CMD ["node", "apps/worker/dist/index.js"]
