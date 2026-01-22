# Robo Demo 🤖

A 6-DOF robotic arm simulation with an MCP (Model Context Protocol) server interface using HTTP/SSE streaming.

## Features

- **3D Visualization**: Real-time Three.js rendering in browser
- **6-DOF Arm**: Base rotation, shoulder, elbow, and 3-axis wrist control
- **Gripper Control**: Open/close gripper mechanism
- **Inverse Kinematics**: Move to target positions automatically
- **MCP Server**: HTTP/SSE transport - single service, no separate process needed
- **Real-time Sync**: SSE broadcasts state changes to all connected clients
- **Built-in Inspector**: Test MCP tools directly in the browser

## Quick Start

```bash
npm install
npm run dev
```

Open http://localhost:3000 - you'll see the 3D arm simulation with controls.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Browser UI                              │
│  ┌─────────────────────┐  ┌───────────────────────────────┐ │
│  │   3D Visualization  │  │      MCP Inspector            │ │
│  │   (Three.js)        │  │   - Test tools via JSON-RPC   │ │
│  │   - Manual controls │  │   - View responses            │ │
│  └─────────────────────┘  └───────────────────────────────┘ │
│              │                         │                     │
│              ▼                         ▼                     │
│         /api/events (SSE)         /mcp (POST)               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     Express Server                           │
│                                                              │
│  Endpoints:                                                  │
│  ├── GET  /              - Web UI                           │
│  ├── GET  /mcp           - SSE stream (MCP session)         │
│  ├── POST /mcp           - MCP JSON-RPC messages            │
│  ├── GET  /api/events    - SSE for UI state updates         │
│  ├── GET  /api/state     - Current arm state                │
│  ├── POST /api/tools/:n  - REST API for tools               │
│  └── GET  /health        - Health check                     │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐│
│  │                    Arm State                             ││
│  │  - Joint angles [6]                                      ││
│  │  - Gripper openness                                      ││
│  │  - Forward/Inverse Kinematics                            ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `move_joint` | Start moving a joint (0-5) to target angle (animated) |
| `move_to_position` | Start moving end effector to x,y,z using IK (animated) |
| `set_gripper` | Start moving gripper to openness 0-100% (animated) |
| `set_pose` | Start moving all 6 joints to target angles (animated) |
| `reset_arm` | Start moving to home position (all 0°, gripper 50%) |
| `stop` | Emergency stop - halt all movement immediately |
| `get_arm_state` | Get current & target angles, movement status, end effector position |
| `take_screenshot` | Capture PNG screenshot of the 3D scene (returns MCP image block) |

### Animated Movement

All movement commands (`move_joint`, `move_to_position`, `set_gripper`, `set_pose`, `reset_arm`) are **animated** - they simulate realistic servo motor behavior:

- Commands set a **target** position and return immediately
- The arm moves toward the target at realistic speeds (configurable per joint)
- State updates are broadcast via SSE while moving
- Use `get_arm_state` to check `isMoving` status and current position
- Use `stop` to halt movement at current position

```javascript
// State includes both current and target:
{
  "jointAngles": [0, 23.5, 0, 0, 0, 0],      // Current position
  "targetAngles": [0, 45, 0, 0, 0, 0],       // Where it's going
  "isMoving": true,                           // Still in motion
  "gripperOpenness": 50,
  "targetGripperOpenness": 50,
  "endEffector": { "x": 0, "y": 1.07, "z": 0.33 }
}
```

## API Usage

### MCP Protocol (JSON-RPC over HTTP)

```bash
# Initialize session
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

# List tools
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# Call a tool
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"move_joint","arguments":{"joint":1,"angle":45}}}'

# Take a screenshot (requires browser UI to be open)
# Returns an MCP image block with base64 PNG data
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"take_screenshot","arguments":{"width":800,"height":600}}}'
```

### REST API (simpler, for direct use)

```bash
# Get state
curl http://localhost:3000/api/state

# Move joint
curl -X POST http://localhost:3000/api/tools/move_joint \
  -H "Content-Type: application/json" \
  -d '{"joint":1,"angle":45}'

# Move to position (IK)
curl -X POST http://localhost:3000/api/tools/move_to_position \
  -H "Content-Type: application/json" \
  -d '{"x":0.3,"y":0.5,"z":0.2}'

# Set gripper
curl -X POST http://localhost:3000/api/tools/set_gripper \
  -H "Content-Type: application/json" \
  -d '{"openness":20}'
```

### SSE Stream (real-time updates)

```javascript
const events = new EventSource('http://localhost:3000/api/events');
events.onmessage = (e) => {
  const data = JSON.parse(e.data);
  console.log('State update:', data);
};
```

## Joint Configuration

| Joint | Axis | Range | Description |
|-------|------|-------|-------------|
| 0 | Y | ±180° | Base rotation |
| 1 | Z | ±90° | Shoulder |
| 2 | Z | ±135° | Elbow |
| 3 | X | ±180° | Wrist roll |
| 4 | Z | ±90° | Wrist pitch |
| 5 | X | ±180° | Wrist rotation |

## Using MCP Inspector

The official [MCP Inspector](https://github.com/modelcontextprotocol/inspector) can connect to robo-demo for interactive testing.

### Quick Start with npx

```bash
# Start robo-demo first
npm run dev

# In another terminal, run MCP Inspector with SSE transport
npx @modelcontextprotocol/inspector --url http://localhost:3000/mcp
```

This opens the Inspector UI at http://localhost:6274 where you can:
- View all available tools and their schemas
- Execute tools interactively with a form UI
- See real-time responses
- Monitor the MCP protocol messages

### Example Session

1. **Connect**: Inspector auto-connects to `http://localhost:3000/mcp`

2. **List Tools**: Click "Tools" tab to see:
   - `move_joint` - Move individual joints
   - `move_to_position` - IK to xyz coordinates
   - `set_gripper` - Control gripper
   - `get_arm_state` - Read current state
   - `reset_arm` - Return to home
   - `set_pose` - Set all joints

3. **Execute a Tool**:
   - Select `move_joint`
   - Enter: `joint: 1`, `angle: 45`
   - Click "Run"
   - Watch the 3D visualization update at http://localhost:3000!

4. **Try IK Movement**:
   - Select `move_to_position`
   - Enter: `x: 0.3`, `y: 0.5`, `z: 0.2`
   - The arm calculates joint angles automatically

### Inspector with Docker

```bash
docker run -it --rm --network host \
  mcp/inspector --url http://localhost:3000/mcp
```

## MCP Client Configuration

For MCP clients that support HTTP/SSE transport (like Claude Desktop with remote servers):

```json
{
  "mcpServers": {
    "robo-demo": {
      "transport": "sse",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

## Development

```bash
# Run with auto-reload
npx nodemon server.js
```
