import * as os        from 'os';
import { execSync }   from 'child_process';
import Docker         from 'dockerode';
import type { Metrics, ContainerInfo, AgentStatus } from './types';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// ─── CPU (average over 200ms sample) ─────────────────────────────────────────
async function getCpu(): Promise<number> {
  const before = os.cpus().map(c => c.times);
  await new Promise(r => setTimeout(r, 200));
  const after = os.cpus().map(c => c.times);

  const pcts = before.map((b, i) => {
    const a     = after[i];
    const idle  = a.idle - b.idle;
    const total = (Object.values(a).reduce((s, v) => s + v, 0))
                - (Object.values(b).reduce((s, v) => s + v, 0));
    return total === 0 ? 0 : 100 - Math.round((idle / total) * 100);
  });

  return Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length);
}

// ─── RAM ──────────────────────────────────────────────────────────────────────
function getRam(): number {
  return Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100);
}

// ─── Disk (BusyBox + GNU compatible) ─────────────────────────────────────────
function getDisk(): number {
  try {
    const out  = execSync('df / | tail -1').toString().trim();
    const cols = out.split(/\s+/);
    // POSIX: 0=Filesystem 1=1K-blocks 2=Used 3=Available 4=Use% 5=Mounted
    const pct  = cols[4] ?? cols[3] ?? '0';
    return parseInt(pct.replace('%', ''), 10);
  } catch {
    return 0;
  }
}

// ─── Uptime ───────────────────────────────────────────────────────────────────
function getUptime(): string {
  const sec = os.uptime();
  const d   = Math.floor(sec / 86400);
  const h   = Math.floor((sec % 86400) / 3600);
  const m   = Math.floor((sec % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

// ─── Containers ───────────────────────────────────────────────────────────────
async function getContainers(): Promise<ContainerInfo[]> {
  try {
    const list = await docker.listContainers({ all: true });
    return list.map(c => ({
      name:   c.Names[0].replace('/', ''),
      status: c.State,
      image:  c.Image,
      uptime: c.Status,
    }));
  } catch {
    return [];
  }
}

// ─── Overall status ───────────────────────────────────────────────────────────
function computeStatus(containers: ContainerInfo[]): AgentStatus {
  const total   = containers.length;
  const running = containers.filter(c => c.status === 'running').length;
  if (total === 0)          return 'unknown';
  if (running === total)    return 'online';
  if (running === 0)        return 'offline';
  return 'degraded';
}

// ─── Public ───────────────────────────────────────────────────────────────────
export async function getMetrics(): Promise<Metrics> {
  const [cpu, containers] = await Promise.all([getCpu(), getContainers()]);
  return {
    cpu,
    ram:        getRam(),
    disk:       getDisk(),
    uptime:     getUptime(),
    status:     computeStatus(containers),
    containers,
  };
}

// ─── Logs ─────────────────────────────────────────────────────────────────────
export async function getLogs(containerName = 'app', tail = 50): Promise<string[]> {
  try {
    const container = docker.getContainer(containerName);
    const buf = await container.logs({ stdout: true, stderr: true, tail });
    return (buf as Buffer).toString('utf8')
      .replace(/[\x00-\x08\x0e-\x1f]/g, '')
      .split('\n')
      .filter(Boolean)
      .slice(-tail);
  } catch (e: any) {
    return [`[agent] Error obteniendo logs de '${containerName}': ${e.message}`];
  }
}
