import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(join(__dirname, 'public')));

// ============================================================================
// STATE PERSISTENCE
// ============================================================================

const STATE_FILE = join(__dirname, 'state.json');

const defaultState = {
    jointTargets: [0, 0, 0, 0, 0, 0],
    magnetOn: false,
    objects: [
        { id: 'cube1', position: { x: 0.4, y: 0.025, z: 0.3 } },
        { id: 'cube2', position: { x: -0.3, y: 0.025, z: 0.4 } },
        { id: 'cylinder1', position: { x: 0.25, y: 0.03, z: -0.35 } }
    ]
};

function loadState() {
    try {
        if (existsSync(STATE_FILE)) {
            const data = readFileSync(STATE_FILE, 'utf-8');
            return { ...defaultState, ...JSON.parse(data) };
        }
    } catch (e) {
        console.log('Could not load state, using defaults');
    }
    return { ...defaultState };
}

function saveState() {
    try {
        writeFileSync(STATE_FILE, JSON.stringify(armState, null, 2));
    } catch (e) {
        console.error('Could not save state:', e.message);
    }
}

const armState = loadState();

// Joint limits (not persisted, constant)
const jointLimits = [
    [-180, 180],  // Base rotation
    [-90, 90],    // Shoulder
    [-135, 135],  // Elbow
    [-180, 180],  // Wrist roll
    [-90, 90],    // Wrist pitch
    [-180, 180]   // Wrist rotation
];

// ============================================================================
// MCP TOOL DEFINITIONS
// ============================================================================

const mcpTools = [
    {
        name: 'move_joint',
        description: 'Move a specific joint to an angle. Joint indices: 0=base, 1=shoulder, 2=elbow, 3=wrist roll, 4=wrist pitch, 5=wrist rotation',
        inputSchema: {
            type: 'object',
            properties: {
                joint: { type: 'integer', minimum: 0, maximum: 5, description: 'Joint index (0-5)' },
                angle: { type: 'number', description: 'Target angle in degrees' }
            },
            required: ['joint', 'angle']
        }
    },
    {
        name: 'set_magnet',
        description: 'Turn the magnetic end effector on or off. When on, attracts nearby metallic objects.',
        inputSchema: {
            type: 'object',
            properties: {
                enabled: { type: 'boolean', description: 'true = magnet on, false = magnet off' }
            },
            required: ['enabled']
        }
    },
    {
        name: 'get_arm_state',
        description: 'Get current arm state (joint targets and magnet status).',
        inputSchema: { type: 'object', properties: {} }
    },
    {
        name: 'reset_arm',
        description: 'Reset arm to home position (all joints 0°, magnet off).',
        inputSchema: { type: 'object', properties: {} }
    },
    {
        name: 'set_pose',
        description: 'Set all 6 joint angles at once.',
        inputSchema: {
            type: 'object',
            properties: {
                angles: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 6,
                    maxItems: 6,
                    description: 'Array of 6 angles in degrees'
                }
            },
            required: ['angles']
        }
    },
    {
        name: 'take_screenshot',
        description: 'Capture a screenshot of the current 3D scene.',
        inputSchema: {
            type: 'object',
            properties: {
                width: { type: 'integer', description: 'Width in pixels (default: 800)', minimum: 100, maximum: 1920 },
                height: { type: 'integer', description: 'Height in pixels (default: 600)', minimum: 100, maximum: 1080 }
            }
        }
    }
];

function executeTool(name, args) {
    switch (name) {
        case 'move_joint': {
            const { joint, angle } = args;
            if (joint < 0 || joint > 5) {
                return { success: false, error: 'Joint must be 0-5' };
            }
            const limits = jointLimits[joint];
            const clampedAngle = Math.max(limits[0], Math.min(limits[1], angle));
            armState.jointTargets[joint] = clampedAngle;
            saveState();

            // Send command to browser
            broadcastCommand({ type: 'move_joint', joint, angle: clampedAngle });

            return {
                success: true,
                message: `Joint ${joint} moving to ${clampedAngle}°`,
                jointTargets: [...armState.jointTargets]
            };
        }

        case 'set_magnet': {
            armState.magnetOn = !!args.enabled;
            saveState();
            broadcastCommand({ type: 'set_magnet', enabled: armState.magnetOn });
            return {
                success: true,
                message: `Magnet ${armState.magnetOn ? 'ON' : 'OFF'}`,
                magnetOn: armState.magnetOn
            };
        }

        case 'get_arm_state':
            return {
                success: true,
                state: {
                    jointTargets: [...armState.jointTargets],
                    magnetOn: armState.magnetOn,
                    objects: armState.objects,
                    jointLimits
                }
            };

        case 'reset_arm':
            armState.jointTargets = [0, 0, 0, 0, 0, 0];
            armState.magnetOn = false;
            saveState();
            broadcastCommand({ type: 'reset_arm' });
            return {
                success: true,
                message: 'Arm reset to home position',
                jointTargets: [...armState.jointTargets]
            };

        case 'set_pose': {
            const { angles } = args;
            if (!Array.isArray(angles) || angles.length !== 6) {
                return { success: false, error: 'Must provide array of 6 angles' };
            }
            angles.forEach((angle, i) => {
                const limits = jointLimits[i];
                armState.jointTargets[i] = Math.max(limits[0], Math.min(limits[1], angle));
            });
            saveState();
            broadcastCommand({ type: 'set_pose', angles: armState.jointTargets });
            return {
                success: true,
                message: 'Moving to pose',
                jointTargets: [...armState.jointTargets]
            };
        }

        case 'take_screenshot':
            return 'SCREENSHOT_REQUEST';

        default:
            return { success: false, error: `Unknown tool: ${name}` };
    }
}

// ============================================================================
// CLIENT CONNECTIONS
// ============================================================================

const uiClients = new Set();
const mcpSessions = new Map();

function broadcastCommand(command) {
    const data = JSON.stringify({ command });
    uiClients.forEach(client => {
        if (!client.writableEnded) {
            client.write(`data: ${data}\n\n`);
        }
    });
}

// Screenshot handling
const pendingScreenshots = new Map();

function requestScreenshot(width = 800, height = 600) {
    return new Promise((resolve, reject) => {
        if (uiClients.size === 0) {
            reject(new Error('No browser UI connected'));
            return;
        }

        const requestId = randomUUID();
        const timeout = setTimeout(() => {
            pendingScreenshots.delete(requestId);
            reject(new Error('Screenshot timeout'));
        }, 10000);

        pendingScreenshots.set(requestId, { resolve, reject, timeout });

        const request = JSON.stringify({
            type: 'screenshot_request',
            requestId,
            width,
            height
        });

        for (const client of uiClients) {
            if (!client.writableEnded) {
                client.write(`data: ${request}\n\n`);
                break;
            }
        }
    });
}

// ============================================================================
// MCP ENDPOINT
// ============================================================================

class MCPSession {
    constructor(id) {
        this.id = id;
        this.sseResponse = null;
        this.initialized = false;
    }

    sendSSE(event, data) {
        if (this.sseResponse && !this.sseResponse.writableEnded) {
            this.sseResponse.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
    }
}

app.get('/mcp', (req, res) => {
    const sessionId = randomUUID();
    const session = new MCPSession(sessionId);
    mcpSessions.set(sessionId, session);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Mcp-Session-Id', sessionId);

    session.sseResponse = res;
    session.sendSSE('endpoint', `/mcp?sessionId=${sessionId}`);

    req.on('close', () => {
        mcpSessions.delete(sessionId);
    });
});

app.post('/mcp', async (req, res) => {
    const sessionId = req.query.sessionId || req.headers['mcp-session-id'];
    const message = req.body;

    let session = sessionId ? mcpSessions.get(sessionId) : null;
    if (!session) {
        session = new MCPSession(randomUUID());
    }

    const response = await handleMcpMessage(message, session);

    if (!sessionId && session.id) {
        res.setHeader('Mcp-Session-Id', session.id);
    }

    res.json(response);
});

async function handleMcpMessage(message, session) {
    const { jsonrpc, id, method, params } = message;

    if (jsonrpc !== '2.0') {
        return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } };
    }

    switch (method) {
        case 'initialize':
            session.initialized = true;
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    protocolVersion: '2024-11-05',
                    capabilities: { tools: { listChanged: true } },
                    serverInfo: { name: 'robo-demo', version: '2.0.0' }
                }
            };

        case 'initialized':
            return { jsonrpc: '2.0', id, result: {} };

        case 'tools/list':
            return { jsonrpc: '2.0', id, result: { tools: mcpTools } };

        case 'tools/call': {
            const { name, arguments: args } = params || {};
            if (!name) {
                return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing tool name' } };
            }

            if (name === 'take_screenshot') {
                try {
                    const width = args?.width || 800;
                    const height = args?.height || 600;
                    const imageData = await requestScreenshot(width, height);
                    return {
                        jsonrpc: '2.0',
                        id,
                        result: {
                            content: [{
                                type: 'image',
                                data: imageData,
                                mimeType: 'image/png'
                            }]
                        }
                    };
                } catch (error) {
                    return {
                        jsonrpc: '2.0',
                        id,
                        result: {
                            content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }) }]
                        }
                    };
                }
            }

            const result = executeTool(name, args || {});
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
                }
            };
        }

        case 'ping':
            return { jsonrpc: '2.0', id, result: {} };

        default:
            return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
}

// ============================================================================
// UI ENDPOINTS
// ============================================================================

app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    uiClients.add(res);

    req.on('close', () => {
        uiClients.delete(res);
    });
});

app.get('/api/state', (req, res) => {
    res.json({
        jointTargets: [...armState.jointTargets],
        magnetOn: armState.magnetOn,
        objects: armState.objects,
        jointLimits
    });
});

// Update object positions from browser (for persistence)
app.post('/api/objects', (req, res) => {
    const { objects } = req.body;
    if (Array.isArray(objects)) {
        armState.objects = objects;
        saveState();
    }
    res.json({ success: true });
});

app.post('/api/tools/:name', (req, res) => {
    const tool = mcpTools.find(t => t.name === req.params.name);
    if (!tool) {
        return res.status(404).json({ error: 'Tool not found' });
    }
    const result = executeTool(req.params.name, req.body);
    if (result === 'SCREENSHOT_REQUEST') {
        return res.status(400).json({ error: 'Use MCP endpoint for screenshots' });
    }
    res.json(result);
});

app.get('/api/tools', (req, res) => {
    res.json({ tools: mcpTools });
});

app.post('/api/screenshot', (req, res) => {
    const { requestId, imageData, error } = req.body;
    const pending = pendingScreenshots.get(requestId);
    if (!pending) {
        return res.status(404).json({ error: 'No pending screenshot request' });
    }

    clearTimeout(pending.timeout);
    pendingScreenshots.delete(requestId);

    if (error) {
        pending.reject(new Error(error));
    } else {
        pending.resolve(imageData);
    }

    res.json({ success: true });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', uiClients: uiClients.size, mcpSessions: mcpSessions.size });
});

// ============================================================================
// START SERVER
// ============================================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
🤖 Robo Demo Server v2.0

   Web UI:       http://localhost:${PORT}
   MCP Endpoint: http://localhost:${PORT}/mcp
`);
});
