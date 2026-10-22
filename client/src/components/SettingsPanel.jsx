import { useState } from 'react';

export function SettingsPanel({ mode, cameraConfigured, onTokenChange, token }) {
  const [remember, setRemember] = useState(false);
  function updateToken(value) {
    onTokenChange(value);
    if (remember) localStorage.setItem('rover-control-token', value);
    else localStorage.removeItem('rover-control-token');
  }
  return (
    <section className="panel settings-panel" id="settings">
      <div className="panel-heading"><div><div className="eyebrow">CONFIGURATION</div><h2>Settings</h2></div></div>
      <div className="settings-content">
        <label className="setting-field">Approved control token<input type="password" autoComplete="current-password" value={token} onChange={(event) => updateToken(event.target.value)} placeholder="Enter token provided by your administrator" /></label>
        <label className="remember-token"><input type="checkbox" checked={remember} onChange={(event) => { setRemember(event.target.checked); if (!event.target.checked) localStorage.removeItem('rover-control-token'); else if (token) localStorage.setItem('rover-control-token', token); }} /> Remember token on this device</label>
        <div className="setting-summary"><span>Controller mode</span><b>{mode.toUpperCase()}</b></div>
        <div className="setting-summary"><span>Camera source</span><b>{cameraConfigured ? 'CONFIGURED' : 'NOT CONFIGURED'}</b></div>
        <p className="setting-warning">The dashboard control token protects operator access. The ESP32 WebSocket protocol has no device-token field; use TLS and restrict access to the service where practical.</p>
      </div>
    </section>
  );
}
