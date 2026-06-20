# robot-fastify-backend

Agent orchestration server built with [Fastify](https://fastify.dev). Spawns and manages [pi](https://github.com/mariozechner/pi-coding-agent) coding agents, exposes them over REST and WebSocket so any frontend (Telegram, WhatsApp, custom UI) can interact with them.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Fastify Server                        │
│                                                          │
│  ┌─────────────────────┐   ┌──────────────────────────┐ │
│  │    AgentManager      │   │   RequestProcessor       │ │
│  │                      │   │                          │ │
│  │  spawn / kill        │◄──│  REST routes             │ │
│  │  prompt / abort      │   │  WebSocket handler       │ │
│  │  session persistence │──►│  event broadcasting      │ │
│  │                      │   │                          │ │
│  │  ┌───────────────┐   │   └──────────────────────────┘ │
│  │  │  PiAgent      │   │                                │
│  │  │  (pi --mode   │   │                                │
│  │  │   rpc child   │   │                                │
│  │  │   process)    │   │                                │
│  │  └───────────────┘   │                                │
│  └─────────────────────┘                                 │
└──────────────────────────────────────────────────────────┘
         │                              ▲
         ▼                              │
   .data/sessions/          Frontends (Telegram, WS clients, …)
   (persisted agent state)
```

### Subsystems

**AgentManager** (`src/subsystems/agent-manager/`)

Core process manager. Maintains a registry of running agents, forwards their events, and handles session persistence to disk.

- `index.ts` — `AgentManager` class. `spawn()`, `kill()`, `killAll()`, `prompt()`, `abort()`, `newSession()`, `listAgents()`, `getStatus()`, `listSavedSessions()`. Emits `agent:output`, `agent:message_complete`, `agent:exit`, `agent:error`.
- `pi-agent.ts` — `PiAgent` class. Wraps a single `pi --mode rpc` child process. Parses JSONL events from stdout, manages session files, auto-responds to extension UI requests.

**RequestProcessor** (`src/subsystems/request-processor/`)

Fastify plugin that wires up all HTTP routes and WebSocket handling.

- `index.ts` — Registers all route modules and WebSocket.
- `routes/` — Individual route files (see [REST API](#rest-api) below).
- `websocket.ts` — Real-time bidirectional channel (see [WebSocket API](#websocket-api) below).

### Types

`src/types/agent.ts` — Shared type definitions (`AgentInfo`, `AgentOutput`, `SpawnAgentRequest`, `SystemStatus`, etc.) used across both subsystems.

### Configuration

`src/config.ts` — Loads config from environment variables. `APP_ENV` selects between two independent default sets:

| Setting | `development` (default) | `production` |
|---|---|---|
| `BACKEND_HOST` | `127.0.0.1` | `0.0.0.0` |
| `BACKEND_PORT` | `3100` | `3100` |
| `WORKSPACE` | `.data/workspace` | `/workspace` |
| `SESSION_STORAGE` | `.data/sessions` | `/data/agent-sessions` |
| `LOG_LEVEL` | `debug` | `info` |

Every value can be overridden by its own env var regardless of `APP_ENV`.

`validateConfig()` checks for missing critical values (`ANTHROPIC_API_KEY`, `WORKSPACE`, `SESSION_STORAGE`, `PI_PROVIDER`, valid port) and returns a list of errors. Called at startup — the server exits immediately if validation fails.

## REST API

### `GET /health_check`

Liveness probe.

```json
// 200
{ "status": "ok" }

// 500
{ "status": "error", "message": "..." }
```

### `GET /status`

Detailed system status from the AgentManager.

```json
// 200
{
  "uptime": 42000,
  "agentCount": 2,
  "agents": [
    {
      "id": "abc123",
      "name": "tg-99999",
      "runtime": "pi",
      "status": "running",
      "cwd": "/workspace",
      "currentTask": "fix the login bug",
      "createdAt": 1711000000000,
      "lastActivityAt": 1711000042000,
      "hasSession": true,
      "meta": {}
    }
  ],
  "sessionStoragePath": "/data/agent-sessions"
}
```

### `POST /agents`

Spawn a new agent.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✓ | Human-readable name |
| `runtime` | `"pi" \| "custom"` | | Default `"pi"` |
| `cwd` | string | | Working directory (default: configured workspace) |
| `provider` | string | | LLM provider (default: from config) |
| `model` | string | | Model ID |
| `tools` | string | | Comma-separated tool list |
| `systemPrompt` | string | | Appended to pi's system prompt |
| `sessionId` | string | | Custom ID (default: auto-generated nanoid) |
| `resumeSession` | boolean | | Resume from existing session file |

```json
// 201
{ "id": "abc123", "name": "my-agent", "status": "idle", ... }

// 400
{ "error": "name is required" }

// 409
{ "error": "Agent with id \"abc123\" already exists" }
```

### `GET /agents`

List all running agents. Returns `AgentInfo[]`.

### `GET /agents/:id`

Get a single agent's info.

```json
// 404
{ "error": "agent not found" }
```

### `POST /agents/:id/prompt`

Send a prompt to a running agent.

**Request body:** `{ "message": "your prompt here" }`

```json
// 200
{ "ok": true }

// 400
{ "error": "message is required" }

// 404
{ "error": "agent not found" }
```

### `POST /agents/:id/abort`

Abort the agent's current operation.

```json
// 200
{ "ok": true }
```

### `POST /agents/:id/new-session`

Start a fresh conversation (keeps the pi process alive).

```json
// 200
{ "ok": true }
```

### `DELETE /agents/:id`

Kill an agent and remove it from the registry. Idempotent — returns `200` even if the agent doesn't exist.

```json
// 200
{ "ok": true }
```

### `GET /agents/sessions`

List saved session IDs on disk (filenames without `.json` extension).

```json
// 200
["tg-99999", "my-agent"]
```

## WebSocket API

Connect to `ws://<host>:<port>/ws`.

### Client → Server messages

| Action | Fields | Description |
|---|---|---|
| `subscribe` | `agentId` | Subscribe to one agent's events |
| `unsubscribe` | `agentId` | Unsubscribe |
| `subscribe_all` | — | Receive events from all agents |
| `prompt` | `agentId`, `message` | Send a prompt |
| `abort` | `agentId` | Abort current operation |
| `spawn` | (same as POST /agents body) | Spawn + auto-subscribe |
| `kill` | `agentId` | Kill + auto-unsubscribe |
| `status` | — | Request system status |

All actions receive an `ack` response:

```json
{ "ack": "subscribed", "agentId": "abc123" }
{ "ack": "spawned", "agent": { ... } }
{ "ack": "status", "data": { ... } }
```

### Server → Client events

Events pushed to subscribed clients:

```json
// Agent output (text delta, tool activity, status change, raw pi events)
{
  "type": "text" | "tool_start" | "tool_end" | "status_change" | "error" | "raw_event",
  "agentId": "abc123",
  "timestamp": 1711000042000,
  "data": ...
}

// Complete agent response (full accumulated text)
{
  "type": "message_complete",
  "agentId": "abc123",
  "timestamp": 1711000042000,
  "data": "Here's what I found..."
}

// Agent process exited
{
  "type": "agent_exit",
  "agentId": "abc123",
  "timestamp": 1711000042000,
  "data": { "code": 0 }
}
```

## Local Development

**Prerequisites:** [Bun](https://bun.sh) installed.

```bash
# Install dependencies
bun install

# Set your API key (pick one)
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env.development
# — or —
export ANTHROPIC_API_KEY=sk-ant-...

# Start dev server (auto-reload on file changes)
bun run dev

# Run tests
bun test

# Type-check without emitting
bun run check
```

The dev server binds to `127.0.0.1:3100` and stores sessions in `.data/sessions/` (git-ignored). No Docker or system paths required.

### Quick smoke test

```bash
# Health check
curl http://localhost:3100/health_check

# System status
curl http://localhost:3100/status

# Spawn an agent
curl -X POST http://localhost:3100/agents \
  -H 'Content-Type: application/json' \
  -d '{"name": "test-agent"}'

# Send a prompt
curl -X POST http://localhost:3100/agents/<id>/prompt \
  -H 'Content-Type: application/json' \
  -d '{"message": "hello"}'

# List agents
curl http://localhost:3100/agents

# Kill it
curl -X DELETE http://localhost:3100/agents/<id>
```

### End-to-end example: REST

A full scenario — spawn an agent, send a prompt, poll for output, and clean up.

```bash
# 1. Spawn an agent
curl -s -X POST http://localhost:3100/agents \
  -H 'Content-Type: application/json' \
  -d '{"name": "demo", "sessionId": "demo-1"}' | jq .

# Response:
# {
#   "id": "demo-1",
#   "name": "demo",
#   "runtime": "pi",
#   "status": "idle",
#   "cwd": "/workspace",
#   "currentTask": "",
#   ...
# }

# 2. Send a prompt
curl -s -X POST http://localhost:3100/agents/demo-1/prompt \
  -H 'Content-Type: application/json' \
  -d '{"message": "List all files in the current directory"}' | jq .

# { "ok": true }

# 3. Poll the agent status — wait until status is back to "idle"
#    (means the agent finished processing)
while true; do
  STATUS=$(curl -s http://localhost:3100/agents/demo-1 | jq -r .status)
  echo "Agent status: $STATUS"
  [ "$STATUS" = "idle" ] && break
  sleep 1
done

# 4. Check system status — see what the agent did
curl -s http://localhost:3100/status | jq .

# 5. Send another prompt (conversation continues)
curl -s -X POST http://localhost:3100/agents/demo-1/prompt \
  -H 'Content-Type: application/json' \
  -d '{"message": "Now count how many .ts files there are"}' | jq .

# 6. When done, kill the agent
curl -s -X DELETE http://localhost:3100/agents/demo-1 | jq .

# { "ok": true }
```

### End-to-end example: WebSocket

Same scenario but over WebSocket — you get real-time streaming output instead of polling. Requires [websocat](https://github.com/vi/websocat) or similar.

```bash
# Connect and subscribe to all events
websocat ws://localhost:3100/ws

# --- Paste these JSON messages one at a time: ---

# 1. Spawn (auto-subscribes you to the new agent)
{"action":"spawn","name":"demo","sessionId":"demo-ws"}

# Server responds:
# {"ack":"spawned","agent":{"id":"demo-ws","name":"demo","status":"idle",...}}

# 2. Send a prompt
{"action":"prompt","agentId":"demo-ws","message":"What OS is this?"}

# Server starts streaming events:
# {"type":"status_change","agentId":"demo-ws","data":{"status":"running"},...}
# {"type":"text","agentId":"demo-ws","data":"This is",...}
# {"type":"text","agentId":"demo-ws","data":" Ubuntu 24.04",...}
# {"type":"tool_start","agentId":"demo-ws","data":{"toolName":"bash","args":{"command":"uname -a"}},...}
# {"type":"tool_end","agentId":"demo-ws","data":{"toolName":"bash"},...}
# {"type":"message_complete","agentId":"demo-ws","data":"This is Ubuntu 24.04...",...}
# {"type":"status_change","agentId":"demo-ws","data":{"status":"idle"},...}

# 3. Send another prompt (conversation continues with context)
{"action":"prompt","agentId":"demo-ws","message":"Now check available disk space"}

# 4. Kill when done
{"action":"kill","agentId":"demo-ws"}

# {"ack":"killed","agentId":"demo-ws"}
```

The key difference: with WebSocket you see every text delta, tool execution, and status change as they happen — no polling needed. This is what the Telegram frontend uses internally.

## Docker

The backend runs as the `backend` service in the root `docker-compose.yml`. `APP_ENV=production` is set automatically. Session state is persisted to the `agent-sessions` Docker volume.

```bash
# From the repo root
docker compose up backend
```

## Project Structure

```
robot-fastify-backend/
├── src/
│   ├── index.ts                          Entry point
│   ├── config.ts                         Env-based config + validation
│   ├── types/
│   │   └── agent.ts                      Shared type definitions
│   └── subsystems/
│       ├── agent-manager/
│       │   ├── index.ts                  AgentManager (registry + lifecycle)
│       │   └── pi-agent.ts              PiAgent (pi --mode rpc wrapper)
│       └── request-processor/
│           ├── index.ts                  Plugin registration
│           ├── websocket.ts              WebSocket handler
│           └── routes/
│               ├── health.ts             GET /health_check
│               ├── status.ts             GET /status
│               └── agents.ts             Agent CRUD + control
├── tests/
│   └── api.test.ts                       Integration tests (Fastify inject)
├── .env.development                      Dev defaults (committed)
├── package.json
└── tsconfig.json
```
