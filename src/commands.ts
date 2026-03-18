import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import Docker from 'dockerode';
import { getLogs } from './metrics';
import { config } from './config';
import type { PanelMessage, AgentMessage } from './types';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

type SendFn = (msg: AgentMessage) => void;

// ─── Streaming shell command ──────────────────────────────────────────────────
function runStreaming(
  cmd: string,
  env: NodeJS.ProcessEnv,
  onData: (d: string) => void,
  onDone: () => void,
  onError: (msg: string) => void,
): void {
  const child = exec(cmd, { env });
  child.stdout?.on('data', (d: Buffer) => onData(d.toString()));
  child.stderr?.on('data', (d: Buffer) => onData(d.toString()));
  child.on('close', code => (code === 0 ? onDone() : onError(`Proceso terminó con código ${code}`)));
  child.on('error', e => onError(e.message));
}

// ─── Update VERSION in app .env ───────────────────────────────────────────────
function patchEnvVersion(newVersion: string, log: (d: string) => void): boolean {
  // Prefer explicit APP_ENV_FILE, fallback to .env next to compose file
  const envFile = config.appEnvFile || path.join(path.dirname(config.composeFile), '.env');

  if (!fs.existsSync(envFile)) {
    log(`⚠ No se encontró el .env en: ${envFile}\n`);
    return false;
  }
  try {
    let content = fs.readFileSync(envFile, 'utf8');
    content = /^VERSION=/m.test(content)
      ? content.replace(/^VERSION=.*/m, `VERSION=${newVersion}`)
      : content + `\nVERSION=${newVersion}\n`;
    fs.writeFileSync(envFile, content);
    log(`✓ VERSION actualizada a ${newVersion} en ${envFile}\n`);
    return true;
  } catch (e: any) {
    log(`⚠ No se pudo actualizar .env: ${e.message}\n`);
    return false;
  }
}

// ─── Command dispatcher ───────────────────────────────────────────────────────
export async function handleCommand(
  msg: PanelMessage,
  composeFile: string,
  send: SendFn,
  sendMetrics: () => Promise<void>,
): Promise<void> {
  const { cmdId = '', type } = msg;
  const env = { ...process.env, COMPOSE_FILE: composeFile };

  const log = (data: string) => send({ type: 'cmd:log', cmdId, data });
  const done = () => send({ type: 'cmd:done', cmdId });
  const fail = (message: string) => send({ type: 'cmd:error', cmdId, message });

  switch (type) {

    // ── Ping ──────────────────────────────────────────────────────────────────
    case 'ping':
      await sendMetrics();
      break;

    // ── Logs ──────────────────────────────────────────────────────────────────
    case 'logs': {
      const lines = await getLogs(msg.container ?? 'app', msg.tail ?? 100);
      send({ type: 'cmd:logs', cmdId, lines });
      break;
    }

    // ── Update: patch .env VERSION, pull, up ─────────────────────────────────
    case 'update': {
      if (!msg.version) { fail('version requerida'); break; }

      log(`🚀 Iniciando actualización a ${msg.version}…\n`);

      // 1. Patch .env
      patchEnvVersion(msg.version, log);

      // 2. Pull solo el contenedor de la app (más rápido)
      const appContainer = config.appContainer || 'cinexoplatform';
      const projectName = config.projectName || 'cinexoplatform';
      const pullCmd = `docker compose -f ${composeFile} -p ${projectName} pull ${appContainer}`;
      const projectDir = config.appDir || path.dirname(composeFile);
      const upCmd = `docker compose --project-directory ${projectDir} -f ${composeFile} -p ${projectName} up -d ${appContainer}`;

      log(`$ ${pullCmd}\n`);
      runStreaming(pullCmd, env, log, () => {
        log(`$ ${upCmd}\n`);
        runStreaming(upCmd, env, log, async () => {
          log(`✓ Actualización completada\n`);
          done();
          await sendMetrics();
        }, fail);
      }, fail);
      break;
    }

    // ── Rollback: patch .env con versión anterior, up ─────────────────────────
    case 'rollback': {
      if (!msg.version) { fail('version requerida'); break; }

      log(`⏪ Rollback a ${msg.version}…\n`);
      patchEnvVersion(msg.version, log);

      const appContainer = config.appContainer || 'cinexoplatform';
      const pullCmd = `docker compose -f ${composeFile} pull ${appContainer}`;
      const upCmd = `docker compose -f ${composeFile} up -d ${appContainer}`;

      log(`$ ${pullCmd}\n`);
      runStreaming(pullCmd, env, log, () => {
        log(`$ ${upCmd}\n`);
        runStreaming(upCmd, env, log, async () => {
          log(`✓ Rollback completado\n`);
          done();
          await sendMetrics();
        }, fail);
      }, fail);
      break;
    }

    // ── Restart single container ──────────────────────────────────────────────
    case 'restart': {
      if (!msg.container) { fail('container requerido'); break; }
      try {
        log(`Reiniciando ${msg.container}…\n`);
        await docker.getContainer(msg.container).restart();
        log(`✓ ${msg.container} reiniciado\n`);
        done();
        await sendMetrics();
      } catch (e: any) { fail(e.message); }
      break;
    }

    // ── Restart all ───────────────────────────────────────────────────────────
    case 'restart-all': {
      const cmd = `docker compose -f ${composeFile} restart`;
      log(`$ ${cmd}\n`);
      runStreaming(cmd, env, log, async () => { done(); await sendMetrics(); }, fail);
      break;
    }

    // ── Backup ────────────────────────────────────────────────────────────────
    case 'backup': {
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const filename = `db_${date}_${Date.now()}.sql.gz`;
      const tmpPath = `/tmp/${filename}`;
      const dbContainer = msg.dbContainer ?? 'db';
      const dbUser = msg.dbUser ?? 'postgres';
      const dbName = msg.dbName ?? 'app';

      log(`Iniciando pg_dump en contenedor '${dbContainer}'…\n`);

      const dumpCmd = `docker exec ${dbContainer} pg_dump -U ${dbUser} ${dbName} | gzip > ${tmpPath}`;
      runStreaming(dumpCmd, env, log, () => {
        log('pg_dump OK ✓ — enviando al panel…\n`');
        try {
          const data = fs.readFileSync(tmpPath).toString('base64');
          const sizeMb = parseFloat((fs.statSync(tmpPath).size / 1024 / 1024).toFixed(2));
          send({ type: 'cmd:backup-ready', cmdId, filename, sizeMb, data });
        } catch (e: any) {
          fail(`Error leyendo backup: ${e.message}`);
        } finally {
          try { fs.unlinkSync(tmpPath); } catch { }
        }
      }, fail);
      break;
    }

    default:
      console.warn(`[agent] Comando desconocido: ${type}`);
  }
}
