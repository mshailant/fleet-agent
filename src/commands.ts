import { exec }   from 'child_process';
import * as fs    from 'fs';
import * as path  from 'path';
import Docker     from 'dockerode';
import { getLogs } from './metrics';
import type { PanelMessage, AgentMessage } from './types';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

type SendFn = (msg: AgentMessage) => void;

// ─── Streaming shell command ──────────────────────────────────────────────────
function runStreaming(
  cmd:     string,
  env:     NodeJS.ProcessEnv,
  onData:  (d: string) => void,
  onDone:  () => void,
  onError: (msg: string) => void,
): void {
  const child = exec(cmd, { env });
  child.stdout?.on('data', (d: Buffer) => onData(d.toString()));
  child.stderr?.on('data', (d: Buffer) => onData(d.toString()));
  child.on('close', code => (code === 0 ? onDone() : onError(`Proceso terminó con código ${code}`)));
  child.on('error', e => onError(e.message));
}

// ─── Update .env VERSION field ────────────────────────────────────────────────
function patchEnvVersion(composeFile: string, newVersion: string, log: (d: string) => void): void {
  const envFile = path.join(path.dirname(composeFile), '.env');
  if (!fs.existsSync(envFile)) return;
  try {
    let content = fs.readFileSync(envFile, 'utf8');
    content = /^VERSION=/m.test(content)
      ? content.replace(/^VERSION=.*/m, `VERSION=${newVersion}`)
      : content + `\nVERSION=${newVersion}\n`;
    fs.writeFileSync(envFile, content);
    log(`✓ VERSION actualizada a ${newVersion} en .env\n`);
  } catch (e: any) {
    log(`⚠ No se pudo actualizar .env: ${e.message}\n`);
  }
}

// ─── Command dispatcher ───────────────────────────────────────────────────────
export async function handleCommand(
  msg:         PanelMessage,
  composeFile: string,
  send:        SendFn,
  sendMetrics: () => Promise<void>,
): Promise<void> {
  const { cmdId = '', type } = msg;
  const env = { ...process.env, COMPOSE_FILE: composeFile };

  const log  = (data: string)    => send({ type: 'cmd:log',   cmdId, data });
  const done = ()                => send({ type: 'cmd:done',  cmdId });
  const fail = (message: string) => send({ type: 'cmd:error', cmdId, message });

  switch (type) {

    // ── Ping: return metrics immediately ─────────────────────────────────────
    case 'ping':
      await sendMetrics();
      break;

    // ── Logs ─────────────────────────────────────────────────────────────────
    case 'logs': {
      const lines = await getLogs(msg.container ?? 'app', msg.tail ?? 100);
      send({ type: 'cmd:logs', cmdId, lines });
      break;
    }

    // ── Update: patch .env, pull, up ─────────────────────────────────────────
    case 'update': {
      if (msg.version) patchEnvVersion(composeFile, msg.version, log);

      const steps = [
        `docker-compose -f ${composeFile} pull`,
        `docker-compose -f ${composeFile} up -d`,
      ];

      let i = 0;
      const runNext = (): void => {
        if (i >= steps.length) { done(); return; }
        const cmd = steps[i++];
        log(`$ ${cmd}\n`);
        runStreaming(cmd, env, log, runNext, fail);
      };
      runNext();
      break;
    }

    // ── Rollback ──────────────────────────────────────────────────────────────
    case 'rollback': {
      if (!msg.version) { fail('version requerida'); break; }
      const cmd = `APP_VERSION=${msg.version} docker-compose -f ${composeFile} up -d`;
      log(`$ ${cmd}\n`);
      runStreaming(cmd, env, log, done, fail);
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
      const cmd = `docker-compose -f ${composeFile} restart`;
      log(`$ ${cmd}\n`);
      runStreaming(cmd, env, log, async () => { done(); await sendMetrics(); }, fail);
      break;
    }

    // ── Backup: pg_dump → gzip → send to panel ───────────────────────────────
    case 'backup': {
      const date        = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const filename    = `db_${date}_${Date.now()}.sql.gz`;
      const tmpPath     = `/tmp/${filename}`;
      const dbContainer = msg.dbContainer ?? 'db';
      const dbUser      = msg.dbUser      ?? 'postgres';
      const dbName      = msg.dbName      ?? 'app';

      log(`Iniciando pg_dump en contenedor '${dbContainer}'…\n`);

      const dumpCmd = `docker exec ${dbContainer} pg_dump -U ${dbUser} ${dbName} | gzip > ${tmpPath}`;
      runStreaming(dumpCmd, env, log, () => {
        log('pg_dump OK ✓ — enviando al panel…\n');
        try {
          const data   = fs.readFileSync(tmpPath).toString('base64');
          const sizeMb = parseFloat((fs.statSync(tmpPath).size / 1024 / 1024).toFixed(2));
          send({ type: 'cmd:backup-ready', cmdId, filename, sizeMb, data });
        } catch (e: any) {
          fail(`Error leyendo backup: ${e.message}`);
        } finally {
          try { fs.unlinkSync(tmpPath); } catch {}
        }
      }, fail);
      break;
    }

    default:
      console.warn(`[agent] Comando desconocido: ${type}`);
  }
}
