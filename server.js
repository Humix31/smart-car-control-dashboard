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
const robotSockets = new Set();
const dashboardSockets = new Set();
const state = {
  connected: false,
  mode: 'hardware',
  emergencyStopped: false,
  direction: 'stop',
  speed: 0,
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
  io.emit('vehicle:status', { ...state, telemetry: { ...state.telemetry } });
}

function sendRobot(message) {
  const serialized = JSON.stringify(message);
  let sent = 0;
  for (const socket of robotSockets) {
    if (socket.readyState !== WebSocket.OPEN) continue;
    socket.send(serialized, (error) => {
      if (error) log('controller.send-error', { message: error.message });
    });
    sent += 1;
  }
  return sent;
}

function stopVehicle(reason) {
  state.direction = 'stop';
  state.speed = 0;
  for (const socket of dashboardSockets) {
    delete socket.data.lastMovementAt;
  }
  sendRobot({ type: 'stop' });
  log('vehicle.stop', { reason });
  broadcastStatus();
}

const appRoot = path.join(__dirname, 'client', 'dist');
app.use(express.json({ limit: '32kb' }));
app.get('/health', (_request, response) => {
  response.json({ ok: true, mode: 'hardware', controllerConnected: robotSockets.size > 0 });
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
    state.connected = robotSockets.size > 0;
    acknowledge({ connected: state.connected, mode: 'hardware' });
    broadcastStatus();
    log('vehicle.connect', { mode: 'hardware', connected: state.connected });
  });

  socket.on('vehicle:disconnect', () => {
    stopVehicle('dashboard disconnected vehicle');
    state.connected = robotSockets.size > 0;
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
    if (sendRobot(forwarded) === 0) {
      state.connected = false;
      acknowledge({ ok: false, error: 'No connected robot WebSocket is available.' });
      broadcastStatus();
      return;
    }
    state.direction = 'move';
    state.speed = command.speed;
    socket.data.lastMovementAt = Date.now();
    acknowledge({ ok: true });
    broadcastStatus();
  });

  socket.on('vehicle:stop', () => {
    stopVehicle('dashboard requested stop');
  });

  socket.on('vehicle:emergency-stop', () => {
    state.emergencyStopped = true;
    stopVehicle('emergency stop');
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
    if (hadActiveMovement || dashboardSockets.size === 0) {
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
  if (pathname !== '/robot') {
    return;
  }
  robotServer.handleUpgrade(request, socket, head, (websocket) => {
    robotServer.emit('connection', websocket, request);
  });
});

robotServer.on('connection', (socket) => {
  robotSockets.add(socket);
  sendRobot({ type: 'stop' });
  state.connected = true;
  broadcastStatus();
  log('controller.connected', { count: robotSockets.size });

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      log('controller.invalid-json', { message: error.message });
      return;
    }
    if (message.type === 'telemetry' || message.type === 'robot_status') {
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
      }
      if (Object.values(fields).some((value) => value !== undefined) ||
          typeof message.obstacleDetected === 'boolean') {
        state.telemetry.receivedAt = new Date().toISOString();
      }
      broadcastStatus();
    }
  });
  socket.on('close', () => {
    robotSockets.delete(socket);
    if (robotSockets.size === 0) {
      state.connected = false;
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
    log('controller.disconnected', { count: robotSockets.size });
  });
  socket.on('error', (error) => log('controller.error', { message: error.message }));
});

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
