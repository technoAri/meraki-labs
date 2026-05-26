FROM node:20-alpine AS builder
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
COPY apps/dashboard ./apps/dashboard

ARG VITE_API_URL=http://localhost/v1
ARG VITE_WS_URL=ws://localhost/ws
ARG VITE_API_KEY=test-e2e-key-5678

ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL
ENV VITE_API_KEY=$VITE_API_KEY

RUN pnpm --filter @task-queue/dashboard build

FROM nginx:alpine
COPY --from=builder /app/apps/dashboard/dist /usr/share/nginx/html
COPY apps/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
