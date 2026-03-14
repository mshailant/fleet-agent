# Cinexo Fleet Agent

Agente que corre en cada servidor cliente y se conecta al panel FleetOps.

- Conexión WebSocket **saliente** — sin abrir puertos en el servidor
- Métricas en tiempo real (CPU, RAM, disco, contenedores)
- Comandos remotos: update, rollback, restart, backup, logs

---

## Instalación

### 1. Clonar el repo

```bash
cd /opt
git clone https://github.com/nexosoluciones/cinexo-fleet-agent.git fleet-agent
```

### 2. Configurar variables

```bash
cp .env.example .env
nano .env
```

```env
PANEL_WS_URL=wss://panel.monitoreocinexo.com.ar/ws/agent
CLIENT_ID=c_xxxx      # del tab Info del cliente en el panel
AGENT_TOKEN=tok-xxxx  # del tab Info del cliente en el panel
COMPOSE_FILE=/opt/app/docker-compose.yml
```

### 3. Agregar al docker-compose.yml de la app

```yaml
services:
  fleet-agent:
    build: /opt/fleet-agent
    restart: unless-stopped
    env_file: /opt/fleet-agent/.env
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./docker-compose.yml:/opt/app/docker-compose.yml:ro
```

```bash
docker compose up -d fleet-agent
docker compose logs -f fleet-agent
# debe decir: [agent] Conectado al panel ✓
```

---

## Variables de entorno

| Variable | Requerida | Descripción |
|----------|-----------|-------------|
| `PANEL_WS_URL` | ✓ | URL WebSocket del panel |
| `CLIENT_ID` | ✓ | ID del cliente en el panel |
| `AGENT_TOKEN` | ✓ | Token secreto del cliente |
| `COMPOSE_FILE` | — | Ruta al docker-compose.yml (default: `/opt/app/docker-compose.yml`) |
| `METRICS_INTERVAL` | — | Intervalo de métricas en ms (default: `30000`) |

---

## Desarrollo local

```bash
npm install
cp .env.example .env  # completar con valores locales
npm run watch
```
