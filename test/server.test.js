import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

test('serves the UI and robot API and rejects malformed JSON', async (t) => {
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const { port } = reservation.address();
    await new Promise((resolve) => reservation.close(resolve));

    const server = spawn(process.execPath, ['server.js'], {
        cwd: new URL('..', import.meta.url),
        env: { ...process.env, PORT: String(port) },
        stdio: 'ignore',
    });
    t.after(async () => {
        if (server.exitCode === null) {
            server.kill();
            await once(server, 'exit');
        }
    });

    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
        try {
            ready = (await fetch(`${base}/health`)).ok;
            if (ready) break;
        } catch {
            // The child has not bound its listener yet.
        }
        if (server.exitCode !== null) break;
        await delay(50);
    }
    assert.ok(ready, 'server starts with the updated HTTP dependencies');

    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.status, 'ok');
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /robot/i);
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.jointTargets.length, 6);
    const tools = await (await fetch(`${base}/api/tools`)).json();
    assert.ok(tools.tools.length > 0);

    const malformed = await fetch(`${base}/api/objects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
    });
    assert.equal(malformed.status, 400);
    assert.equal((await fetch(`${base}/health`)).status, 200);
});
