import { Battery, Gauge, Radio, Wifi } from 'lucide-react';

export function BatteryIndicator({ percentage }) {
  const available = typeof percentage === 'number';
  return (
    <div className="battery-readout">
      <Battery size={17} />
      <span>{available ? `${Math.round(percentage)}%` : 'N/A'}</span>
      {available && <i><b style={{ width: `${Math.max(0, Math.min(100, percentage))}%` }} /></i>}
    </div>
  );
}

export function ConnectionStatus({ connected, latency }) {
  return <div className="telemetry-tile"><span className="tile-icon"><Wifi size={16} /></span><span><small>CONNECTION</small><b>{connected ? `${typeof latency === 'number' ? `${latency} ms` : 'CONNECTED'}` : 'OFFLINE'}</b></span></div>;
}

export function TelemetryPanel({ telemetry, connected, cameraConnected }) {
  const entries = [
    { label: 'Battery voltage', value: typeof telemetry.batteryVoltage === 'number' ? `${telemetry.batteryVoltage.toFixed(1)} V` : 'N/A', icon: Battery },
    { label: 'ESP32 reported speed', value: typeof telemetry.currentSpeed === 'number' ? `${telemetry.currentSpeed}%` : 'N/A', icon: Gauge },
    { label: 'Wi-Fi signal', value: typeof telemetry.wifiSignal === 'number' ? `${telemetry.wifiSignal} dBm` : 'N/A', icon: Wifi },
    { label: 'Motor status', value: telemetry.motorStatus || 'N/A', icon: Radio },
    { label: 'Camera status', value: cameraConnected ? 'Streaming' : 'N/A', icon: Radio },
    { label: 'Last telemetry', value: telemetry.receivedAt ? new Date(telemetry.receivedAt).toLocaleTimeString() : 'N/A', icon: ActivityIcon },
  ];
  return (
    <section className="panel telemetry-panel" id="telemetry">
      <div className="panel-heading"><div><div className="eyebrow">VEHICLE HEALTH</div><h2>Telemetry</h2></div><span className="telemetry-live"><i />{connected ? 'LIVE UPDATES' : 'WAITING FOR VEHICLE'}</span></div>
      <div className="telemetry-grid">{entries.map(({ label, value, icon: Icon }) => <div className="telemetry-item" key={label}><span className="telemetry-item-icon"><Icon size={16} /></span><span><small>{label}</small><b>{value}</b></span></div>)}</div>
    </section>
  );
}

function ActivityIcon(props) {
  return <Radio {...props} />;
}

export function EventLog({ events }) {
  return (
    <section className="panel event-panel">
      <div className="panel-heading"><div><div className="eyebrow">SYSTEM ACTIVITY</div><h2>Event log</h2></div><span className="panel-subtle">LATEST FIRST</span></div>
      <div className="event-list" aria-live="polite">
        {events.length === 0 ? <p className="empty-log">Events will appear here when the session connects.</p> : events.map((event) => (
          <div className="event-row" key={event.id}><span className={`event-dot ${event.type}`} /><span>{event.message}</span><time>{event.time}</time></div>
        ))}
      </div>
    </section>
  );
}
