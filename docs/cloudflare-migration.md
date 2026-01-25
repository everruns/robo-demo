# Cloudflare Workers Migration Plan

## Overview

Migrate the robo-demo Node.js/Express app to Cloudflare Workers with Durable Objects.

**Estimated effort**: 2-3 days
**Monthly cost**: ~$5 (Workers Paid plan required for Durable Objects)

---

## Files to Create

### 1. `wrangler.toml` - Cloudflare configuration

```toml
name = "robo-demo"
main = "src/worker.js"
compatibility_date = "2024-01-01"

# Required for WebSockets and persistent state
[durable_objects]
bindings = [
  { name = "ROBOT_STATE", class_name = "RobotState" }
]

[[migrations]]
tag = "v1"
new_classes = ["RobotState"]

# KV namespace for persistence
[[kv_namespaces]]
binding = "STATE_KV"
id = "your-kv-namespace-id"

# Static assets (the frontend)
[site]
bucket = "./public"
```

### 2. `src/worker.js` - Main entry point

```javascript
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from 'hono/cloudflare-workers';

const app = new Hono();

app.use('*', cors());

// Serve static files from /public
app.get('/*', serveStatic({ root: './' }));

// Get the Durable Object instance
function getRobotState(env) {
  const id = env.ROBOT_STATE.idFromName('singleton');
  return env.ROBOT_STATE.get(id);
}

// Proxy API requests to Durable Object
app.all('/api/*', async (c) => {
  const stub = getRobotState(c.env);
  const url = new URL(c.req.url);
  return stub.fetch(new Request(url.pathname + url.search, c.req.raw));
});

// WebSocket upgrade for real-time
app.get('/ws', async (c) => {
  const stub = getRobotState(c.env);
  return stub.fetch(c.req.raw);
});

// MCP endpoint
app.all('/mcp', async (c) => {
  const stub = getRobotState(c.env);
  return stub.fetch(c.req.raw);
});

// Health check
app.get('/health', (c) => c.json({ status: 'ok' }));

export default app;
export { RobotState } from './robot-state.js';
```

### 3. `src/robot-state.js` - Durable Object (replaces server.js)

```javascript
// This is the Durable Object that holds all state and handles WebSockets

export class RobotState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Set();  // WebSocket connections
    this.armState = null;
    this.motionCompleteResolve = null;
    this.attachmentResolve = null;
  }

  async initialize() {
    if (this.armState) return;

    // Load state from Durable Object storage
    this.armState = await this.state.storage.get('armState') || {
      jointTargets: [0, 0, 0, 0, 0, 0],
      magnetOn: false,
      attachedObject: null,
      objects: [
        { id: 'cube1', type: 'cube', position: { x: 0.4, y: 0.025, z: 0.3 }, size: 0.05, color: 'silver' },
        { id: 'cube2', type: 'cube', position: { x: -0.3, y: 0.025, z: 0.4 }, size: 0.04, color: 'gray' },
        { id: 'cylinder1', type: 'cylinder', position: { x: 0.25, y: 0.03, z: -0.35 }, size: 0.03, color: 'silver' }
      ]
    };
  }

  async saveState() {
    await this.state.storage.put('armState', this.armState);
  }

  broadcast(message) {
    const data = JSON.stringify(message);
    for (const ws of this.sessions) {
      try {
        ws.send(data);
      } catch (e) {
        this.sessions.delete(ws);
      }
    }
  }

  async fetch(request) {
    await this.initialize();

    const url = new URL(request.url);

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request);
    }

    // Route handling
    if (url.pathname === '/api/state') {
      return this.handleGetState();
    }

    if (url.pathname === '/api/objects' && request.method === 'POST') {
      return this.handleUpdateObjects(request);
    }

    if (url.pathname === '/api/motion-status' && request.method === 'POST') {
      return this.handleMotionStatus(request);
    }

    if (url.pathname === '/api/attachment-status' && request.method === 'POST') {
      return this.handleAttachmentStatus(request);
    }

    if (url.pathname === '/mcp' && request.method === 'POST') {
      return this.handleMCP(request);
    }

    if (url.pathname.startsWith('/api/tools')) {
      return this.handleTools(request, url);
    }

    return new Response('Not Found', { status: 404 });
  }

  handleWebSocket(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();
    this.sessions.add(server);

    // Send initial connected message
    server.send(JSON.stringify({ type: 'connected' }));

    server.addEventListener('message', async (event) => {
      // Handle messages from browser (screenshots, etc.)
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'screenshot_response') {
          // Handle screenshot response
        }
      } catch (e) {}
    });

    server.addEventListener('close', () => {
      this.sessions.delete(server);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  handleGetState() {
    return Response.json({
      jointTargets: [...this.armState.jointTargets],
      magnetOn: this.armState.magnetOn,
      objects: this.armState.objects,
      jointLimits: this.getJointLimits()
    });
  }

  async handleUpdateObjects(request) {
    const { objects } = await request.json();
    if (Array.isArray(objects)) {
      objects.forEach(update => {
        const existing = this.armState.objects.find(o => o.id === update.id);
        if (existing) {
          existing.position = update.position;
        }
      });
      await this.saveState();
    }
    return Response.json({ success: true });
  }

  async handleMotionStatus(request) {
    const { complete } = await request.json();
    if (complete && this.motionCompleteResolve) {
      this.motionCompleteResolve();
      this.motionCompleteResolve = null;
    }
    return Response.json({ success: true });
  }

  async handleAttachmentStatus(request) {
    const { objectId, attached } = await request.json();
    if (attached) {
      this.armState.attachedObject = objectId;
      if (this.attachmentResolve) {
        this.attachmentResolve(objectId);
        this.attachmentResolve = null;
      }
    } else if (this.armState.attachedObject === objectId) {
      this.armState.attachedObject = null;
    }
    await this.saveState();
    return Response.json({ success: true });
  }

  async handleMCP(request) {
    const message = await request.json();
    const response = await this.processMCPMessage(message);
    return Response.json(response);
  }

  async handleTools(request, url) {
    if (request.method === 'GET') {
      return Response.json({ tools: this.getMCPTools() });
    }

    const toolName = url.pathname.split('/').pop();
    const args = request.method === 'POST' ? await request.json() : {};
    const result = await this.executeTool(toolName, args);
    return Response.json(result);
  }

  // ... rest of IK solver and task execution methods (copy from server.js)
  // ... MCP handling methods (copy from server.js)

  getJointLimits() {
    return [
      [-180, 180], [-90, 90], [-135, 135],
      [-180, 180], [-90, 90], [-180, 180]
    ];
  }

  getMCPTools() {
    // Return tool definitions (copy from server.js)
  }

  async processMCPMessage(message) {
    // MCP JSON-RPC handling (copy from server.js)
  }

  async executeTool(name, args) {
    // Tool execution (copy from server.js)
  }
}
```

---

## Files to Modify

### 4. `public/index.html` - Replace SSE with WebSocket

Find the SSE connection code and replace:

```javascript
// BEFORE: SSE
const eventSource = new EventSource('/api/events');
eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.command) {
        handleCommand(data.command);
    }
};

// AFTER: WebSocket
let ws;
function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws`);

    ws.onopen = () => console.log('WebSocket connected');

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.command) {
            handleCommand(data.command);
        }
        if (data.type === 'screenshot_request') {
            handleScreenshotRequest(data);
        }
    };

    ws.onclose = () => {
        console.log('WebSocket disconnected, reconnecting...');
        setTimeout(connectWebSocket, 1000);
    };
}
connectWebSocket();

// Update screenshot response to use WebSocket
function sendScreenshotResponse(requestId, imageData) {
    ws.send(JSON.stringify({
        type: 'screenshot_response',
        requestId,
        imageData
    }));
}
```

### 5. `package.json` - Update dependencies

```json
{
  "name": "robo-demo",
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "tail": "wrangler tail"
  },
  "devDependencies": {
    "wrangler": "^3.0.0"
  },
  "dependencies": {
    "hono": "^4.0.0"
  }
}
```

---

## Migration Steps

### Step 1: Install Wrangler CLI
```bash
npm install -g wrangler
wrangler login
```

### Step 2: Create KV namespace
```bash
wrangler kv:namespace create STATE_KV
# Copy the ID to wrangler.toml
```

### Step 3: Restructure files
```
robo-demo/
├── wrangler.toml          # NEW
├── src/
│   ├── worker.js          # NEW (entry point)
│   └── robot-state.js     # NEW (Durable Object, logic from server.js)
├── public/
│   └── index.html         # MODIFIED (SSE → WebSocket)
└── package.json           # MODIFIED
```

### Step 4: Copy business logic

Move these from `server.js` to `robot-state.js`:
- IK solver (`solveIK` function)
- Task execution (`executePickObject`, `executeCarryTo`, etc.)
- MCP tool definitions and handlers
- Arm configuration constants

### Step 5: Test locally
```bash
npm run dev
# Opens at http://localhost:8787
```

### Step 6: Deploy
```bash
npm run deploy
# Deploys to https://robo-demo.<your-subdomain>.workers.dev
```

---

## Key Differences Summary

| Aspect | Node.js/Express | Cloudflare Workers |
|--------|-----------------|-------------------|
| Entry point | `server.js` | `src/worker.js` |
| Framework | Express | Hono |
| State storage | `state.json` (fs) | Durable Object storage |
| Real-time | SSE (`/api/events`) | WebSocket (`/ws`) |
| In-memory state | Global variable | Durable Object instance |
| Sessions | `Set` in memory | Durable Object `this.sessions` |
| Persistence | `writeFileSync` | `this.state.storage.put()` |

---

## Limitations to Be Aware Of

1. **CPU time limit**: 30s per request (dance with long duration may timeout)
2. **WebSocket message size**: 1MB max
3. **Durable Object storage**: 128KB per key max
4. **Cost**: Durable Objects require Workers Paid ($5/month)

---

## Alternative: Cloudflare Containers

If the migration seems too complex, Cloudflare Containers (beta) lets you run the existing Docker container with zero code changes:

```bash
# Just create a Dockerfile and deploy
npx wrangler containers deploy
```

But this is still in beta and pricing is unclear.
