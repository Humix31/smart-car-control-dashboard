import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CircleStop } from 'lucide-react';

const controls = [
  { direction: 'forward', label: 'Forward', key: 'W', icon: ArrowUp, className: 'up' },
  { direction: 'left', label: 'Turn left', key: 'A', icon: ArrowLeft, className: 'left' },
  { direction: 'backward', label: 'Backward', key: 'S', icon: ArrowDown, className: 'down' },
  { direction: 'right', label: 'Turn right', key: 'D', icon: ArrowRight, className: 'right' },
];

export function DirectionalControls({ enabled, activeDirection, onStart, onStop }) {
  return (
    <div className="direction-pad" aria-label="Vehicle movement controls">
      {controls.map(({ direction, label, key, icon: Icon, className }) => (
        <button
          key={direction}
          type="button"
          className={`direction-button ${className} ${activeDirection === direction ? 'active' : ''}`}
          aria-label={`${label}, ${key}`}
          disabled={!enabled}
          onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); onStart(direction); }}
          onPointerUp={onStop}
          onPointerCancel={onStop}
          onLostPointerCapture={onStop}
          onContextMenu={(event) => event.preventDefault()}
        ><Icon size={21} /><span>{label}</span></button>
      ))}
      <div className="pad-center"><button className="pad-stop" type="button" disabled={!enabled} aria-label="Stop vehicle" onClick={onStop}><CircleStop size={16} />STOP</button></div>
    </div>
  );
}

export function SpeedSlider({ value, onChange, disabled }) {
  return (
    <section className="speed-setting">
      <div className="section-heading"><span>SELECTED SPEED</span><strong>{value}<small>%</small></strong></div>
      <input type="range" min="0" max="100" step="1" value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} aria-label="Selected speed percentage" />
      <div className="range-labels"><span>PRECISE</span><span>FULL POWER</span></div>
    </section>
  );
}

export function EmergencyStopButton({ onClick, stopped }) {
  return <button className="mobile-estop" onClick={onClick}>{stopped ? 'EMERGENCY STOP ACTIVE' : 'EMERGENCY STOP'}</button>;
}
