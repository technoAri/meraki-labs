import { useEffect, useRef } from 'react';
import type { WSMessage } from '@task-queue/shared';
import { WS_URL, API_KEY } from '../config.js';
const MAX_BACKOFF_MS = 30_000;

export function useWebSocket(onMessage: (msg: WSMessage) => void): void {
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 1_000;
    let destroyed = false;

    function connect() {
      ws = new WebSocket(`${WS_URL}?api_key=${API_KEY}`);

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as WSMessage;
          onMessageRef.current(msg);
        } catch {
          // ignore malformed messages
        }
      };

      ws.onopen = () => { backoffMs = 1_000; };

      ws.onclose = () => {
        if (destroyed) return;
        reconnectTimer = setTimeout(() => {
          if (!destroyed) connect();
        }, backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      };

      ws.onerror = () => ws.close();
    }

    connect();

    return () => {
      destroyed = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      ws.close();
    };
  }, []);
}
