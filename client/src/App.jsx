import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CarFront, ChevronRight, LockKeyhole, Signal, Zap } from 'lucide-react';
import { DashboardLayout, TopBar } from './components/DashboardLayout.jsx';
import { DirectionalControls, EmergencyStopButton, SpeedSlider } from './components/VehicleControls.jsx';
import { LiveCamera } from './components/LiveCamera.jsx';
import { BatteryIndicator, ConnectionStatus, EventLog, TelemetryPanel } from './components/Telemetry.jsx';
import { SettingsPanel } from './components/SettingsPanel.jsx';
import { ESP32_CAM_STREAM_URL } from './config/camera.js';

const initialTelemetry = {
  batteryPercentage: null,
  batteryVoltage: null,
  currentSpeed: null,
  motorStatus: 'N/A',
  wifiSignal: null,
  latencyMs: null,
  receivedAt: null,
};

function now() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function makeWebSocketUrl(token) {
  const url = new URL('/ws', window.location.href);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('role', 'dashboard');
  url.searchParams.set('token', token);
  return url.toString();
}

function retryDelay(attempt) {
  return Math.min(1000 * (2 ** Math.min(attempt, 4)), 15000);
}

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('rover-control-token') || (import.meta.env.DEV ? 'local-dev-control-token' : ''));
  const [sessionToken, setSessionToken] = useState(() => localStorage.getItem('rover-control-token') || (import.meta.env.DEV ? 'local-dev-control-token' : ''));
  const [reconnectKey, setReconnectKey] = useState(0);
  const [activeSection, setActiveSection] = useState('Dashboard');
  const [socketConnected, setSocketConnected] = useState(false);
  const [vehicleConnected, setVehicleConnected] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const [mode, setMode] = useState('hardware');
  const [telemetry, setTelemetry] = useState(initialTelemetry);
  const [obstacle, setObstacle] = useState(null);
  const [vacuum, setVacuum] = useState(null);
  const [cameraConnected, setCameraConnected] = useState(false);
  const [cameraStatus, setCameraStatus] = useState('connecting');
  const cameraConfigured = Boolean(ESP32_CAM_STREAM_URL);
  const [speed, setSpeed] = useState(50);
  const [activeDirection, setActiveDirection] = useState('');
  const [emergencyStopped, setEmergencyStopped] = useState(false);
  const [events, setEvents] = useState([]);
  const directionRef = useRef('');
  const socketRef = useRef(null);
  const movementIntervalRef = useRef(null);
  const selectedSpeedRef = useRef(speed);
  const vehicleConnectedRef = useRef(false);

  const pushEvent = useCallback((message, type = 'info') => {
    setEvents((current) => [{ id: `${Date.now()}-${Math.random()}`, message, type, time: now() }, ...current].slice(0, 7));
  }, []);
  const updateCameraStatus = useCallback((status) => {
    setCameraStatus(status);
    setCameraConnected(status === 'connected');
  }, []);

  const sendCommand = useCallback((message) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  useEffect(() => {
    selectedSpeedRef.current = speed;
  }, [speed]);

  useEffect(() => {
    if (!sessionToken) return undefined;
    let active = true;
    let retryTimer;
    let retryAttempt = 0;
    let authRejected = false;

    function connect() {
      const connection = new WebSocket(makeWebSocketUrl(sessionToken));
      socketRef.current = connection;

      connection.onopen = () => {
        if (!active) return;
        retryAttempt = 0;
        setSocketConnected(true);
        setConnectionError('');
        sendCommandFrom(connection, { command: 'status' });
        pushEvent('Dashboard link connected; waiting for ESP32 status.', 'warning');
      };

      connection.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch (error) {
          console.error('Invalid server WebSocket message:', error);
          setConnectionError('The server sent an invalid message.');
          return;
        }

        if (message.type === 'auth_error') {
          authRejected = true;
          setConnectionError(message.error || 'Control token rejected. Check Settings.');
          return;
        }

        if (message.type === 'server_status') {
          const isConnected = message.connected === true;
          setMode(message.mode === 'simulation' ? 'simulation' : 'hardware');
          setEmergencyStopped(Boolean(message.emergencyStopped));
          updateVehicleConnection(isConnected);
          return;
        }

        if (message.type === 'status') {
          const isConnected = message.connected === true;
          const justConnected = isConnected && !vehicleConnectedRef.current;
          updateVehicleConnection(isConnected);
          setTelemetry((current) => ({
            ...current,
            currentSpeed: isConnected && Number.isInteger(message.speed) && message.speed >= 0 && message.speed <= 100
              ? message.speed
              : null,
            motorStatus: isConnected ? current.motorStatus : 'N/A',
            receivedAt: new Date().toISOString(),
          }));
          setObstacle(typeof message.obstacle === 'boolean' ? message.obstacle : null);
          setVacuum(typeof message.vacuum === 'boolean' ? message.vacuum : null);
          if (justConnected) {
            sendCommandFrom(connection, { command: 'speed', speed: selectedSpeedRef.current });
            pushEvent('ESP32 reported connected.', 'success');
          }
          return;
        }

        if (message.type === 'simulation_status') {
          setTelemetry((current) => ({
            ...current,
            currentSpeed: Number.isInteger(message.currentSpeed) ? message.currentSpeed : null,
            motorStatus: typeof message.motorStatus === 'string' ? message.motorStatus : 'N/A',
            receivedAt: new Date().toISOString(),
          }));
          return;
        }

        if (message.type === 'motion_stopped') {
          directionRef.current = '';
          setActiveDirection('');
          if (movementIntervalRef.current) window.clearInterval(movementIntervalRef.current);
          movementIntervalRef.current = null;
          return;
        }

        if (message.type === 'command_error') {
          setConnectionError(message.error || 'The vehicle rejected the command.');
          pushEvent(message.error || 'Vehicle command rejected.', 'error');
        } else if (message.type === 'control_state') {
          setEmergencyStopped(Boolean(message.emergencyStopped));
        }
      };

      connection.onerror = () => {
        if (active) setConnectionError('Cannot reach the control server. Retrying the WebSocket connection.');
      };

      connection.onclose = (event) => {
        if (!active) return;
        if (socketRef.current === connection) socketRef.current = null;
        if (movementIntervalRef.current) window.clearInterval(movementIntervalRef.current);
        movementIntervalRef.current = null;
        setSocketConnected(false);
        updateVehicleConnection(false);
        setTelemetry(initialTelemetry);
        setObstacle(null);
        setVacuum(null);
        directionRef.current = '';
        setActiveDirection('');
        if (authRejected || event.code === 1008) setConnectionError('Control token rejected. Check the approved token in Settings.');
        else if (event.code !== 1000) pushEvent('Control connection lost; vehicle commands stopped.', 'error');

        if (!authRejected) {
          retryTimer = window.setTimeout(() => {
            retryAttempt += 1;
            connect();
          }, retryDelay(retryAttempt));
        }
      };
    }

    function updateVehicleConnection(connected) {
      vehicleConnectedRef.current = connected;
      setVehicleConnected(connected);
      if (!connected) {
        setObstacle(null);
        setVacuum(null);
        setTelemetry((current) => ({ ...current, currentSpeed: null, motorStatus: 'N/A' }));
      }
    }

    connect();
    return () => {
      active = false;
      window.clearTimeout(retryTimer);
      const connection = socketRef.current;
      if (connection?.readyState === WebSocket.OPEN) {
        sendCommandFrom(connection, { command: 'stop' });
        connection.close(1000, 'Dashboard closed');
      } else if (connection?.readyState === WebSocket.CONNECTING) {
        connection.close();
      }
      socketRef.current = null;
      vehicleConnectedRef.current = false;
    };
  }, [sessionToken, reconnectKey, pushEvent]);

  const stopMovement = useCallback(() => {
    if (movementIntervalRef.current) window.clearInterval(movementIntervalRef.current);
    movementIntervalRef.current = null;
    sendCommand({ command: 'stop' });
    directionRef.current = '';
    setActiveDirection('');
  }, [sendCommand]);

  const startMovement = useCallback((direction) => {
    const controlsAvailable = vehicleConnected || mode === 'simulation';
    if (!socketConnected || !controlsAvailable || emergencyStopped || speed === 0 || directionRef.current) return;
    directionRef.current = direction;
    setActiveDirection(direction);
    const sendMovement = () => {
      if (directionRef.current === direction) sendCommand({ command: direction });
    };
    sendMovement();
    movementIntervalRef.current = window.setInterval(sendMovement, 250);
  }, [vehicleConnected, mode, socketConnected, emergencyStopped, speed, sendCommand]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
      const keys = { KeyW: 'forward', KeyA: 'left', KeyS: 'backward', KeyD: 'right' };
      const direction = keys[event.code];
      if (direction) {
        event.preventDefault();
        if (!event.repeat && !directionRef.current) startMovement(direction);
      } else if (event.code === 'Space') {
        event.preventDefault();
        stopMovement();
      }
    };
    const handleKeyUp = (event) => {
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(event.code)) stopMovement();
    };
    const loseFocus = () => stopMovement();
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', loseFocus);
    document.addEventListener('visibilitychange', loseFocus);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', loseFocus);
      document.removeEventListener('visibilitychange', loseFocus);
    };
  }, [startMovement, stopMovement]);

  function emergencyStop() {
    stopMovement();
    if (!sendCommand({ type: 'control', action: 'emergency-stop' })) {
      setConnectionError('Cannot send remote stop while disconnected. Use the hardware emergency stop.');
      return;
    }
    setEmergencyStopped(true);
    if (!vehicleConnected) setConnectionError('ESP32 is offline; remote STOP could not reach the rover. Use the hardware emergency stop.');
    pushEvent('Emergency stop latched. Movement commands are disabled.', 'error');
  }

  function clearEmergencyStop() {
    if (!window.confirm('Confirm the vehicle is physically safe and the hardware emergency stop is released before clearing the software latch.')) return;
    if (!vehicleConnected && mode !== 'simulation') {
      setConnectionError('The ESP32 must be connected before the stop latch can be reset.');
      return;
    }
    if (!sendCommand({ type: 'control', action: 'reset-emergency-stop', confirmed: true })) {
      setConnectionError('Cannot reset the stop latch while disconnected.');
      return;
    }
    setEmergencyStopped(false);
    pushEvent('Emergency stop latch cleared. Vehicle remains stopped.', 'warning');
  }

  function authorize() {
    if (!token.trim()) {
      setConnectionError('Enter the approved dashboard control token in Settings.');
      setActiveSection('Settings');
      return;
    }
    setConnectionError('');
    setSessionToken(token.trim());
    setReconnectKey((key) => key + 1);
  }

  function updateSpeed(value) {
    setSpeed(value);
    if (socketConnected && (vehicleConnected || mode === 'simulation')) {
      sendCommand({ command: 'speed', speed: value });
    }
  }

  function navigate(section) {
    setActiveSection(section);
    const targets = { Camera: 'camera', Controls: 'controls', Telemetry: 'telemetry', Settings: 'settings' };
    if (targets[section]) document.getElementById(targets[section])?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    else window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const controlsAvailable = vehicleConnected || mode === 'simulation';
  const movementEnabled = socketConnected && controlsAvailable && !emergencyStopped;
  const cameraSourceLabel = {
    connecting: 'Connecting',
    connected: 'Streaming',
    unavailable: 'Unavailable',
    reconnecting: 'Reconnecting',
  }[cameraStatus];
  const sessionLabel = socketConnected
    ? (vehicleConnected ? 'ESP32 CONNECTED' : mode === 'simulation' ? 'SIMULATION · NO ESP32 LINK' : 'WAITING FOR ESP32')
    : (sessionToken ? 'RECONNECTING' : 'AUTHENTICATION REQUIRED');
  const obstacleLabel = !vehicleConnected || obstacle === null
    ? 'NO SENSOR READING'
    : obstacle ? 'OBSTACLE WITHIN 20 CM' : 'CLEAR';
  const vacuumLabel = !vehicleConnected || vacuum === null
    ? 'UNCONFIRMED'
    : vacuum ? 'ON · ESP32 REPORTED' : 'OFF · ESP32 REPORTED';

  return (
    <DashboardLayout activeSection={activeSection} onNavigate={navigate}>
      <TopBar connected={vehicleConnected} mode={mode} emergencyStopped={emergencyStopped} onEmergencyStop={emergencyStopped ? clearEmergencyStop : emergencyStop} />
      <div className="dashboard-scroll">
        <div className="welcome-row">
          <div><p className="eyebrow">CONTROL CENTER <span className="heading-slash">/</span> LIVE OPERATIONS</p><h1>Mission dashboard</h1><p className="welcome-copy">Monitor your vehicle and take control in real time.</p></div>
          <div className={`session-indicator ${vehicleConnected ? 'session-online' : ''}`}><span className="status-dot" /><span><b>{socketConnected ? 'DASHBOARD LINK CONNECTED' : 'DASHBOARD LINK OFFLINE'}</b><small>{sessionLabel}</small></span></div>
        </div>
        {connectionError && <div className="error-banner" role="alert"><AlertTriangle size={16} /><span>{connectionError}</span><button onClick={() => setConnectionError('')} aria-label="Dismiss error">×</button></div>}
        {!socketConnected && <section className="auth-banner">
          <div className="auth-symbol"><LockKeyhole size={18} /></div>
          <div className="auth-copy"><strong>{sessionToken ? 'Connecting to control server' : 'Authorize control session'}</strong><span>{import.meta.env.DEV ? 'Local development uses the sample token. The ESP32 connection is reported separately.' : 'Enter the approved control token in Settings. This does not indicate an ESP32 connection.'}</span></div>
          <button onClick={authorize}>{sessionToken ? 'RETRY' : 'CONNECT'} <ChevronRight size={15} /></button>
        </section>}
        {emergencyStopped && <div className="latched-banner"><AlertTriangle size={16} /><span><b>EMERGENCY STOP LATCHED</b> — reset only after physically confirming the vehicle is safe.</span><button onClick={clearEmergencyStop}>CONFIRM RESET</button></div>}
        <section className="metrics-row" aria-label="Vehicle status">
          <div className="metric-card"><span className="metric-icon lime"><CarFront size={18} /></span><span><small>VEHICLE STATUS</small><b>{vehicleConnected ? 'ESP32 Connected' : mode === 'simulation' ? 'Simulation' : 'Offline'}</b></span><i className={vehicleConnected ? 'metric-online' : ''} /></div>
          <div className="metric-card"><span className="metric-icon blue"><BatteryIndicator percentage={telemetry.batteryPercentage} /></span><span><small>BATTERY LEVEL</small><b>{typeof telemetry.batteryPercentage === 'number' ? `${Math.round(telemetry.batteryPercentage)}%` : 'N/A'}</b></span></div>
          <ConnectionStatus connected={socketConnected} latency={telemetry.latencyMs} />
          <div className="metric-card"><span className="metric-icon purple"><Signal size={17} /></span><span><small>CAMERA</small><b>{cameraConnected ? 'Streaming' : cameraSourceLabel}</b></span><i className={cameraConnected ? 'metric-online' : ''} /></div>
        </section>
        <div className="main-grid">
          <div className="primary-column">
            <LiveCamera onStatusChange={updateCameraStatus} />
            <TelemetryPanel telemetry={telemetry} connected={vehicleConnected} cameraConnected={cameraConnected} />
            <EventLog events={events} />
          </div>
          <aside className="control-column" id="controls">
            <section className="panel control-panel">
              <div className="panel-heading"><div><div className="eyebrow">MANUAL OPERATION</div><h2>Drive controls</h2></div><span className={`control-ready ${movementEnabled ? 'ready' : ''}`}><i />{mode === 'simulation' && movementEnabled ? 'SIMULATION' : movementEnabled ? 'READY' : 'LOCKED'}</span></div>
              <div className="control-content">
                <div className="control-help"><span>PRESS & HOLD TO MOVE</span><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span></div>
                <DirectionalControls enabled={movementEnabled && speed > 0} activeDirection={activeDirection} onStart={startMovement} onStop={stopMovement} />
                <SpeedSlider value={speed} onChange={updateSpeed} disabled={!socketConnected || !controlsAvailable} />
                <div className="control-readout"><span><i className="tiny-car"><CarFront size={15} /></i> SELECTED SPEED</span><b>{speed}<small> %</small></b></div>
                <div className="control-quick-info"><span><Zap size={13} /> {speed}% SELECTED</span><span><span className="kbd-label">SPACE</span> STOP</span></div>
                <button className="full-stop" disabled={!socketConnected} onClick={stopMovement}><span>■</span> STOP VEHICLE</button>
              </div>
            </section>
            <section className={`obstacle-status ${vehicleConnected && obstacle === true ? 'obstacle-warning' : vehicleConnected && obstacle === false ? 'obstacle-clear' : ''}`} role="status" aria-live="polite">
              <div><div className="eyebrow">ULTRASONIC OBSTACLE SENSOR</div><strong>{obstacleLabel}</strong></div>
              <span>{!vehicleConnected || obstacle === null ? 'Awaiting ESP32 reading' : obstacle ? 'Warning only · no automatic avoidance' : 'Sensor reports no obstacle'}</span>
            </section>
            <section className="panel vacuum-panel">
              <div className="panel-heading"><div><div className="eyebrow">CLEANING SYSTEM</div><h2>Vacuum relay</h2></div><span className={`vacuum-state ${vacuum === true ? 'vacuum-on' : ''}`}>{vacuumLabel}</span></div>
              <div className="vacuum-actions">
                <button type="button" disabled={!socketConnected || !vehicleConnected} onClick={() => sendCommand({ command: 'vacuum_on' })}>VACUUM ON</button>
                <button type="button" disabled={!socketConnected || !vehicleConnected} onClick={() => sendCommand({ command: 'vacuum_off' })}>VACUUM OFF</button>
              </div>
            </section>
            <section className="safety-card"><span className="safety-icon"><AlertTriangle size={15} /></span><div><b>SAFETY FIRST</b><p>Software stop is not a substitute for a hardware emergency stop. Keep the physical cutoff accessible.</p></div></section>
            <SettingsPanel mode={mode} cameraConfigured={cameraConfigured} token={token} onTokenChange={setToken} />
          </aside>
        </div>
        <footer className="dashboard-footer"><span>ROVEROS <i>·</i> SECURE VEHICLE CONTROL</span><span>LAST TELEMETRY <b>{telemetry.receivedAt ? new Date(telemetry.receivedAt).toLocaleTimeString() : 'N/A'}</b></span><span>SESSION LATENCY <b>{typeof telemetry.latencyMs === 'number' ? `${telemetry.latencyMs} ms` : 'N/A'}</b></span></footer>
      </div>
      <div className="mobile-estop-wrap"><EmergencyStopButton onClick={emergencyStopped ? clearEmergencyStop : emergencyStop} stopped={emergencyStopped} /></div>
    </DashboardLayout>
  );
}

function sendCommandFrom(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
