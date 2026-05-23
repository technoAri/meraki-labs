import { WebSocketServer, WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'http';
import { sql } from '../db/client.js';
import type { WSMessage } from '@task-queue/shared';

interface AuthedSocket extends WebSocket {
  tenantId: string;
}

let wss: WebSocketServer | null = null;

export function setupWebSocket(app: FastifyInstance): void {
  wss = new WebSocketServer({ server: app.server });

  sql.listen('job_status_change', (payload) => {
    try {
      const data = JSON.parse(payload) as WSMessage['data'];
      broadcast({ type: 'JOB_UPDATE', data });
    } catch {
      app.log.warn('Malformed job_status_change notification');
    }
  }).catch((err) => app.log.error(err, 'LISTEN job_status_change failed'));

  wss.on('connection', async (socket: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const apiKey = url.searchParams.get('api_key');

    if (!apiKey) {
      socket.close(1008, 'Missing api_key');
      return;
    }

    const rows = await sql<{ id: string }[]>`
      SELECT id FROM tenants WHERE api_key = ${apiKey} LIMIT 1
    `;

    if (rows.length === 0) {
      socket.close(1008, 'Invalid api_key');
      return;
    }

    (socket as AuthedSocket).tenantId = rows[0].id;
    socket.on('error', () => socket.terminate());
  });
}

export function broadcast(message: WSMessage): void {
  if (!wss) return;
  const payload = JSON.stringify(message);
  wss.clients.forEach((client) => {
    const authed = client as AuthedSocket;
    if (authed.readyState === WebSocket.OPEN && authed.tenantId === message.data.tenant_id) {
      authed.send(payload);
    }
  });
}
