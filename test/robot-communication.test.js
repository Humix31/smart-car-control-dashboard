const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { io: createSocket } = require('socket.io-client');
const WebSocket = require('ws');
const { io, server, state } = require('../server');

let baseUrl;

function waitForEvent(emitter, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    emitter.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

function nextRobotMessage(robot, predicate = () => true, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      robot.off('message', handleMessage);
      reject(new Error('Timed out waiting for a robot command'));
    }, timeoutMs);
    function handleMessage(raw) {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      clearTimeout(timer);
      robot.off('message', handleMessage);
      resolve(message);
    }
    robot.on('message', handleMessage);
  });
}

function emitWithAck(socket, event, ...args) {
  return new Promise((resolve, reject) => {
    socket.timeout(3000).emit(event, ...args, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

async function waitForControllerDisconnect() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
    if (!health.controllerConnected) return health;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Backend did not report the robot WebSocket disconnect.');
}

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => io.close(resolve));
});

test('auth-free Socket.IO dashboard commands are forwarded as raw ESP32 WebSocket JSON', async () => {
  const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
  assert.deepEqual(health, { ok: true, mode: 'hardware', controllerConnected: false });

  const dashboard = createSocket(baseUrl, {
    autoConnect: false,
    reconnection: false,
    transports: ['websocket'],
  });
  try {
    const dashboardConnected = waitForEvent(dashboard, 'connect');
    dashboard.connect();
    await dashboardConnected;
    assert.equal(dashboard.io.engine.transport.name, 'websocket');
    assert.deepEqual(await emitWithAck(dashboard, 'vehicle:connect'), { connected: false, mode: 'hardware' });

    const robotUrl = baseUrl.replace(/^http/, 'ws');
    const robot = new WebSocket(`${robotUrl}/robot`);
    try {
      const connectionStop = nextRobotMessage(robot);
      await waitForEvent(robot, 'open');
      assert.deepEqual(await connectionStop, { type: 'stop' });
      assert.equal((await fetch(`${baseUrl}/health`).then((response) => response.json())).controllerConnected, true);
      const connectedStatus = waitForEvent(dashboard, 'vehicle:status', 1000);
      await emitWithAck(dashboard, 'vehicle:connect');
      assert.equal((await connectedStatus)[0].connected, true);

      const invalid = await emitWithAck(dashboard, 'vehicle:command', {
        type: 'move', x: 0, y: 100, speed: 256,
      });
      assert.equal(invalid.ok, false);

      const movement = { type: 'move', x: 34, y: 82, speed: 173 };
      const forwardedMovement = nextRobotMessage(robot, (message) => message.type === 'move');
      assert.deepEqual(await emitWithAck(dashboard, 'vehicle:command', movement), { ok: true });
      assert.deepEqual(await forwardedMovement, movement);

      const telemetryUpdate = waitForEvent(dashboard, 'vehicle:status');
      robot.send(JSON.stringify({
        type: 'telemetry',
        distanceCm: 21.5,
        obstacleDetected: true,
        motorStatus: 'forward',
        currentSpeed: 68,
      }));
      const [status] = await telemetryUpdate;
      assert.equal(status.telemetry.distanceCm, 21.5);
      assert.equal(status.telemetry.obstacleDetected, true);
      assert.equal(status.telemetry.motorStatus, 'forward');
      assert.equal(status.telemetry.currentSpeed, 68);

      const deadmanStop = nextRobotMessage(robot, (message) => message.type === 'stop', 1500);
      assert.deepEqual(await deadmanStop, { type: 'stop' });
      assert.equal(state.direction, 'stop');

      const explicitMovement = nextRobotMessage(robot, (message) => message.type === 'move');
      await emitWithAck(dashboard, 'vehicle:command', { type: 'move', x: -100, y: 0, speed: 100 });
      assert.deepEqual(await explicitMovement, { type: 'move', x: -100, y: 0, speed: 100 });
      const explicitStop = nextRobotMessage(robot, (message) => message.type === 'stop');
      dashboard.emit('vehicle:stop');
      assert.deepEqual(await explicitStop, { type: 'stop' });

      const emergencyStop = nextRobotMessage(robot, (message) => message.type === 'stop');
      dashboard.emit('vehicle:emergency-stop');
      assert.deepEqual(await emergencyStop, { type: 'stop' });
      assert.equal(state.emergencyStopped, true);
      assert.equal((await emitWithAck(dashboard, 'vehicle:command', {
        type: 'move', x: 0, y: 100, speed: 100,
      })).ok, false);
      assert.equal((await emitWithAck(dashboard, 'vehicle:reset-emergency-stop', { confirmed: true })).ok, true);

      const movementBeforeDisconnect = nextRobotMessage(robot, (message) => message.type === 'move');
      await emitWithAck(dashboard, 'vehicle:command', { type: 'move', x: 0, y: 100, speed: 100 });
      await movementBeforeDisconnect;
      const dashboardDisconnectStop = nextRobotMessage(robot, (message) => message.type === 'stop');
      dashboard.disconnect();
      assert.deepEqual(await dashboardDisconnectStop, { type: 'stop' });

      const robotClosed = waitForEvent(robot, 'close');
      robot.close();
      await robotClosed;
      assert.equal((await waitForControllerDisconnect()).controllerConnected, false);
      assert.equal(state.telemetry.distanceCm, null);
    } finally {
      if (robot.readyState === WebSocket.OPEN || robot.readyState === WebSocket.CONNECTING) robot.close();
    }
  } finally {
    dashboard.disconnect();
  }
});
