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
    attachedObject: null,
    objects: [
        { id: 'cube1', type: 'cube', position: { x: 0.4, y: 0.025, z: 0.3 }, size: 0.05, color: 'silver' },
        { id: 'cube2', type: 'cube', position: { x: -0.3, y: 0.025, z: 0.4 }, size: 0.04, color: 'gray' },
        { id: 'cylinder1', type: 'cylinder', position: { x: 0.25, y: 0.03, z: -0.35 }, size: 0.03, color: 'silver' }
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
// INVERSE KINEMATICS SOLVER
// ============================================================================

// Arm configuration (matches index.html)
const ARM_CONFIG = {
    baseHeight: 0.1,
    L1: 0.35,  // shoulder to elbow (segment 1)
    L2: 0.30,  // elbow to wrist (segment 2)
    L3: 0.35,  // wrist to end effector (0.15 + 0.12 + 0.08)
    reachRadius: 0.80,
    maxHeight: 0.95,
    minHeight: 0.05
};

function solveIK(targetPos, targetOrientation = 'vertical') {
    const { baseHeight, L1, L2, L3 } = ARM_CONFIG;

    // 1. Base rotation (joint 0) - rotate to face target in XZ plane
    const theta0 = Math.atan2(targetPos.x, targetPos.z);

    // 2. Project to 2D plane for arm reach
    const r = Math.sqrt(targetPos.x ** 2 + targetPos.z ** 2);
    const h = targetPos.y - baseHeight - L3; // Height for wrist position

    // 3. Two-link planar IK for joints 1,2
    const d = Math.sqrt(r ** 2 + h ** 2);
    if (d > L1 + L2 - 0.01) {
        return null; // Unreachable - too far
    }
    if (d < Math.abs(L1 - L2) + 0.01) {
        return null; // Unreachable - too close
    }

    // Law of cosines for elbow angle
    const cos_theta2 = (d ** 2 - L1 ** 2 - L2 ** 2) / (2 * L1 * L2);
    const clampedCos = Math.max(-1, Math.min(1, cos_theta2));
    const theta2 = -Math.acos(clampedCos); // Elbow up configuration

    // Angle to target and arm geometry
    const alpha = Math.atan2(h, r);
    const cos_beta = (L1 ** 2 + d ** 2 - L2 ** 2) / (2 * L1 * d);
    const clampedCosBeta = Math.max(-1, Math.min(1, cos_beta));
    const beta = Math.acos(clampedCosBeta);
    const theta1 = alpha + beta - Math.PI / 2;

    // 4. Wrist joints to keep end effector vertical
    const theta3 = 0; // Roll
    const theta4 = -(theta1 + theta2); // Pitch compensation
    const theta5 = -theta0; // Counter-rotate base rotation

    // Convert to degrees and clamp to joint limits
    const angles = [theta0, theta1, theta2, theta3, theta4, theta5].map((rad, i) => {
        const deg = rad * 180 / Math.PI;
        return Math.max(jointLimits[i][0], Math.min(jointLimits[i][1], deg));
    });

    return angles;
}

// ============================================================================
// TASK EXECUTION STATE
// ============================================================================

let currentTask = null;
let motionComplete = true;
let motionCompleteResolve = null;
let attachmentResolve = null;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForMotionComplete(timeoutMs = 10000) {
    if (motionComplete) return true;

    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            motionCompleteResolve = null;
            resolve(false);
        }, timeoutMs);

        motionCompleteResolve = () => {
            clearTimeout(timeout);
            motionCompleteResolve = null;
            resolve(true);
        };
    });
}

async function waitForAttachment(objectId, timeoutMs = 3000) {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            attachmentResolve = null;
            resolve(false);
        }, timeoutMs);

        attachmentResolve = (attachedId) => {
            clearTimeout(timeout);
            attachmentResolve = null;
            resolve(attachedId === objectId);
        };
    });
}

async function moveTo(position) {
    const angles = solveIK(position);
    if (!angles) {
        throw new Error('OUT_OF_REACH');
    }

    motionComplete = false;
    armState.jointTargets = angles;
    saveState();
    broadcastCommand({ type: 'set_pose', angles });

    await waitForMotionComplete();
    await sleep(100); // Small delay for stability
}

async function setMagnet(enabled) {
    armState.magnetOn = enabled;
    saveState();
    broadcastCommand({ type: 'set_magnet', enabled });
    await sleep(100);
}

// ============================================================================
// TASK EXECUTION FUNCTIONS
// ============================================================================

async function executePickObject(objectId) {
    const startTime = Date.now();

    // 1. Find object
    const obj = armState.objects.find(o => o.id === objectId);
    if (!obj) {
        return {
            success: false,
            message: `Object '${objectId}' not found`,
            error_code: 'OBJECT_NOT_FOUND',
            duration_ms: Date.now() - startTime
        };
    }

    // 2. Check if already holding something
    if (armState.magnetOn && armState.attachedObject) {
        return {
            success: false,
            message: `Already holding object '${armState.attachedObject}'`,
            error_code: 'ALREADY_HOLDING_OBJECT',
            duration_ms: Date.now() - startTime
        };
    }

    try {
        // 3. Compute positions
        const abovePos = { x: obj.position.x, y: 0.30, z: obj.position.z };
        const pickPos = { x: obj.position.x, y: obj.position.y + 0.12, z: obj.position.z };
        const liftPos = { x: obj.position.x, y: 0.35, z: obj.position.z };

        // 4. Execute sequence
        await moveTo(abovePos);
        await moveTo(pickPos);
        await setMagnet(true);

        // Wait for attachment
        const attached = await waitForAttachment(objectId, 2000);
        if (!attached) {
            // Try again - refresh object position from state
            await sleep(500);
        }

        await moveTo(liftPos);

        armState.attachedObject = objectId;
        saveState();

        return {
            success: true,
            message: `Successfully picked up '${objectId}'`,
            error_code: null,
            duration_ms: Date.now() - startTime
        };
    } catch (error) {
        return {
            success: false,
            message: error.message,
            error_code: error.message,
            duration_ms: Date.now() - startTime
        };
    }
}

async function executeCarryTo(x, y, z) {
    const startTime = Date.now();

    // Check if holding an object
    if (!armState.magnetOn || !armState.attachedObject) {
        return {
            success: false,
            message: 'Not holding any object',
            error_code: 'NO_OBJECT_HELD',
            duration_ms: Date.now() - startTime
        };
    }

    try {
        const targetPos = { x, y, z };
        await moveTo(targetPos);

        return {
            success: true,
            message: `Carried object to (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`,
            error_code: null,
            duration_ms: Date.now() - startTime
        };
    } catch (error) {
        return {
            success: false,
            message: error.message,
            error_code: error.message,
            duration_ms: Date.now() - startTime
        };
    }
}

async function executePlaceObject(params = {}) {
    const startTime = Date.now();

    // Check if holding an object
    if (!armState.magnetOn || !armState.attachedObject) {
        return {
            success: false,
            message: 'Not holding any object',
            error_code: 'NO_OBJECT_HELD',
            duration_ms: Date.now() - startTime
        };
    }

    const objectId = armState.attachedObject;

    try {
        // If position specified, move there first
        if (params.x !== undefined && params.y !== undefined && params.z !== undefined) {
            await moveTo({ x: params.x, y: params.y, z: params.z });
        }

        // Release the object
        await setMagnet(false);
        await sleep(500); // Let object fall

        armState.attachedObject = null;
        saveState();

        return {
            success: true,
            message: `Placed object '${objectId}'`,
            error_code: null,
            duration_ms: Date.now() - startTime
        };
    } catch (error) {
        return {
            success: false,
            message: error.message,
            error_code: error.message,
            duration_ms: Date.now() - startTime
        };
    }
}

async function executeDance(durationSeconds) {
    const startTime = Date.now();

    const danceFrames = [
        [0, 0, 0, 0, 0, 0],           // Home
        [45, 20, -30, 0, 10, 90],     // Wave right
        [-45, 20, -30, 0, 10, -90],   // Wave left
        [0, 45, -90, 45, 30, 0],      // Reach up
        [0, -10, 30, 0, -20, 180],    // Bow
        [90, 30, -60, 90, 0, 45],     // Pose 1
        [-90, 30, -60, -90, 0, -45],  // Pose 2
        [0, 0, 0, 0, 0, 0],           // Home
    ];

    const frameTime = (durationSeconds * 1000) / danceFrames.length;

    for (const frame of danceFrames) {
        motionComplete = false;
        armState.jointTargets = frame;
        saveState();
        broadcastCommand({ type: 'set_pose', angles: frame });

        await sleep(frameTime);
        await waitForMotionComplete(5000);
    }

    return {
        success: true,
        message: `Dance completed (${durationSeconds}s)`,
        error_code: null,
        duration_ms: Date.now() - startTime
    };
}

async function executeResetToBase() {
    const startTime = Date.now();

    // Turn off magnet if on
    if (armState.magnetOn) {
        await setMagnet(false);
        armState.attachedObject = null;
    }

    // Reset to home position
    const homeAngles = [0, 0, 0, 0, 0, 0];
    motionComplete = false;
    armState.jointTargets = homeAngles;
    saveState();
    broadcastCommand({ type: 'set_pose', angles: homeAngles });

    await waitForMotionComplete();

    return {
        success: true,
        message: 'Arm reset to home position',
        error_code: null,
        duration_ms: Date.now() - startTime
    };
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

function executeTool(name, args) {
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

        case 'take_screenshot':
            return 'SCREENSHOT_REQUEST';

        // Async task tools return promises
        case 'pick_object':
        case 'carry_to':
        case 'place_object':
        case 'dance':
        case 'reset_to_base':
            return 'ASYNC_TASK';

        default:
            return { success: false, error: `Unknown tool: ${name}` };
    }
}

async function executeAsyncTool(name, args) {
    switch (name) {
        case 'pick_object':
            return await executePickObject(args.object_id);
        case 'carry_to':
            return await executeCarryTo(args.x, args.y, args.z);
        case 'place_object':
            return await executePlaceObject(args);
        case 'dance':
            return await executeDance(args.duration_seconds || 5);
        case 'reset_to_base':
            return await executeResetToBase();
        default:
            return { success: false, error: `Unknown async tool: ${name}` };
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

            // Handle async task tools
            if (result === 'ASYNC_TASK') {
                try {
                    const asyncResult = await executeAsyncTool(name, args || {});
                    return {
                        jsonrpc: '2.0',
                        id,
                        result: {
                            content: [{ type: 'text', text: JSON.stringify(asyncResult, null, 2) }]
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
        // Merge position updates while preserving type/size/color info
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

// Motion status reporting from browser
app.post('/api/motion-status', (req, res) => {
    const { complete, jointAngles } = req.body;
    motionComplete = complete;

    if (complete && motionCompleteResolve) {
        motionCompleteResolve();
    }

    res.json({ success: true });
});

// Attachment status reporting from browser
app.post('/api/attachment-status', (req, res) => {
    const { objectId, attached } = req.body;

    if (attached) {
        armState.attachedObject = objectId;
        if (attachmentResolve) {
            attachmentResolve(objectId);
        }
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

// Only start server when running directly (not imported by Vercel)
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
    app.listen(PORT, () => {
        console.log(`
🤖 Robo Demo Server v2.0

   Web UI:       http://localhost:${PORT}
   MCP Endpoint: http://localhost:${PORT}/mcp
`);
    });
}

export default app;
