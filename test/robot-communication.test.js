const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { after, before, test } = require('node:test');
const WebSocket = require('ws');

const controlToken = 'websocket-integration-test-token';
let serverProcess;
let baseUrl;
let controller;
let dashboard;

function waitForMessage(socket, predicate, description, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`Timed out waiting for ${description}.`));
    }, timeoutMs);

    function onMessage(raw) {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off('message', onMessage);
      resolve(message);
    }

    socket.on('message', onMessage);
  });
}

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

async function findAvailablePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`Server exited during startup with code ${serverProcess.exitCode}.`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return response.json();
    } catch (error) {
      if (error.name !== 'TypeError') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Server did not start on the configured PORT.');
}

function sendAndWaitForControllerMessage(message) {
  const response = waitForMessage(
    controller,
    (received) => received.command === message.command,
    `${message.command} command`,
  );
  dashboard.send(JSON.stringify(message));
  return response;
}

before(async () => {
  const port = await findAvailablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      SIMULATION_MODE: 'false',
      CONTROL_TOKEN: controlToken,
    },
    stdio: 'ignore',
  });
  await waitForServer();
});

after(async () => {
  for (const socket of [dashboard, controller]) {
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  }
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill();
    await new Promise((resolve) => serverProcess.once('exit', resolve));
  }
});

test('ESP32 /ws protocol forwards commands and stops on lost dashboard control', async () => {
  const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
  assert.deepEqual(health, { ok: true, mode: 'hardware', controllerConnected: false });

  controller = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws`);
  const startupRequest = waitForMessage(controller, (message) => message.command === 'status', 'ESP32 status request');
  await waitForOpen(controller);
  assert.deepEqual(await startupRequest, { command: 'status' });

  dashboard = new WebSocket(
    `${baseUrl.replace(/^http/, 'ws')}/ws?role=dashboard&token=${encodeURIComponent(controlToken)}`,
  );
  const initialState = waitForMessage(dashboard, (message) => message.type === 'server_status', 'dashboard server status');
  await waitForOpen(dashboard);
  assert.equal((await initialState).connected, false);

  const espStatus = { type: 'status', connected: true, speed: 70, obstacle: true, vacuum: false };
  const statusRelay = waitForMessage(dashboard, (message) => message.type === 'status', 'ESP32 status relay');
  controller.send(JSON.stringify(espStatus));
  assert.deepEqual(await statusRelay, espStatus);

  for (const command of [
    { command: 'speed', speed: 70 },
    { command: 'forward' },
    { command: 'backward' },
    { command: 'left' },
    { command: 'right' },
    { command: 'vacuum_on' },
    { command: 'vacuum_off' },
  ]) {
    assert.deepEqual(await sendAndWaitForControllerMessage(command), command);
  }

  const invalidSpeed = waitForMessage(dashboard, (message) => message.type === 'command_error', 'invalid speed rejection');
  dashboard.send(JSON.stringify({ command: 'speed', speed: 101 }));
  assert.match((await invalidSpeed).error, /invalid/i);

  const deadManStop = waitForMessage(controller, (message) => message.command === 'stop', '900 ms dead-man STOP', 2500);
  await deadManStop;

  await sendAndWaitForControllerMessage({ command: 'forward' });
  const disconnectStop = waitForMessage(controller, (message) => message.command === 'stop', 'dashboard disconnect STOP');
  dashboard.close();
  await disconnectStop;
});

test('dashboard WebSocket authentication rejects incorrect tokens', async () => {
  const unauthorized = new WebSocket(
    `${baseUrl.replace(/^http/, 'ws')}/ws?role=dashboard&token=incorrect-token`,
  );
  const authError = await waitForMessage(unauthorized, (message) => message.type === 'auth_error', 'token rejection');
  assert.match(authError.error, /token rejected/i);
  unauthorized.close();
});
