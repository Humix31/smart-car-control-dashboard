export function SettingsPanel({ mode, cameraConfigured }) {
  return (
    <section className="panel settings-panel" id="settings">
      <div className="panel-heading"><div><div className="eyebrow">CONFIGURATION</div><h2>Settings</h2></div></div>
      <div className="settings-content">
        <div className="setting-summary"><span>Controller mode</span><b>{mode.toUpperCase()}</b></div>
        <div className="setting-summary"><span>Camera source</span><b>{cameraConfigured ? 'CONFIGURED' : 'NOT CONFIGURED'}</b></div>
        <p className="setting-warning">Control and robot WebSockets have no application authentication. Anyone who can reach this public service may be able to control the vehicle. Restrict access at the network or deployment layer before use.</p>
        <p className="setting-warning">Keep the hardware emergency stop accessible. Network and software stops cannot stop a vehicle after a broken connection.</p>
      </div>
    </section>
  );
}
