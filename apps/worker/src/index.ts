import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://jaeger:4318/v1/traces',
  }),
});
sdk.start();

import http from 'http';
import { registry } from './metrics.js';
import { runWorkerLoop } from './worker.js';
import { logger } from './logger.js';

const metricsServer = http.createServer(async (_req, res) => {
  res.setHeader('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});
metricsServer.listen(9091, () => {
  logger.info('Worker metrics server on :9091');
});

runWorkerLoop().catch((err) => {
  logger.error(err, 'Fatal worker error');
  process.exit(1);
});
