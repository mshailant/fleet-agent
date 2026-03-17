export interface AgentConfig {
  panelWsUrl:      string;
  clientId:        string;
  agentToken:      string;
  composeFile:     string;
  metricsInterval: number;
  appContainer:    string;  // nombre del contenedor a monitorear para la versión
}

export interface ContainerInfo {
  name:   string;
  status: string;
  image:  string;
  uptime: string;
}

export type AgentStatus = 'online' | 'offline' | 'degraded' | 'unknown';

export interface Metrics {
  cpu:          number;
  ram:          number;
  disk:         number;
  uptime:       string;
  status:       AgentStatus;
  containers:   ContainerInfo[];
  appVersion:   string | null;  // tag detectado automáticamente
}

export interface PanelMessage {
  type:         string;
  cmdId?:       string;
  version?:     string;
  container?:   string;
  tail?:        number;
  dbContainer?: string;
  dbUser?:      string;
  dbName?:      string;
}

export type AgentMessage =
  | { type: 'metrics' } & Metrics
  | { type: 'cmd:log';          cmdId: string; data: string      }
  | { type: 'cmd:done';         cmdId: string                    }
  | { type: 'cmd:error';        cmdId: string; message: string   }
  | { type: 'cmd:logs';         cmdId: string; lines: string[]   }
  | { type: 'cmd:backup-ready'; cmdId: string; filename: string; sizeMb: number; data: string };
