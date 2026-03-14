import WebSocket        from 'ws';
import { config }       from './config';
import { getMetrics }   from './metrics';
import { handleCommand } from './commands';
import type { AgentMessage, PanelMessage } from './types';

const MIN_DELAY =  3_000;
const MAX_DELAY = 60_000;

let ws:             WebSocket | null = null;
let metricsTimer:   NodeJS.Timeout  | null = null;
let reconnectDelay: number = MIN_DELAY;

// ─── Send helper ─────────────────────────────────────────────────────────────
function send(msg: AgentMessage): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ─── Metrics push ─────────────────────────────────────────────────────────────
async function sendMetrics(): Promise<void> {
  try {
    const metrics = await getMetrics();
    send({ type: 'metrics', ...metrics });
  } catch (e: any) {
    console.error('[agent] Error obteniendo métricas:', e.message);
  }
}

// ─── Connect ──────────────────────────────────────────────────────────────────
export function connect(): void {
  console.log(`[agent] Conectando a ${config.panelWsUrl} …`);

  ws = new WebSocket(config.panelWsUrl, {
    headers: {
      'x-client-id':           config.clientId,
      'x-agent-token':         config.agentToken,
      'Host':                  new URL(config.panelWsUrl).hostname,
      'Connection':            'Upgrade',
      'Upgrade':               'websocket',
      'Sec-WebSocket-Version': '13',
    },
  });

  ws.on('open', () => {
    console.log('[agent] Conectado al panel ✓');
    reconnectDelay = MIN_DELAY;

    // Send metrics immediately on connect
    void sendMetrics();

    // Schedule periodic metrics
    metricsTimer = setInterval(() => void sendMetrics(), config.metricsInterval);
  });

  ws.on('message', async (raw: Buffer) => {
    let msg: PanelMessage;
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }

    console.log(`[agent] Comando recibido: ${msg.type}`);
    await handleCommand(msg, config.composeFile, send, sendMetrics);
  });

  ws.on('close', (code: number) => {
    console.warn(`[agent] Desconectado (${code}). Reconectando en ${reconnectDelay / 1000}s…`);
    if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null; }
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
  });

  ws.on('error', (err: Error) => {
    console.error(`[agent] WS error: ${err.message}`);
  });
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
export function shutdown(): void {
  if (metricsTimer) clearInterval(metricsTimer);
  ws?.close();
}
