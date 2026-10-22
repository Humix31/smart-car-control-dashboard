const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const webSocketServer = new WebSocket.Server({ noServer: true });
const port = Number(process.env.PORT || 3000);
const simulationMode = process.env.SIMULATION_MODE === 'true';
const vehicleMode = simulationMode ? 'simulation' : 'hardware';
const controlToken = process.env.CONTROL_TOKEN || (
  simulationMode && process.env.NODE_ENV !== 'production' ? 'local-dev-control-token' : ''
);
const stopTimeoutMs = 900;
const controllerClients = new Set();
const dashboardClients = new Set();
const state = {
  connected: false,
  mode: vehicleMode,
  emergencyStopped: false,
  direction: 'stop',
  speed: null,
  obstacle: null,
  vacuum: null,
  telemetry: {
    batteryPercentage: null,
    batteryVoltage: null,
    currentSpeed: null,
    motorStatus: 'N/A',
    wifiSignal: null,
    latencyMs: null,
    receivedAt: null,
  },
};

if (!controlToken) {
  throw new Error('CONTROL_TOKEN must be configured before starting the dashboard server.');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function log(event, details = {}) {
  console.info(JSON.stringify({ time: new Date().toISOString(), event, ...details }));
}

function sendJson(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function sendToController(message) {
  for (const socket of controllerClients) sendJson(socket, message);
}

function broadcastDashboard(message) {
  for (const socket of dashboardClients) sendJson(socket, message);
}

function broadcastControlState() {
  broadcastDashboard({
    type: 'server_status',
    connected: state.connected,
    mode: state.mode,
    emergencyStopped: state.emergencyStopped,
  });
}

function stopVehicle(reason) {
  state.direction = 'stop';
  for (const socket of dashboardClients) delete socket.lastMovementAt;
  broadcastDashboard({ type: 'motion_stopped' });
  if (simulationMode) {
    state.telemetry.currentSpeed = 0;
    state.telemetry.motorStatus = 'Idle (simulation)';
    broadcastDashboard({
      type: 'simulation_status',
      currentSpeed: 0,
      motorStatus: state.telemetry.motorStatus,
    });
  } else {
    sendToController({ command: 'stop' });
  }
  log('vehicle.stop', { reason });
  broadcastControlState();
}

function resetControllerTelemetry() {
  state.connected = false;
  state.speed = null;
  state.obstacle = null;
  state.vacuum = null;
  state.direction = 'stop';
  state.telemetry.currentSpeed = null;
  state.telemetry.motorStatus = 'N/A';
  state.telemetry.receivedAt = null;
}

function rejectUpgrade(socket, status, message) {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n${message}`);
  socket.destroy();
}

app.use(express.json({ limit: '32kb' }));
app.get('/health', (_request, response) => {
  response.json({ ok: true, mode: vehicleMode, controllerConnected: state.connected });
});
app.get('/api/status', (_request, response) => {
  response.json({
    ...state,
    telemetry: { ...state.telemetry },
  });
});

const appRoot = path.join(__dirname, 'client', 'dist');
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

server.on('upgrade', (request, socket, head) => {
  let requestUrl;
  try {
    requestUrl = new URL(request.url, 'http://localhost');
  } catch (error) {
    rejectUpgrade(socket, '400 Bad Request', 'Invalid WebSocket URL');
    return;
  }

  if (requestUrl.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  const role = requestUrl.searchParams.get('role');
  if (role === 'dashboard') {
    if (!safeEqual(requestUrl.searchParams.get('token'), controlToken)) {
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        sendJson(webSocket, { type: 'auth_error', error: 'Control token rejected.' });
        webSocket.close(1008, 'Control token rejected');
      });
      return;
    }
  } else if (role || requestUrl.searchParams.has('token')) {
    rejectUpgrade(socket, '400 Bad Request', 'Invalid WebSocket role');
    return;
  }

  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    webSocketServer.emit('connection', webSocket, role === 'dashboard' ? 'dashboard' : 'controller');
  });
});

webSocketServer.on('connection', (socket, role) => {
  if (role === 'dashboard') {
    dashboardClients.add(socket);
    sendJson(socket, {
      type: 'server_status',
      connected: state.connected,
      mode: state.mode,
      emergencyStopped: state.emergencyStopped,
    });
    log('dashboard.connected', { count: dashboardClients.size });
  } else {
    if (simulationMode) {
      socket.close(1008, 'Disable simulation mode to connect an ESP32.');
      return;
    }
    controllerClients.add(socket);
    resetControllerTelemetry();
    sendJson(socket, { command: 'status' });
    broadcastControlState();
    log('controller.connected', { count: controllerClients.size });
  }

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      log('websocket.invalid-json', { role, message: error.message });
      return;
    }

    if (role === 'controller') {
      if (message?.type !== 'status' || typeof message.connected !== 'boolean') {
        log('controller.invalid-message', { type: message?.type || 'unknown' });
        return;
      }

      state.connected = message.connected && controllerClients.has(socket);
      state.speed = Number.isInteger(message.speed) && message.speed >= 0 && message.speed <= 100
        ? message.speed
        : null;
      state.obstacle = typeof message.obstacle === 'boolean' ? message.obstacle : null;
      state.vacuum = typeof message.vacuum === 'boolean' ? message.vacuum : null;
      state.telemetry.currentSpeed = state.speed;
      state.telemetry.receivedAt = new Date().toISOString();
      if (!state.connected) {
        stopVehicle('controller reported disconnected');
      } else {
        broadcastDashboard({
          type: 'status',
          connected: true,
          ...(state.speed === null ? {} : { speed: state.speed }),
          ...(state.obstacle === null ? {} : { obstacle: state.obstacle }),
          ...(state.vacuum === null ? {} : { vacuum: state.vacuum }),
        });
        broadcastControlState();
      }
      return;
    }

    if (message?.type === 'control') {
      if (message.action === 'emergency-stop') {
        state.emergencyStopped = true;
        stopVehicle('emergency stop');
        return;
      }
      if (message.action === 'reset-emergency-stop' && message.confirmed === true && (state.connected || simulationMode)) {
        state.emergencyStopped = false;
        stopVehicle('emergency stop reset');
        return;
      }
      sendJson(socket, { type: 'command_error', error: 'Invalid emergency-stop action.' });
      return;
    }

    const command = message?.command;
    const isSpeedCommand = command === 'speed';
    const isAllowedCommand = [
      'forward', 'backward', 'left', 'right', 'stop', 'speed',
      'vacuum_on', 'vacuum_off', 'status',
    ].includes(command);
    if (!isAllowedCommand || (isSpeedCommand &&
      (!Number.isInteger(message.speed) || message.speed < 0 || message.speed > 100))) {
      sendJson(socket, { type: 'command_error', error: 'Invalid vehicle command.' });
      return;
    }

    if (simulationMode) {
      if (command === 'stop') {
        stopVehicle('simulation stop');
      } else if (['forward', 'backward', 'left', 'right'].includes(command)) {
        if (state.emergencyStopped) {
          sendJson(socket, { type: 'command_error', error: 'Emergency stop is latched.' });
          return;
        }
        state.direction = command;
        state.telemetry.currentSpeed = state.speed || 0;
        state.telemetry.motorStatus = 'Running (simulation)';
        sendJson(socket, {
          type: 'simulation_status',
          currentSpeed: state.telemetry.currentSpeed,
          motorStatus: state.telemetry.motorStatus,
        });
      } else if (isSpeedCommand) {
        state.speed = message.speed;
      } else if (command === 'status') {
        sendJson(socket, { type: 'simulation_status', currentSpeed: state.telemetry.currentSpeed, motorStatus: state.telemetry.motorStatus });
      }
      return;
    }

    if (command === 'status' || command === 'stop') {
      if (command === 'stop') {
        state.direction = 'stop';
        for (const dashboard of dashboardClients) delete dashboard.lastMovementAt;
      }
      sendToController({ command });
      return;
    }
    if (!state.connected || !controllerClients.size) {
      sendJson(socket, { type: 'command_error', error: 'ESP32 is offline; command was not sent.' });
      return;
    }
    if (state.emergencyStopped && command !== 'vacuum_on' && command !== 'vacuum_off') {
      sendJson(socket, { type: 'command_error', error: 'Emergency stop is latched.' });
      return;
    }
    if (['forward', 'backward', 'left', 'right'].includes(command)) {
      state.direction = command;
      socket.lastMovementAt = Date.now();
    }
    sendToController(isSpeedCommand
      ? { command, speed: message.speed }
      : { command });
  });

  socket.on('close', () => {
    if (role === 'dashboard') {
      dashboardClients.delete(socket);
      if (state.direction !== 'stop') stopVehicle('dashboard connection lost');
      log('dashboard.disconnected', { count: dashboardClients.size });
      return;
    }

    controllerClients.delete(socket);
    if (controllerClients.size === 0) {
      resetControllerTelemetry();
      stopVehicle('controller connection lost');
      broadcastDashboard({ type: 'status', connected: false });
    }
    log('controller.disconnected', { count: controllerClients.size });
  });
  socket.on('error', (error) => log('websocket.error', { role, message: error.message }));
});

setInterval(() => {
  const now = Date.now();
  for (const socket of dashboardClients) {
    if (socket.lastMovementAt && now - socket.lastMovementAt > stopTimeoutMs) {
      delete socket.lastMovementAt;
      stopVehicle('movement dead-man timeout');
    }
  }
}, 200);

if (simulationMode) {
  setInterval(() => {
    for (const socket of dashboardClients) {
      sendJson(socket, {
        type: 'simulation_status',
        currentSpeed: state.telemetry.currentSpeed,
        motorStatus: state.telemetry.motorStatus,
      });
    }
  }, 1500);
}

server.listen(port, '0.0.0.0', () => log('server.ready', { port, mode: vehicleMode }));
