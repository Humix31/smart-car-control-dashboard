import { io } from 'socket.io-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CarFront, Signal, Zap } from 'lucide-react';
import { DashboardLayout, TopBar } from './components/DashboardLayout.jsx';
import { DirectionalControls, EmergencyStopButton, SpeedSlider } from './components/VehicleControls.jsx';
import { LiveCamera } from './components/LiveCamera.jsx';
import { BatteryIndicator, ConnectionStatus, EventLog, TelemetryPanel } from './components/Telemetry.jsx';
import { SettingsPanel } from './components/SettingsPanel.jsx';
import './components/VacuumControls.css';

const initialTelemetry = {
  batteryPercentage: null,
  batteryVoltage: null,
  currentSpeed: null,
  motorStatus: 'N/A',
  wifiSignal: null,
  distanceCm: null,
  obstacleDetected: null,
  latencyMs: null,
  receivedAt: null,
};

function now() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function movementSpeedPercent(movement, maximumSpeed) {
  const displacement = Math.min(100, Math.hypot(movement.x, movement.y));
  return Math.round(maximumSpeed * displacement / 100);
}

export default function App() {
  const [activeSection, setActiveSection] = useState('Dashboard');
  const [theme, setTheme] = useState(() => (
    window.localStorage.getItem('rvs-theme') === 'light' ? 'light' : 'dark'
  ));
  const [botType, setBotType] = useState('inspection');
  const [socket, setSocket] = useState(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [vehicleConnected, setVehicleConnected] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const [mode, setMode] = useState('hardware');
  const [telemetry, setTelemetry] = useState(initialTelemetry);
  const [vacuumState, setVacuumState] = useState(null);
  const [cameraConnected, setCameraConnected] = useState(false);
  const [cameraConfigured, setCameraConfigured] = useState(false);
  const [speed, setSpeed] = useState(50);
  const [activeDirection, setActiveDirection] = useState('');
  const [emergencyStopped, setEmergencyStopped] = useState(false);
  const [events, setEvents] = useState([]);
  const movementRef = useRef(null);
  const socketRef = useRef(null);
  const movementIntervalRef = useRef(null);
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const pushEvent = useCallback((message, type = 'info') => {
    setEvents((current) => [{ id: `${Date.now()}-${Math.random()}`, message, type, time: now() }, ...current].slice(0, 7));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('rvs-theme', theme);
  }, [theme]);

  useEffect(() => {
    fetch('/api/camera/config')
      .then((response) => {
        if (!response.ok) throw new Error(`Camera configuration request failed (${response.status}).`);
        return response.json();
      })
      .then((config) => setCameraConfigured(config.configured))
      .catch((error) => setConnectionError(error.message));
  }, []);

  useEffect(() => {
    const connection = io({ autoConnect: false, reconnection: true, reconnectionAttempts: 8, timeout: 8000 });
    socketRef.current = connection;
    setSocket(connection);
    connection.on('connect', () => {
      setSocketConnected(true);
      setConnectionError('');
      connection.emit('vehicle:connect', (result) => {
        setVehicleConnected(result.connected);
        setMode(result.mode || 'hardware');
        pushEvent(result.connected ? 'Dashboard connected to vehicle controller' : 'Dashboard connected; vehicle controller is offline', result.connected ? 'success' : 'warning');
      });
    });
    connection.on('connect_error', (error) => {
      setSocketConnected(false);
      setVehicleConnected(false);
      setConnectionError(error.message || 'Connection failed. Check the server and network.');
      pushEvent(`Connection failed: ${error.message}`, 'error');
    });
    connection.on('disconnect', (reason) => {
      setSocketConnected(false);
      setVehicleConnected(false);
      setActiveDirection('');
      movementRef.current = null;
      if (movementIntervalRef.current) window.clearInterval(movementIntervalRef.current);
      movementIntervalRef.current = null;
      setTelemetry(initialTelemetry);
      setVacuumState(null);
      if (reason !== 'io client disconnect') pushEvent('Control connection lost. Vehicle movement has been stopped.', 'error');
    });
    connection.on('vehicle:status', (status) => {
      const connected = Boolean(status.connected);
      setVehicleConnected(connected);
      if (!connected) {
        setActiveDirection('');
        movementRef.current = null;
        if (movementIntervalRef.current) window.clearInterval(movementIntervalRef.current);
        movementIntervalRef.current = null;
      }
      setEmergencyStopped(Boolean(status.emergencyStopped));
      setMode(status.mode || 'hardware');
      setTelemetry(status.telemetry || initialTelemetry);
      setVacuumState(typeof status.vacuum === 'boolean' ? status.vacuum : null);
    });
    connection.on('camera:status', (status) => setCameraConnected(Boolean(status.connected)));
    connection.connect();
    return () => {
      connection.emit('vehicle:stop');
      connection.disconnect();
      socketRef.current = null;
    };
  }, [pushEvent]);

  const stopMovement = useCallback(() => {
    if (movementIntervalRef.current) window.clearInterval(movementIntervalRef.current);
    movementIntervalRef.current = null;
    if (movementRef.current && socketRef.current?.connected) socketRef.current.emit('vehicle:stop');
    movementRef.current = null;
    setActiveDirection('');
  }, []);

  const startMovement = useCallback((vector) => {
    if (!socketRef.current?.connected || !vehicleConnected || emergencyStopped || speedRef.current === 0) return;
    const direction = botType === 'vacuum' ? -1 : 1;
    const x = Math.max(-100, Math.min(100, Math.round(vector.x * direction)));
    const y = Math.max(-100, Math.min(100, Math.round(vector.y * direction)));
    if (x === 0 && y === 0) return;
    if (movementRef.current) return;
    movementRef.current = { x, y };
    setActiveDirection(Math.abs(y) >= Math.abs(x) ? (y > 0 ? 'forward' : 'reverse') : (x > 0 ? 'right' : 'left'));
    const sendCommand = () => {
      const movement = movementRef.current;
      if (!socketRef.current?.connected || !movement) return;
      socketRef.current.emit('vehicle:command', {
        type: 'move',
        x: movement.x,
        y: movement.y,
        speed: Math.round(movementSpeedPercent(movement, speedRef.current) * 2.55),
      }, (result) => {
        if (!result?.ok) {
          stopMovement();
          const message = result?.error || 'Movement command rejected.';
          setConnectionError(message);
          pushEvent(message, 'error');
        }
      });
    };
    if (!movementIntervalRef.current) {
      sendCommand();
      movementIntervalRef.current = window.setInterval(sendCommand, 150);
    }
  }, [botType, vehicleConnected, emergencyStopped, stopMovement, pushEvent]);

  const updateMovement = useCallback((vector) => {
    if (!movementRef.current) {
      startMovement(vector);
      return;
    }
    if (!socketRef.current?.connected || !vehicleConnected || emergencyStopped) return;
    const direction = botType === 'vacuum' ? -1 : 1;
    const x = Math.max(-100, Math.min(100, Math.round(vector.x * direction)));
    const y = Math.max(-100, Math.min(100, Math.round(vector.y * direction)));
    if (x === 0 && y === 0) return;
    movementRef.current = { x, y };
    setActiveDirection(Math.abs(y) >= Math.abs(x) ? (y > 0 ? 'forward' : 'reverse') : (x > 0 ? 'right' : 'left'));
  }, [botType, vehicleConnected, emergencyStopped, startMovement]);

  function changeSpeed(value) {
    setSpeed(value);
    if (socketRef.current?.connected && vehicleConnected) {
      const movement = movementRef.current;
      const event = movement && value > 0 ? 'vehicle:command' : 'vehicle:speed';
      const payload = movement && value > 0
        ? {
            type: 'move',
            x: movement.x,
            y: movement.y,
            speed: Math.round(movementSpeedPercent(movement, value) * 2.55),
          }
        : value;
      socketRef.current.emit(event, payload, (result) => {
        if (!result?.ok) {
          const message = result?.error || 'Speed command was rejected.';
          setConnectionError(message);
          pushEvent(message, 'error');
        }
      });
    }
    if (value === 0) {
      const wasMoving = Boolean(movementRef.current);
      stopMovement();
      if (!wasMoving) socketRef.current?.emit('vehicle:stop');
    }
  }

  function setVacuum(command) {
    if (!socketRef.current?.connected || !vehicleConnected) return;
    socketRef.current.emit('vehicle:vacuum', command, (result) => {
      if (!result?.ok) {
        const message = result?.error || 'Vacuum command was rejected.';
        setConnectionError(message);
        pushEvent(message, 'error');
      }
    });
  }

  function changeBotType(nextBotType) {
    if (nextBotType === botType) return;
    stopMovement();
    setBotType(nextBotType);
    pushEvent(
      nextBotType === 'vacuum'
        ? 'Vacuum bot selected. Forward/reverse and left/right controls are reversed.'
        : 'Inspection bot selected. Forward movement is enabled.',
      'info',
    );
  }

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
      const keys = {
        KeyW: { x: 0, y: 100 },
        KeyA: { x: -100, y: 0 },
        KeyS: { x: 0, y: -100 },
        KeyD: { x: 100, y: 0 },
      };
      const vector = keys[event.code];
      if (vector) {
        event.preventDefault();
        if (!event.repeat && !movementRef.current) startMovement(vector);
      } else if (event.code === 'Space') {
        event.preventDefault();
        stopMovement();
        socketRef.current?.emit('vehicle:stop');
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
    if (!socketRef.current?.connected) {
      setConnectionError('Cannot send remote emergency stop while disconnected. Use the hardware emergency stop.');
      return;
    }
    socketRef.current.emit('vehicle:emergency-stop');
    setEmergencyStopped(true);
    pushEvent('Emergency stop latched. Movement commands are disabled.', 'error');
  }

  function clearEmergencyStop() {
    if (!window.confirm('Confirm the vehicle is physically safe and the hardware emergency stop is released before clearing the software latch.')) return;
    socketRef.current?.emit('vehicle:reset-emergency-stop', { confirmed: true }, (result) => {
      if (!result?.ok) {
        setConnectionError(result?.error || 'Emergency stop could not be cleared.');
        return;
      }
      setEmergencyStopped(false);
      pushEvent('Emergency stop latch cleared. Vehicle remains stopped.', 'warning');
    });
  }

  function navigate(section) {
    setActiveSection(section);
    const targets = { Camera: 'camera', Controls: 'controls', Telemetry: 'telemetry', Settings: 'settings' };
    if (targets[section]) document.getElementById(targets[section])?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    else window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const movementEnabled = socketConnected && vehicleConnected && !emergencyStopped;
  const cameraSourceLabel = import.meta.env.VITE_DEMO_MODE === 'true' ? 'DEMO SOURCE' : cameraConfigured ? 'CAMERA READY' : 'NO SOURCE';
  return (
    <DashboardLayout activeSection={activeSection} onNavigate={navigate}>
      <TopBar
        connected={vehicleConnected}
        mode={mode}
        emergencyStopped={emergencyStopped}
        onEmergencyStop={emergencyStopped ? clearEmergencyStop : emergencyStop}
        theme={theme}
        onToggleTheme={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
      />
      <div className="dashboard-scroll">
        <div className="welcome-row">
          <div><p className="eyebrow">CONTROL CENTER <span className="heading-slash">/</span> LIVE OPERATIONS</p><h1>Remote Vehicle System</h1><p className="welcome-copy">Monitor your vehicle and take control in real time.</p></div>
          <div className={`session-indicator ${socketConnected ? 'session-online' : ''}`}><span className="status-dot" /><span><b>{socketConnected ? 'CONTROL LINK ONLINE' : 'CONTROL LINK OFFLINE'}</b><small>{socketConnected ? 'BACKEND CONNECTED' : 'RECONNECTING'}</small></span></div>
        </div>
        {connectionError && <div className="error-banner" role="alert"><AlertTriangle size={16} /><span>{connectionError}</span><button onClick={() => setConnectionError('')} aria-label="Dismiss error">×</button></div>}
        {emergencyStopped && <div className="latched-banner"><AlertTriangle size={16} /><span><b>EMERGENCY STOP LATCHED</b> — reset only after physically confirming the vehicle is safe.</span><button onClick={clearEmergencyStop}>CONFIRM RESET</button></div>}
        <section className="bot-profile panel" aria-label="Bot selection">
          <div className="bot-profile-copy">
            <p className="eyebrow">ACTIVE BOT PROFILE</p>
            <strong>{botType === 'inspection' ? 'Inspection Bot' : 'Vacuum Bot'}</strong>
            <span>{botType === 'inspection' ? 'Forward controls drive forward.' : 'Forward/reverse and left/right controls are swapped.'}</span>
          </div>
          <div className="bot-profile-options" role="group" aria-label="Select bot type">
            <button
              type="button"
              className={botType === 'inspection' ? 'selected' : ''}
              aria-pressed={botType === 'inspection'}
              onClick={() => changeBotType('inspection')}
            >Inspection Bot</button>
            <button
              type="button"
              className={botType === 'vacuum' ? 'selected' : ''}
              aria-pressed={botType === 'vacuum'}
              onClick={() => changeBotType('vacuum')}
            >Vacuum Bot</button>
          </div>
        </section>
        <section className="metrics-row" aria-label="Vehicle status">
          <div className="metric-card"><span className="metric-icon lime"><CarFront size={18} /></span><span><small>VEHICLE STATUS</small><b>{vehicleConnected ? 'Vehicle Online' : 'Vehicle Offline'}</b></span><i className={vehicleConnected ? 'metric-online' : ''} /></div>
          <div className="metric-card"><span className="metric-icon blue"><BatteryIndicator percentage={telemetry.batteryPercentage} /></span><span><small>BATTERY LEVEL</small><b>{typeof telemetry.batteryPercentage === 'number' ? `${Math.round(telemetry.batteryPercentage)}%` : 'N/A'}</b></span></div>
          <ConnectionStatus connected={socketConnected} latency={telemetry.latencyMs} />
          <div className="metric-card"><span className="metric-icon purple"><Signal size={17} /></span><span><small>CAMERA</small><b>{cameraConnected ? 'Streaming' : cameraSourceLabel}</b></span><i className={cameraConnected ? 'metric-online' : ''} /></div>
        </section>
        <div className="main-grid">
          <div className="primary-column">
            <LiveCamera socket={socket} cameraConnected={cameraConnected} configured={cameraConfigured} />
            <TelemetryPanel telemetry={telemetry} connected={vehicleConnected} cameraConnected={cameraConnected} />
            <EventLog events={events} />
          </div>
          <aside className="control-column" id="controls">
            <section className="panel control-panel">
              <div className="panel-heading"><div><div className="eyebrow">{botType === 'inspection' ? 'INSPECTION BOT' : 'VACUUM BOT · REVERSED CONTROLS'}</div><h2>Drive controls</h2></div><span className={`control-ready ${movementEnabled ? 'ready' : ''}`}><i />{movementEnabled ? 'READY' : 'LOCKED'}</span></div>
              <div className="control-content">
                <div className="control-help"><span>PRESS & HOLD TO MOVE</span><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span></div>
                <DirectionalControls enabled={movementEnabled && speed > 0} activeDirection={activeDirection} onStart={startMovement} onMove={updateMovement} onStop={stopMovement} reversed={botType === 'vacuum'} />
                <SpeedSlider value={speed} onChange={changeSpeed} disabled={!vehicleConnected} />
                <div className="control-readout"><span><i className="tiny-car"><CarFront size={15} /></i> SELECTED SPEED</span><b>{speed}<small> %</small></b></div>
                <div className="control-quick-info"><span><Zap size={13} /> {speed}% MAX</span><span><span className="kbd-label">SPACE</span> STOP</span></div>
                <button className="full-stop" disabled={!socketConnected} onClick={() => { stopMovement(); socketRef.current?.emit('vehicle:stop'); }}><span>■</span> STOP VEHICLE</button>
              </div>
            </section>
            <section className="panel vacuum-panel">
              <div className="panel-heading"><div><div className="eyebrow">CLEANING SYSTEM</div><h2>Vacuum fan</h2></div><span className={`vacuum-state ${vacuumState === true ? 'vacuum-on' : ''}`}>{vacuumState === null ? 'UNCONFIRMED' : vacuumState ? 'ON · REPORTED' : 'OFF · REPORTED'}</span></div>
              <div className="vacuum-actions">
                <button type="button" disabled={!socketConnected || !vehicleConnected} onClick={() => setVacuum('vacuum_on')}>FAN ON</button>
                <button type="button" disabled={!socketConnected || !vehicleConnected} onClick={() => setVacuum('vacuum_off')}>FAN OFF</button>
              </div>
            </section>
            <section className="safety-card"><span className="safety-icon"><AlertTriangle size={15} /></span><div><b>SAFETY FIRST</b><p>Software stop is not a substitute for a hardware emergency stop. Keep the physical cutoff accessible.</p></div></section>
            <SettingsPanel mode={mode} cameraConfigured={cameraConfigured} />
          </aside>
        </div>
        <footer className="dashboard-footer"><span>REMOTE VEHICLE SYSTEM <i>·</i> VEHICLE CONTROL</span><span>LAST TELEMETRY <b>{telemetry.receivedAt ? new Date(telemetry.receivedAt).toLocaleTimeString() : 'N/A'}</b></span><span>SESSION LATENCY <b>{typeof telemetry.latencyMs === 'number' ? `${telemetry.latencyMs} ms` : 'N/A'}</b></span></footer>
      </div>
      <div className="mobile-estop-wrap"><EmergencyStopButton onClick={emergencyStopped ? clearEmergencyStop : emergencyStop} stopped={emergencyStopped} /></div>
    </DashboardLayout>
  );
}
