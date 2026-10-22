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

function waitForStatus(socket, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('vehicle:status', handleStatus);
      reject(new Error('Timed out waiting for matching vehicle status'));
    }, timeoutMs);
    function handleStatus(status) {
      if (!predicate(status)) return;
      clearTimeout(timer);
      socket.off('vehicle:status', handleStatus);
      resolve(status);
    }
    socket.on('vehicle:status', handleStatus);
  });
}

function nextRobotMessage(robot, predicate = () => true, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      robot.off('message', handleMessage);
      reject(new Error(`Timed out waiting for a robot command matching ${predicate.toString()}`));
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

test('dashboard commands and telemetry use the documented /robot vector protocol', async () => {
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
      assert.equal((await fetch(`${baseUrl}/health`).then((response) => response.json())).controllerConnected, false);
      const telemetryUpdate = waitForStatus(dashboard, (status) => status.connected && status.telemetry.distanceCm === 21.5);
      robot.send(JSON.stringify({
        type: 'telemetry',
        distanceCm: 21.5,
        obstacleDetected: true,
        motorStatus: 'forward',
        currentSpeed: 68,
      }));
      const status = await telemetryUpdate;
      assert.equal(status.connected, true);
      assert.equal(status.telemetry.distanceCm, 21.5);
      assert.equal(status.telemetry.obstacleDetected, true);
      assert.equal(status.telemetry.motorStatus, 'forward');
      assert.equal(status.telemetry.currentSpeed, 68);
      const connectedStatus = waitForStatus(dashboard, (status) => status.connected, 1000);
      await emitWithAck(dashboard, 'vehicle:connect');
      assert.equal((await connectedStatus).connected, true);
      assert.equal((await fetch(`${baseUrl}/health`).then((response) => response.json())).controllerConnected, true);

      const invalid = await emitWithAck(dashboard, 'vehicle:command', {
        type: 'move', x: 0, y: 100, speed: 256,
      });
      assert.equal(invalid.ok, false);
      assert.deepEqual(await emitWithAck(dashboard, 'vehicle:vacuum', 'vacuum_on'), {
        ok: false,
        error: 'The connected firmware protocol does not support vacuum commands.',
      });

      const movement = { type: 'move', x: 34, y: 82, speed: 173 };
      const forwardedMovement = nextRobotMessage(robot, (message) => message.type === 'move');
      assert.deepEqual(await emitWithAck(dashboard, 'vehicle:command', movement), { ok: true });
      assert.deepEqual(await forwardedMovement, movement);

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

test('the /ws command/status protocol reports genuine status and forwards controls', async () => {
  const dashboard = createSocket(baseUrl, {
    autoConnect: false,
    reconnection: false,
    transports: ['websocket'],
  });
  const robot = new WebSocket(baseUrl.replace(/^http/, 'ws') + '/ws');
  try {
    const initialStop = nextRobotMessage(robot, (message) => message.command === 'stop');
    const statusRequest = nextRobotMessage(robot, (message) => message.command === 'status');
    await waitForEvent(robot, 'open');
    assert.deepEqual(await initialStop, { command: 'stop' });
    assert.deepEqual(await statusRequest, { command: 'status' });

    const dashboardConnected = waitForEvent(dashboard, 'connect');
    dashboard.connect();
    await dashboardConnected;
    await emitWithAck(dashboard, 'vehicle:connect');
    assert.equal((await fetch(`${baseUrl}/health`).then((response) => response.json())).controllerConnected, false);

    const onlineStatus = waitForStatus(dashboard, (status) => status.connected && status.telemetry.obstacleDetected === true);
    robot.send(JSON.stringify({
      type: 'status',
      connected: true,
      speed: 70,
      obstacle: true,
      distanceCm: 16.1,
      vacuum: false,
    }));
    const online = await onlineStatus;
    assert.equal(online.connected, true);
    assert.equal(online.speed, 70);
    assert.equal(online.telemetry.obstacleDetected, true);
    assert.equal(online.telemetry.distanceCm, 16.1);
    assert.equal(online.vacuum, false);
    assert.equal((await fetch(`${baseUrl}/health`).then((response) => response.json())).controllerConnected, true);

    const speedMessage = nextRobotMessage(robot, (message) => message.command === 'speed');
    assert.deepEqual(await emitWithAck(dashboard, 'vehicle:speed', 55), { ok: true });
    assert.deepEqual(await speedMessage, { command: 'speed', speed: 55 });

    const moveMessage = nextRobotMessage(robot, (message) => message.command === 'forward');
    assert.deepEqual(await emitWithAck(dashboard, 'vehicle:command', {
      type: 'move', x: 0, y: 100, speed: 158,
    }), { ok: true });
    assert.deepEqual(await moveMessage, { command: 'forward', speed: 62 });

    const slowMoveMessage = nextRobotMessage(robot, (message) => message.command === 'forward');
    assert.deepEqual(await emitWithAck(dashboard, 'vehicle:command', {
      type: 'move', x: 0, y: 100, speed: 102,
    }), { ok: true });
    assert.deepEqual(await slowMoveMessage, { command: 'forward', speed: 40 });

    const obstacleStatus = waitForStatus(dashboard, (status) => status.telemetry.obstacleDetected === true);
    robot.send(JSON.stringify({ type: 'status', connected: true, speed: 62, obstacle: true, vacuum: false }));
    await obstacleStatus;
    assert.equal(state.direction, 'move');

    const vacuumMessage = nextRobotMessage(robot, (message) => message.command === 'vacuum_on');
    assert.deepEqual(await emitWithAck(dashboard, 'vehicle:vacuum', 'vacuum_on'), { ok: true });
    assert.deepEqual(await vacuumMessage, { command: 'vacuum_on' });
    const vacuumOffMessage = nextRobotMessage(robot, (message) => message.command === 'vacuum_off');
    assert.deepEqual(await emitWithAck(dashboard, 'vehicle:vacuum', 'vacuum_off'), { ok: true });
    assert.deepEqual(await vacuumOffMessage, { command: 'vacuum_off' });

    const stopMessage = nextRobotMessage(robot, (message) => message.command === 'stop');
    dashboard.emit('vehicle:stop');
    assert.deepEqual(await stopMessage, { command: 'stop' });

    const backwardMessage = nextRobotMessage(robot, (message) => message.command === 'backward');
    assert.deepEqual(await emitWithAck(dashboard, 'vehicle:command', {
      type: 'move', x: 0, y: -100, speed: 158,
    }), { ok: true });
    assert.deepEqual(await backwardMessage, { command: 'backward', speed: 62 });

    const safetyStop = nextRobotMessage(robot, (message) => message.command === 'stop');
    const disconnectedStatus = waitForStatus(dashboard, (status) => !status.connected && status.telemetry.obstacleDetected === false);
    robot.send(JSON.stringify({ type: 'status', connected: false, speed: 0, obstacle: false, vacuum: false }));
    const offline = await disconnectedStatus;
    assert.deepEqual(await safetyStop, { command: 'stop' });
    assert.equal(offline.connected, false);
    assert.equal(offline.telemetry.obstacleDetected, false);
    assert.equal(offline.vacuum, false);
    assert.equal((await fetch(`${baseUrl}/health`).then((response) => response.json())).controllerConnected, false);
  } finally {
    dashboard.disconnect();
    if (robot.readyState === WebSocket.OPEN || robot.readyState === WebSocket.CONNECTING) robot.close();
  }
});
