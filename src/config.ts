import 'dotenv/config';
import type { AgentConfig } from './types';

function required(key: string): string {
  const val = process.env[key];
  if (!val) {
    console.error(`[agent] Variable de entorno requerida: ${key}`);
    process.exit(1);
  }
  return val;
}

export const config: AgentConfig = {
  panelWsUrl: required('PANEL_WS_URL'),
  clientId: required('CLIENT_ID'),
  agentToken: required('AGENT_TOKEN'),
  composeFile: process.env.COMPOSE_FILE || '/opt/app/docker-compose.yml',
  appEnvFile: process.env.APP_ENV_FILE || '',  // ruta al .env de la app
  metricsInterval: Number(process.env.METRICS_INTERVAL || 30_000),
  appContainer: process.env.APP_CONTAINER || '',
  projectName: process.env.PROJECT_NAME || '',
  appDir: process.env.APP_DIR || '',
};
