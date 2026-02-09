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

// Use /tmp in serverless (Vercel) since source dir is read-only
const STATE_FILE = process.env.VERCEL
    ? '/tmp/state.json'
    : join(__dirname, 'state.json');

const defaultState = {
    jointTargets: [0, 0, 0, 0, 0, 0],
    magnetOn: false,
    attachedObject: null,
    objects: [
        { id: 'cube1', type: 'cube', position: { x: 0.4, y: 0.025, z: 0.3 }, size: 0.05, color: 'silver' },
        { id: 'cube2', type: 'cube', position: { x: -0.3, y: 0.025, z: 0.4 }, size: 0.04, color: 'gray' },
        { id: 'cylinder1', type: 'cylinder', position: { x: 0.25, y: 0.03, z: -0.35 }, size: 0.03, color: 'silver' }
    ],
    pendingCommand: null,
    commandResult: null
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

// Arm configuration (used by get_environment_info)
const ARM_CONFIG = {
    baseHeight: 0.1,
    L1: 0.35,
    L2: 0.30,
    L3: 0.35,
    reachRadius: 0.80,
    maxHeight: 0.95,
    minHeight: 0.05
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// MCP TOOL DEFINITIONS
// ============================================================================

const mcpTools = [
    // Discovery Tools
    {
        name: 'take_screenshot',
        description: 'Capture a screenshot of the current 3D scene. Returns a base64 PNG image.',
        inputSchema: {
            type: 'object',
            properties: {
                width: { type: 'integer', description: 'Width in pixels (default: 800)', minimum: 100, maximum: 1920 },
                height: { type: 'integer', description: 'Height in pixels (default: 600)', minimum: 100, maximum: 1080 }
            }
        }
    },
    {
        name: 'discover_objects',
        description: 'List all metallic objects in the scene that can be picked up by the magnetic gripper.',
        inputSchema: { type: 'object', properties: {} }
    },
    {
        name: 'get_environment_info',
        description: 'Get information about the robot arm, workspace bounds, and coordinate system.',
        inputSchema: { type: 'object', properties: {} }
    },
    // Task Execution Tools
    {
        name: 'pick_object',
        description: 'Move the arm to the specified object and pick it up with the magnetic gripper. The arm will move above the object, descend, activate the magnet, and lift.',
        inputSchema: {
            type: 'object',
            properties: {
                object_id: { type: 'string', description: 'ID of the object to pick (from discover_objects)' }
            },
            required: ['object_id']
        }
    },
    {
        name: 'carry_to',
        description: 'Move the currently held object to a specified position. Must be holding an object first (use pick_object).',
        inputSchema: {
            type: 'object',
            properties: {
                x: { type: 'number', description: 'X coordinate (right is positive)' },
                y: { type: 'number', description: 'Y coordinate (up is positive, should be > 0.1 to stay above ground)' },
                z: { type: 'number', description: 'Z coordinate (forward is positive)' }
            },
            required: ['x', 'y', 'z']
        }
    },
    {
        name: 'place_object',
        description: 'Release the currently held object. Optionally move to a position first. The object will fall due to gravity.',
        inputSchema: {
            type: 'object',
            properties: {
                x: { type: 'number', description: 'Optional X coordinate to move to before placing' },
                y: { type: 'number', description: 'Optional Y coordinate to move to before placing' },
                z: { type: 'number', description: 'Optional Z coordinate to move to before placing' }
            }
        }
    },
    {
        name: 'dance',
        description: 'Make the robot arm perform a fun dance animation.',
        inputSchema: {
            type: 'object',
            properties: {
                duration_seconds: { type: 'number', description: 'Duration of the dance in seconds (default: 5)', minimum: 1, maximum: 30 }
            }
        }
    },
    {
        name: 'reset_to_base',
        description: 'Return the arm to its home position (all joints at 0 degrees) and release any held object.',
        inputSchema: { type: 'object', properties: {} }
    }
];

// Sync tools return data directly from server state
function executeSyncTool(name, args) {
    switch (name) {
        case 'discover_objects':
            return {
                objects: armState.objects.map(obj => ({
                    id: obj.id,
                    type: obj.type || 'cube',
                    position: { ...obj.position },
                    size: obj.size || 0.05,
                    color: obj.color || 'silver',
                    attached: armState.attachedObject === obj.id
                }))
            };

        case 'get_environment_info':
            return {
                coordinate_system: {
                    type: 'right-handed',
                    units: 'meters',
                    origin: 'base of robot arm',
                    x_axis: 'right (positive)',
                    y_axis: 'up (positive)',
                    z_axis: 'forward (positive)'
                },
                arm: {
                    type: '6-DOF serial manipulator',
                    reach_radius: ARM_CONFIG.reachRadius,
                    max_height: ARM_CONFIG.maxHeight,
                    min_height: ARM_CONFIG.minHeight,
                    end_effector: 'electromagnetic magnet (radius 0.05m)',
                    joint_limits: jointLimits.map((limits, i) => ({
                        joint: i,
                        min: limits[0],
                        max: limits[1],
                        unit: 'degrees'
                    }))
                },
                workspace: {
                    floor_height: 0,
                    bounds: { x: [-0.8, 0.8], y: [0.05, 0.95], z: [-0.8, 0.8] }
                },
                current_state: {
                    holding_object: armState.attachedObject,
                    magnet_on: armState.magnetOn
                },
                hint: 'Use discover_objects to get current object positions'
            };

        default:
            return null;
    }
}

// Async tools are delegated to the browser via command queue
const ASYNC_TOOLS = new Set([
    'pick_object', 'carry_to', 'place_object', 'dance', 'reset_to_base', 'take_screenshot'
]);

async function executeViaCommandQueue(name, args, timeoutMs = 30000) {
    const commandId = randomUUID();

    // Write pending command for browser to pick up
    armState.pendingCommand = {
        id: commandId,
        tool: name,
        args: args || {},
        timestamp: Date.now()
    };
    armState.commandResult = null;
    saveState();

    // Poll for result from browser
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
        await sleep(200);

        if (armState.commandResult && armState.commandResult.commandId === commandId) {
            const result = { ...armState.commandResult };
            armState.pendingCommand = null;
            armState.commandResult = null;
            saveState();
            return result;
        }
    }

    // Timeout
    armState.pendingCommand = null;
    saveState();
    return { success: false, error: 'Command timeout - is a browser tab open?' };
}

// ============================================================================
// CLIENT CONNECTIONS (SSE - kept for backward compat)
// ============================================================================

const uiClients = new Set();
const mcpSessions = new Map();

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
                    serverInfo: { name: 'robo-demo', version: '3.0.0' }
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

            // Sync tools: handle directly on server
            const syncResult = executeSyncTool(name, args || {});
            if (syncResult !== null) {
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        content: [{ type: 'text', text: JSON.stringify(syncResult, null, 2) }]
                    }
                };
            }

            // Async tools: delegate to browser via command queue
            if (ASYNC_TOOLS.has(name)) {
                try {
                    const result = await executeViaCommandQueue(name, args || {});

                    // Screenshot returns image data
                    if (result.imageData) {
                        return {
                            jsonrpc: '2.0',
                            id,
                            result: {
                                content: [{
                                    type: 'image',
                                    data: result.imageData,
                                    mimeType: 'image/png'
                                }]
                            }
                        };
                    }

                    return {
                        jsonrpc: '2.0',
                        id,
                        result: {
                            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
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

            return {
                jsonrpc: '2.0',
                id,
                error: { code: -32602, message: `Unknown tool: ${name}` }
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
        attachedObject: armState.attachedObject,
        objects: armState.objects,
        jointLimits,
        pendingCommand: armState.pendingCommand
    });
});

// Browser posts command result after executing locally
app.post('/api/command-result', (req, res) => {
    const { commandId, ...result } = req.body;
    if (!commandId) {
        return res.status(400).json({ error: 'Missing commandId' });
    }

    armState.commandResult = { commandId, ...result };

    // Sync state updates from the browser
    if (result.jointTargets) {
        armState.jointTargets = result.jointTargets;
    }
    if (result.magnetOn !== undefined) {
        armState.magnetOn = result.magnetOn;
    }
    if (result.attachedObject !== undefined) {
        armState.attachedObject = result.attachedObject;
    }

    saveState();
    res.json({ success: true });
});

// Update object positions from browser (for persistence)
app.post('/api/objects', (req, res) => {
    const { objects } = req.body;
    if (Array.isArray(objects)) {
        objects.forEach(update => {
            const existing = armState.objects.find(o => o.id === update.id);
            if (existing) {
                existing.position = update.position;
            }
        });
        saveState();
    }
    res.json({ success: true });
});

// Motion status reporting from browser (kept for backward compat)
app.post('/api/motion-status', (req, res) => {
    res.json({ success: true });
});

// Attachment status reporting from browser
app.post('/api/attachment-status', (req, res) => {
    const { objectId, attached } = req.body;

    if (attached) {
        armState.attachedObject = objectId;
    } else if (armState.attachedObject === objectId) {
        armState.attachedObject = null;
    }

    saveState();
    res.json({ success: true });
});

app.post('/api/tools/:name', (req, res) => {
    const tool = mcpTools.find(t => t.name === req.params.name);
    if (!tool) {
        return res.status(404).json({ error: 'Tool not found' });
    }
    const syncResult = executeSyncTool(req.params.name, req.body);
    if (syncResult !== null) {
        return res.json(syncResult);
    }
    res.status(400).json({ error: 'Use MCP endpoint for async tools' });
});

app.get('/api/tools', (req, res) => {
    res.json({ tools: mcpTools });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', uiClients: uiClients.size, mcpSessions: mcpSessions.size });
});

// ============================================================================
// START SERVER
// ============================================================================

const PORT = process.env.PORT || 3000;

// Only start server when running directly (not imported by Vercel)
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
    app.listen(PORT, () => {
        console.log(`
🤖 Robo Demo Server v3.0 (client-side execution)

   Web UI:       http://localhost:${PORT}
   MCP Endpoint: http://localhost:${PORT}/mcp
`);
    });
}

export default app;
