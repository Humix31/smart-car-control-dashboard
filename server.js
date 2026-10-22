const http = require('node:http');
const path = require('node:path');
require('dotenv').config();
const express = require('express');
const { Server } = require('socket.io');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { serveClient: false });
const port = Number(process.env.PORT || 3000);
const cameraSource = process.env.CAMERA_STREAM_URL || '';
const cameraRoom = 'vehicle-camera';
const stopTimeoutMs = 500;
const controllerPingIntervalMs = 25000;
const robotSockets = new Set();
const dashboardSockets = new Set();
const state = {
  connected: false,
  mode: 'hardware',
  emergencyStopped: false,
  direction: 'stop',
  speed: 0,
  vacuum: null,
  cameraConnected: false,
  telemetry: {
    batteryPercentage: null,
    batteryVoltage: null,
    currentSpeed: null,
    motorStatus: 'N/A',
    wifiSignal: null,
    distanceCm: null,
    obstacleDetected: null,
    latencyMs: null,
    receivedAt: null,
  },
};

function log(event, details = {}) {
  console.info(JSON.stringify({ time: new Date().toISOString(), event, ...details }));
}

function broadcastStatus() {
  const controllerProtocol = [...robotSockets].some((socket) => socket.controllerProtocol === 'command-json')
    ? 'command-json'
    : robotSockets.size ? 'move-json' : null;
  io.emit('vehicle:status', { ...state, controllerProtocol, telemetry: { ...state.telemetry } });
}

function sendControllerStop(socket) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  const message = socket.controllerProtocol === 'command-json'
    ? { command: 'stop' }
    : { type: 'stop' };
  socket.send(JSON.stringify(message), (error) => {
    if (error) log('controller.send-error', { message: error.message });
  });
  return true;
}

function sendMovement(command) {
  const percentSpeed = Math.round(command.speed / 2.55);
  const direction = Math.abs(command.x) > Math.abs(command.y)
    ? (command.x > 0 ? 'right' : 'left')
    : (command.y > 0 ? 'forward' : 'backward');

  for (const socket of robotSockets) {
    if (socket.readyState !== WebSocket.OPEN) continue;
    if (socket.controllerProtocol === 'command-json') {
      if (socket.selectedSpeed !== percentSpeed) {
        const speedMessage = JSON.stringify({ command: 'speed', speed: percentSpeed });
        socket.send(speedMessage, (error) => {
          if (error) log('controller.send-error', { message: error.message });
        });
        socket.selectedSpeed = percentSpeed;
      }
      const directionMessage = JSON.stringify({ command: direction });
      socket.send(directionMessage, (error) => {
        if (error) log('controller.send-error', { message: error.message });
      });
      continue;
    }
    const movementMessage = JSON.stringify(command);
    socket.send(movementMessage, (error) => {
      if (error) log('controller.send-error', { message: error.message });
    });
  }
}

function stopVehicle(reason, { force = false } = {}) {
  const wasMoving = state.direction !== 'stop' || [...dashboardSockets].some((socket) => socket.data.lastMovementAt);
  state.direction = 'stop';
  state.speed = 0;
  for (const socket of dashboardSockets) {
    delete socket.data.lastMovementAt;
  }
  if (!wasMoving && !force) return false;
  let sent = 0;
  for (const socket of robotSockets) {
    if (sendControllerStop(socket)) sent += 1;
  }
  log('vehicle.stop', { reason, forwarded: sent > 0 });
  broadcastStatus();
  return sent > 0;
}

const appRoot = path.join(__dirname, 'client', 'dist');
app.use(express.json({ limit: '32kb' }));
app.get('/health', (_request, response) => {
  response.json({ ok: true, mode: 'hardware', controllerConnected: state.connected });
});
app.get('/api/status', (_request, response) => {
  response.json({
    ...state,
    telemetry: { ...state.telemetry },
    camera: { configured: Boolean(cameraSource), source: cameraSource ? 'configured' : null },
  });
});
app.get('/api/camera/config', (_request, response) => {
  response.json({ configured: Boolean(cameraSource) });
});
app.use(express.static(appRoot));
app.get('*', (_request, response, next) => {
  response.sendFile(path.join(appRoot, 'index.html'), (error) => {
    if (error) next();
  });
});
app.use((error, _request, response, _next) => {
  log('http.error', { message: error.message });
  response.status(error.status || 500).json({ error: 'The request could not be processed.' });
});

io.on('connection', (socket) => {
  dashboardSockets.add(socket);
  socket.emit('vehicle:status', { ...state, telemetry: { ...state.telemetry } });
  socket.emit('camera:status', { connected: state.cameraConnected, configured: Boolean(cameraSource) });

  socket.on('vehicle:connect', (...args) => {
    const acknowledge = args.find((argument) => typeof argument === 'function') || (() => {});
    state.connected = [...robotSockets].some((robot) => robot.controllerOnline);
    acknowledge({ connected: state.connected, mode: 'hardware' });
    broadcastStatus();
    log('vehicle.connect', { mode: 'hardware', connected: state.connected });
  });

  socket.on('vehicle:disconnect', () => {
    stopVehicle('dashboard disconnected vehicle');
    state.connected = [...robotSockets].some((robot) => robot.controllerOnline);
    broadcastStatus();
  });

  socket.on('vehicle:command', (...args) => {
    const command = args[0];
    const acknowledge = args.find((argument) => typeof argument === 'function') || (() => {});
    if (!command || command.type !== 'move' ||
        !Number.isInteger(command.x) || command.x < -100 || command.x > 100 ||
        !Number.isInteger(command.y) || command.y < -100 || command.y > 100 ||
        !Number.isInteger(command.speed) || command.speed < 0 || command.speed > 255) {
      acknowledge({ ok: false, error: 'Invalid movement command. Expected type=move, integer axes -100..100, and PWM speed 0..255.' });
      return;
    }
    if (command.speed === 0 || (command.x === 0 && command.y === 0)) {
      stopVehicle('zero movement command');
      acknowledge({ ok: true });
      return;
    }
    if (!robotSockets.size || !state.connected || state.emergencyStopped) {
      acknowledge({ ok: false, error: 'Vehicle is disconnected or emergency-stopped.' });
      return;
    }
    const forwarded = { type: 'move', x: command.x, y: command.y, speed: command.speed };
    sendMovement(forwarded);
    state.direction = 'move';
    state.speed = Math.round(command.speed / 2.55);
    socket.data.lastMovementAt = Date.now();
    acknowledge({ ok: true });
    broadcastStatus();
  });

  socket.on('vehicle:speed', (...args) => {
    const percent = args[0];
    const acknowledge = args.find((argument) => typeof argument === 'function') || (() => {});
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
      acknowledge({ ok: false, error: 'Speed must be an integer from 0 to 100.' });
      return;
    }
    if (!state.connected || robotSockets.size === 0) {
      acknowledge({ ok: false, error: 'Vehicle is disconnected.' });
      return;
    }
    state.speed = percent;
    for (const robot of robotSockets) {
      if (robot.controllerProtocol !== 'command-json' || robot.readyState !== WebSocket.OPEN) continue;
      robot.send(JSON.stringify({ command: 'speed', speed: percent }), (error) => {
        if (error) log('controller.send-error', { message: error.message });
      });
      robot.selectedSpeed = percent;
    }
    broadcastStatus();
    acknowledge({ ok: true });
  });

  socket.on('vehicle:vacuum', (...args) => {
    const command = args[0];
    const acknowledge = args.find((argument) => typeof argument === 'function') || (() => {});
    if (!['vacuum_on', 'vacuum_off'].includes(command)) {
      acknowledge({ ok: false, error: 'Invalid vacuum command.' });
      return;
    }
    if (!state.connected || robotSockets.size === 0) {
      acknowledge({ ok: false, error: 'Vehicle is disconnected.' });
      return;
    }
    let sent = 0;
    for (const robot of robotSockets) {
      if (robot.controllerProtocol !== 'command-json') continue;
      if (robot.readyState !== WebSocket.OPEN) continue;
      robot.send(JSON.stringify({ command }), (error) => {
        if (error) log('controller.send-error', { message: error.message });
      });
      sent += 1;
    }
    acknowledge(sent > 0
      ? { ok: true }
      : { ok: false, error: 'The connected firmware protocol does not support vacuum commands.' });
  });

  socket.on('vehicle:stop', () => {
    stopVehicle('dashboard requested stop', { force: true });
  });

  socket.on('vehicle:emergency-stop', () => {
    const newlyLatched = !state.emergencyStopped;
    state.emergencyStopped = true;
    if (newlyLatched) stopVehicle('emergency stop', { force: true });
    log('vehicle.emergency-stop');
  });

  socket.on('vehicle:reset-emergency-stop', (...args) => {
    const payload = args[0];
    const acknowledge = args.find((argument) => typeof argument === 'function') || (() => {});
    if (payload?.confirmed !== true || !state.connected) {
      acknowledge({ ok: false, error: 'A connected vehicle and explicit confirmation are required.' });
      return;
    }
    state.emergencyStopped = false;
    state.direction = 'stop';
    state.speed = 0;
    acknowledge({ ok: true });
    broadcastStatus();
    log('vehicle.emergency-stop.reset');
  });

  socket.on('camera:connect', () => {
    socket.join(cameraRoom);
    socket.emit('camera:status', { connected: state.cameraConnected, configured: Boolean(cameraSource) });
  });

  for (const event of ['camera:offer', 'camera:answer', 'camera:ice-candidate']) {
    socket.on(event, (message) => {
      if (message && typeof message === 'object') socket.to(cameraRoom).emit(event, message);
    });
  }
  socket.on('camera:status', (status) => {
    if (typeof status?.connected !== 'boolean') return;
    state.cameraConnected = status.connected;
    io.emit('camera:status', { connected: status.connected, configured: Boolean(cameraSource) });
  });

  socket.on('disconnect', () => {
    const hadActiveMovement = Boolean(socket.data.lastMovementAt);
    dashboardSockets.delete(socket);
    if (hadActiveMovement || (dashboardSockets.size === 0 && state.direction !== 'stop')) {
      stopVehicle(hadActiveMovement ? 'control connection lost' : 'last dashboard disconnected');
    }
  });
});

const robotServer = new WebSocket.Server({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  let pathname;
  try {
    pathname = new URL(request.url, 'http://localhost').pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (pathname !== '/robot' && pathname !== '/ws') {
    if (pathname !== '/socket.io' && pathname !== '/socket.io/') socket.destroy();
    return;
  }
  const protocol = pathname === '/ws' ? 'command-json' : 'move-json';
  log('controller.connection.attempt', { path: pathname, protocol });
  robotServer.handleUpgrade(request, socket, head, (websocket) => {
    robotServer.emit('connection', websocket, request, protocol);
  });
});

robotServer.on('connection', (socket, request, protocol) => {
  socket.controllerProtocol = protocol;
  socket.isAlive = true;
  socket.selectedSpeed = null;
  socket.controllerOnline = false;
  socket.on('pong', () => { socket.isAlive = true; });
  robotSockets.add(socket);
  sendControllerStop(socket);
  if (protocol === 'command-json') {
    socket.send(JSON.stringify({ command: 'status' }), (error) => {
      if (error) log('controller.send-error', { message: error.message });
    });
  }
  state.connected = [...robotSockets].some((robot) => robot.controllerOnline);
  broadcastStatus();
  log('controller.connected', { count: robotSockets.size, path: new URL(request.url, 'http://localhost').pathname, protocol });

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      log('controller.invalid-json', { message: error.message });
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      log('controller.invalid-message', { reason: 'expected JSON object', protocol });
      return;
    }
    if (typeof message.type === 'string') {
      log('controller.message', { protocol, type: message.type });
    }
    if (message.type === 'status') {
      if (typeof message.connected !== 'boolean') {
        log('controller.invalid-status', { reason: 'missing connected boolean' });
        return;
      }
      socket.controllerOnline = message.connected;
      state.connected = [...robotSockets].some((robot) => robot.controllerOnline);
      if (Number.isInteger(message.speed) && message.speed >= 0 && message.speed <= 100) {
        state.speed = message.speed;
        state.telemetry.currentSpeed = message.speed;
      }
      if (typeof message.obstacle === 'boolean') {
        state.telemetry.obstacleDetected = message.obstacle;
      } else if (typeof message.distanceCm === 'number' && Number.isFinite(message.distanceCm)) {
        state.telemetry.obstacleDetected = message.distanceCm <= 20;
      } else {
        state.telemetry.obstacleDetected = null;
      }
      if (typeof message.distanceCm === 'number' && Number.isFinite(message.distanceCm)) {
        state.telemetry.distanceCm = message.distanceCm;
      } else state.telemetry.distanceCm = null;
      if (typeof message.vacuum === 'boolean') state.vacuum = message.vacuum;
      state.telemetry.receivedAt = new Date().toISOString();
      if (!state.connected && state.direction !== 'stop') {
        stopVehicle('controller reported disconnected');
      } else {
        broadcastStatus();
      }
      return;
    }
    if (message.type === 'telemetry' || message.type === 'robot_status') {
      if (message.type === 'robot_status' && typeof message.connected === 'boolean') {
        socket.controllerOnline = message.connected;
      } else {
        socket.controllerOnline = true;
      }
      state.connected = [...robotSockets].some((robot) => robot.controllerOnline);
      const fields = {
        batteryPercentage: message.batteryPercentage,
        batteryVoltage: message.batteryVoltage,
        currentSpeed: message.currentSpeed,
        motorStatus: message.motorStatus,
        wifiSignal: message.wifiSignal,
        distanceCm: message.distanceCm,
      };
      for (const [key, value] of Object.entries(fields)) {
        if (key === 'motorStatus' && typeof value === 'string') state.telemetry[key] = value;
        else if (typeof value === 'number' && Number.isFinite(value)) state.telemetry[key] = value;
      }
      if (typeof message.obstacleDetected === 'boolean') {
        state.telemetry.obstacleDetected = message.obstacleDetected;
      } else if (typeof message.obstacle === 'boolean') {
        state.telemetry.obstacleDetected = message.obstacle;
      } else if (typeof message.distanceCm === 'number' && Number.isFinite(message.distanceCm)) {
        state.telemetry.obstacleDetected = message.distanceCm <= 20;
      }
      if (typeof message.vacuum === 'boolean') state.vacuum = message.vacuum;
      if (Object.values(fields).some((value) => value !== undefined) ||
          typeof message.obstacleDetected === 'boolean' ||
          typeof message.obstacle === 'boolean' ||
          typeof message.vacuum === 'boolean') {
        state.telemetry.receivedAt = new Date().toISOString();
      }
      if (!state.connected && state.direction !== 'stop') {
        stopVehicle('controller reported disconnected');
      } else {
        broadcastStatus();
      }
    }
  });
  socket.on('close', () => {
    robotSockets.delete(socket);
    state.connected = [...robotSockets].some((robot) => robot.controllerOnline);
    if (robotSockets.size === 0) {
      state.vacuum = null;
      state.telemetry.batteryPercentage = null;
      state.telemetry.batteryVoltage = null;
      state.telemetry.currentSpeed = null;
      state.telemetry.motorStatus = 'N/A';
      state.telemetry.wifiSignal = null;
      state.telemetry.distanceCm = null;
      state.telemetry.obstacleDetected = null;
      state.telemetry.receivedAt = null;
      stopVehicle('vehicle controller disconnected');
    }
    broadcastStatus();
    log('controller.disconnected', {
      count: robotSockets.size,
      path: new URL(request.url, 'http://localhost').pathname,
      code: socket.closeCode,
      reason: socket.closeReason?.toString() || '',
    });
  });
  socket.on('error', (error) => log('controller.error', { message: error.message }));
});

setInterval(() => {
  for (const socket of robotSockets) {
    if (socket.isAlive === false) {
      log('controller.heartbeat.timeout', { protocol: socket.controllerProtocol });
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, controllerPingIntervalMs).unref();

setInterval(() => {
  for (const socket of dashboardSockets) {
    if (socket.data.lastMovementAt && Date.now() - socket.data.lastMovementAt > stopTimeoutMs) {
      delete socket.data.lastMovementAt;
      stopVehicle('movement dead-man timeout');
    }
  }
}, 50).unref();

if (require.main === module) {
  server.listen(port, '0.0.0.0', () => log('server.ready', { port, mode: 'hardware' }));
}

module.exports = { app, io, server, state, robotSockets, dashboardSockets };
