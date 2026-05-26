import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://jaeger:4318/v1/traces',
  }),
});
sdk.start();

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { runMigrations } from './db/migrate.js';
import { authMiddleware } from './middleware/auth.js';
import { rateLimitMiddleware } from './middleware/rateLimit.js';
import { jobRoutes } from './routes/job.routes.js';
import { dlqRoutes } from './routes/dlq.routes.js';
import { metricsRoutes } from './routes/metrics.routes.js';
import { setupWebSocket } from './ws/websocket.js';

const logger = {
  level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
  transport:
    process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
};

const app = Fastify({ logger, bodyLimit: 65_536 });

const allowedOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:5173';
await app.register(cors, {
  origin: allowedOrigin,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key'],
});

app.get('/health', async () => ({ status: 'ok' }));

app.register(metricsRoutes);
app.register(async (instance) => {
  instance.addHook('preHandler', authMiddleware);
  instance.addHook('preHandler', rateLimitMiddleware);
  instance.register(jobRoutes, { prefix: '/v1' });
  instance.register(dlqRoutes, { prefix: '/v1' });
});

const start = async () => {
  try {
    await runMigrations();
    app.log.info('Migrations complete');

    setupWebSocket(app);

    const port = Number(process.env.PORT ?? 3000);
    await app.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
