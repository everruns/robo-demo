# Task-Based Robotic Arm Controller System - Implementation Plan

## Overview

Redesign the MCP interface from low-level joint commands to high-level task-based operations. The new system will expose semantic tasks like "pick object X", "carry to location", "place at position", with proper error handling and realistic execution.

## Current Architecture (Reference)

- **server.js**: Express server with MCP protocol, SSE to browser, state persistence
- **index.html**: Three.js + Rapier physics simulation in browser
- **Communication**: MCP → server.js → SSE → browser
- **Motion**: Joint targets updated, smooth interpolation at 2.0 rad/s
- **No IK**: Currently forward kinematics only (must specify joint angles)

## New MCP Tools Design

### Discovery Tools (Read-Only)

| Tool | Description | Returns |
|------|-------------|---------|
| `take_screenshot` | Capture current scene | Base64 PNG image |
| `discover_objects` | List all metallic objects | Array of `{id, type, position, size, attached}` |
| `get_environment_info` | System description | Coordinate system, arm specs, workspace bounds |

### Task Execution Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `pick_object` | `object_id: string` | Move arm to object, pick it up with magnet |
| `carry_to` | `x, y, z: number` | Move currently held object to position |
| `place_object` | `x?, y?, z?: number` | Release object at current or specified position |
| `dance` | `duration_seconds: number` | Fun dance animation |
| `reset_to_base` | (none) | Return arm to home position |

### Return Format

All task tools return:
```json
{
  "success": boolean,
  "message": string,
  "error_code": string | null,  // e.g. "OBJECT_NOT_FOUND", "OUT_OF_REACH"
  "duration_ms": number
}
```

## Key Implementation Challenges

### 1. Inverse Kinematics (IK)
**Problem**: Current system only has forward kinematics (joint angles → position). Tasks need position → joint angles.

**Solution**: Implement simple analytical IK for 6-DOF arm:
- Compute base rotation (joint 0) from XZ angle to target
- Compute shoulder/elbow (joints 1,2) using 2-link planar IK
- Compute wrist orientation (joints 3,4,5) for vertical end-effector

### 2. Task Execution Flow
**Problem**: Tasks take time; MCP calls should block until complete.

**Solution**:
- Server tracks task state: `{ taskId, status: 'running'|'completed'|'failed', progress }`
- Browser sends progress updates via POST `/api/task-progress`
- MCP tool waits for completion before returning

### 3. Motion Sequencing
**Problem**: "Pick object" requires multiple steps: move above → move down → enable magnet → move up.

**Solution**: Define task as sequence of waypoints with conditions:
```javascript
pickSequence = [
  { position: aboveObject, waitFor: 'reached' },
  { position: atObject, waitFor: 'reached' },
  { action: 'magnet_on', waitFor: 'attached' },
  { position: liftHeight, waitFor: 'reached' }
]
```

### 4. Error Detection
- **Object not found**: Check `discover_objects()` before pick
- **Out of reach**: IK solver returns null if unreachable
- **Pick failed**: Magnet on but object not attached after timeout
- **Collision**: (Future) Arm hitting obstacles

## File Changes

### server.js (Major Changes)

1. **New tool definitions** - Replace low-level tools with task-based tools
2. **IK solver** - Server-side inverse kinematics function
3. **Task executor** - State machine for multi-step tasks
4. **Progress tracking** - Wait for browser confirmation
5. **Discovery endpoints** - Object and environment queries

### index.html (Moderate Changes)

1. **Task progress reporting** - Send status updates to server
2. **Motion completion detection** - Detect when joints reach targets
3. **Attachment detection** - Report when object successfully attaches
4. **Dance animation** - Predefined joint choreography

## Detailed Implementation

### Phase 1: IK Solver (server.js)

```javascript
function solveIK(targetPos, targetOrientation = 'vertical') {
  // Arm configuration
  const baseHeight = 0.15;
  const L1 = 0.35; // shoulder to elbow
  const L2 = 0.30; // elbow to wrist
  const L3 = 0.35; // wrist to end effector (0.15 + 0.12 + 0.08)

  // 1. Base rotation (joint 0)
  const theta0 = Math.atan2(targetPos.x, targetPos.z);

  // 2. Project to 2D plane for arm reach
  const r = Math.sqrt(targetPos.x**2 + targetPos.z**2);
  const h = targetPos.y - baseHeight - L3; // Height for wrist

  // 3. Two-link planar IK for joints 1,2
  const d = Math.sqrt(r**2 + h**2);
  if (d > L1 + L2) return null; // Unreachable

  const cos_theta2 = (d**2 - L1**2 - L2**2) / (2 * L1 * L2);
  const theta2 = -Math.acos(cos_theta2); // Elbow up

  const alpha = Math.atan2(h, r);
  const beta = Math.acos((L1**2 + d**2 - L2**2) / (2 * L1 * d));
  const theta1 = alpha + beta - Math.PI/2;

  // 4. Wrist keeps end effector vertical
  const theta3 = 0; // Roll
  const theta4 = -(theta1 + theta2); // Pitch compensation
  const theta5 = -theta0; // Counter-rotate base

  return [theta0, theta1, theta2, theta3, theta4, theta5].map(rad => rad * 180 / Math.PI);
}
```

### Phase 2: Task State Machine (server.js)

```javascript
let currentTask = null;

async function executeTask(taskType, params) {
  const taskId = randomUUID();
  currentTask = { id: taskId, type: taskType, status: 'running', startTime: Date.now() };

  try {
    switch (taskType) {
      case 'pick_object':
        return await executePickObject(params.object_id);
      case 'carry_to':
        return await executeCarryTo(params.x, params.y, params.z);
      case 'place_object':
        return await executePlaceObject(params);
      case 'dance':
        return await executeDance(params.duration_seconds);
      case 'reset_to_base':
        return await executeReset();
    }
  } finally {
    currentTask = null;
  }
}

async function executePickObject(objectId) {
  // 1. Find object
  const obj = armState.objects.find(o => o.id === objectId);
  if (!obj) return { success: false, error_code: 'OBJECT_NOT_FOUND' };

  // 2. Check if already holding something
  if (armState.magnetOn && armState.attachedObject) {
    return { success: false, error_code: 'ALREADY_HOLDING_OBJECT' };
  }

  // 3. Compute positions
  const abovePos = { x: obj.position.x, y: 0.25, z: obj.position.z };
  const pickPos = { x: obj.position.x, y: obj.position.y + 0.08, z: obj.position.z };
  const liftPos = { x: obj.position.x, y: 0.30, z: obj.position.z };

  // 4. Execute sequence
  await moveTo(abovePos);
  await moveTo(pickPos);
  await setMagnet(true);
  await waitForAttachment(objectId, 2000);
  await moveTo(liftPos);

  return { success: true, message: `Picked up ${objectId}` };
}
```

### Phase 3: Motion Completion (index.html)

```javascript
function checkMotionComplete() {
  const tolerance = 1.0; // degrees
  for (let i = 0; i < 6; i++) {
    if (Math.abs(jointTargets[i] - jointAngles[i]) > tolerance) {
      return false;
    }
  }
  return true;
}

// Report to server when motion completes
let lastMotionState = true;
function reportMotionStatus() {
  const complete = checkMotionComplete();
  if (complete !== lastMotionState) {
    lastMotionState = complete;
    fetch(`${API_BASE}/api/motion-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ complete, jointAngles })
    });
  }
}
```

### Phase 4: Discovery Tools

```javascript
// get_environment_info response
{
  coordinate_system: {
    type: "right-handed",
    units: "meters",
    origin: "base of robot arm",
    x_axis: "right (positive)",
    y_axis: "up (positive)",
    z_axis: "forward (positive)"
  },
  arm: {
    type: "6-DOF serial manipulator",
    reach_radius: 0.80,  // meters
    max_height: 0.95,
    min_height: 0.05,
    end_effector: "electromagnetic magnet (radius 0.05m)"
  },
  workspace: {
    floor_height: 0,
    bounds: { x: [-1, 1], y: [0, 1], z: [-1, 1] }
  },
  objects: "Use discover_objects tool to get current object positions"
}

// discover_objects response
[
  { id: "cube1", type: "cube", position: {x, y, z}, size: 0.05, color: "silver", attached: false },
  { id: "cube2", type: "cube", position: {x, y, z}, size: 0.04, color: "gray", attached: false },
  { id: "cylinder1", type: "cylinder", position: {x, y, z}, size: 0.03, color: "silver", attached: true }
]
```

### Phase 5: Dance Animation

```javascript
async function executeDance(durationSeconds) {
  const danceFrames = [
    [0, 0, 0, 0, 0, 0],      // Home
    [45, 20, -30, 0, 0, 90],  // Wave right
    [-45, 20, -30, 0, 0, -90], // Wave left
    [0, 45, -90, 45, 30, 0],  // Reach up
    [0, -20, 45, 0, -30, 180], // Bow
    [90, 30, -60, 90, 0, 45],  // Pose 1
    [-90, 30, -60, -90, 0, -45], // Pose 2
  ];

  const frameTime = (durationSeconds * 1000) / danceFrames.length;

  for (const frame of danceFrames) {
    broadcastCommand({ type: 'set_pose', angles: frame });
    await sleep(frameTime);
    await waitForMotionComplete();
  }

  // Return to home
  broadcastCommand({ type: 'set_pose', angles: [0, 0, 0, 0, 0, 0] });
  await waitForMotionComplete();

  return { success: true, message: `Dance completed (${durationSeconds}s)` };
}
```

## Verification Plan

1. **Unit test IK solver**: Known positions → joint angles → verify forward kinematics matches
2. **Test discovery tools**: `discover_objects` returns correct positions from state
3. **Test pick sequence**:
   - Call `pick_object("cube1")`
   - Verify arm moves to object
   - Verify magnet activates
   - Verify object attaches
   - Verify arm lifts
4. **Test carry**: With object held, `carry_to(0, 0.3, 0)` moves to position
5. **Test place**: `place_object()` releases object, falls to ground
6. **Test error cases**:
   - `pick_object("nonexistent")` → OBJECT_NOT_FOUND
   - `pick_object("cube1")` when already holding → ALREADY_HOLDING_OBJECT
   - `carry_to(5, 0, 0)` → OUT_OF_REACH
7. **Test dance**: Visual verification of smooth animation
8. **Test reset**: All joints return to 0

## Files to Modify

| File | Changes |
|------|---------|
| `server.js` | IK solver, task executor, new MCP tools, progress tracking |
| `public/index.html` | Motion completion reporting, attachment detection |

## Implementation Order

1. Add IK solver to server.js
2. Add discovery tools (`discover_objects`, `get_environment_info`)
3. Add motion completion reporting to browser
4. Implement `pick_object` task
5. Implement `carry_to` task
6. Implement `place_object` task
7. Implement `dance` task
8. Implement `reset_to_base` task
9. Remove old low-level tools (or keep as internal)
10. Test full workflow: discover → pick → carry → place
