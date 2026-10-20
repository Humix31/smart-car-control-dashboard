import { Activity, Camera, CarFront, LayoutDashboard, Settings2, SlidersHorizontal } from 'lucide-react';

const items = [
  { name: 'Dashboard', icon: LayoutDashboard },
  { name: 'Camera', icon: Camera },
  { name: 'Controls', icon: SlidersHorizontal },
  { name: 'Telemetry', icon: Activity },
  { name: 'Settings', icon: Settings2 },
];

export function Sidebar({ activeSection, onNavigate }) {
  return (
    <aside className="sidebar">
      <a className="brand" href="#dashboard" onClick={() => onNavigate('Dashboard')} aria-label="RoverOS dashboard">
        <span className="brand-mark"><CarFront size={19} /></span>
        <span><strong>ROVER<span>OS</span></strong><small>REMOTE VEHICLE SYSTEMS</small></span>
      </a>
      <div className="nav-caption">WORKSPACE</div>
      <nav className="nav-list" aria-label="Main navigation">
        {items.map(({ name, icon: Icon }) => (
          <button key={name} className={`nav-item ${activeSection === name ? 'selected' : ''}`} onClick={() => onNavigate(name)}>
            <Icon size={17} strokeWidth={1.8} /><span>{name}</span>
            {name === 'Telemetry' && <span className="nav-live-dot" aria-label="Live" />}
          </button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <div className="vehicle-mini"><span className="vehicle-icon"><CarFront size={17} /></span><span><b>ROVER-01</b><small>PRIMARY VEHICLE</small></span><i /></div>
        <p>CONTROL LINK <span>WEBSOCKET</span></p>
        <small className="version">ROVEROS BUILD 2.4.0</small>
      </div>
    </aside>
  );
}

export function DashboardLayout({ activeSection, onNavigate, children }) {
  return (
    <div className="app-shell">
      <Sidebar activeSection={activeSection} onNavigate={onNavigate} />
      <main className="main-content">
        {children}
      </main>
    </div>
  );
}

export function TopBar({ connected, mode, emergencyStopped, onEmergencyStop }) {
  return (
    <header className="topbar">
      <div className="breadcrumb"><span>FLEET</span><i>/</i><b>ROVER-01</b></div>
      <div className="topbar-actions">
        <span className={`connection-pill ${connected ? 'is-online' : ''}`}>
          <span className="status-dot" />{connected ? 'VEHICLE CONNECTED' : 'VEHICLE OFFLINE'}
        </span>
        <span className="mode-pill hardware">{mode.toUpperCase()}</span>
        <button className={`emergency-button ${emergencyStopped ? 'latched' : ''}`} onClick={onEmergencyStop} aria-label="Emergency stop vehicle">
          <span className="estop-icon">■</span><span>{emergencyStopped ? 'STOP LATCHED' : 'EMERGENCY STOP'}</span>
        </button>
      </div>
    </header>
  );
}
