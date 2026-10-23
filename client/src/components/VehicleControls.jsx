import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CircleStop } from 'lucide-react';
import { useRef, useState } from 'react';
import './VehicleControls.css';

const controls = [
  { direction: 'forward', label: 'Forward', key: 'W', icon: ArrowUp, className: 'up', x: 0, y: 100 },
  { direction: 'left', label: 'Turn left', key: 'A', icon: ArrowLeft, className: 'left', x: -100, y: 0 },
  { direction: 'reverse', label: 'Reverse', key: 'S', icon: ArrowDown, className: 'down', x: 0, y: -100 },
  { direction: 'right', label: 'Turn right', key: 'D', icon: ArrowRight, className: 'right', x: 100, y: 0 },
];

export function DirectionalControls({ enabled, activeDirection, onStart, onMove, onStop, reversed = false }) {
  const joystickRef = useRef(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const displayedControls = controls.map((control) => {
    if (!reversed) return control;
    const opposite = controls.find(({ direction }) => (
      direction === { forward: 'reverse', reverse: 'forward', left: 'right', right: 'left' }[control.direction]
    ));
    return opposite
      ? { ...control, direction: opposite.direction, label: opposite.label, icon: opposite.icon }
      : control;
  });

  function updateJoystick(event, initial = false) {
    const bounds = joystickRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const radius = bounds.width / 2 - 24;
    let x = (event.clientX - bounds.left - bounds.width / 2) / radius;
    let y = (event.clientY - bounds.top - bounds.height / 2) / radius;
    const commandX = Math.max(-1, Math.min(1, x));
    const commandY = Math.max(-1, Math.min(1, y));
    const magnitude = Math.hypot(x, y);
    if (magnitude > 1) {
      x /= magnitude;
      y /= magnitude;
    }
    const knobX = x * radius;
    const knobY = y * radius;
    setKnob({ x: knobX, y: knobY });
    if (Math.hypot(commandX, commandY) < 0.08) onStop();
    else if (initial) onStart({ x: commandX * 100, y: -commandY * 100 });
    else onMove({ x: commandX * 100, y: -commandY * 100 });
  }

  function releaseJoystick() {
    setKnob({ x: 0, y: 0 });
    onStop();
  }

  return (
    <div className="direction-pad" aria-label="Vehicle movement controls">
      <div className="joystick-control-wrap">
        <div
          ref={joystickRef}
          className={`joystick-control ${activeDirection ? 'joystick-active' : ''}`}
          role="application"
          aria-label="Analog joystick. Drag to steer; release to stop."
          onPointerDown={(event) => {
            if (!enabled) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            updateJoystick(event, true);
          }}
          onPointerMove={(event) => {
            if (enabled && event.currentTarget.hasPointerCapture(event.pointerId)) updateJoystick(event);
          }}
          onPointerUp={releaseJoystick}
          onPointerCancel={releaseJoystick}
          onLostPointerCapture={releaseJoystick}
        >
          <span className="joystick-axis joystick-axis-x" />
          <span className="joystick-axis joystick-axis-y" />
          <span className="joystick-nub" style={{ transform: `translate(calc(-50% + ${knob.x}px), calc(-50% + ${knob.y}px))` }} />
        </div>
        <span className="joystick-instruction">DRAG TO STEER · RELEASE TO STOP</span>
      </div>
      {displayedControls.map(({ direction, label, key, icon: Icon, className, x, y }) => (
        <button
          key={direction}
          type="button"
          className={`direction-button ${className} ${activeDirection === direction ? 'active' : ''}`}
          aria-label={`${label}, ${key}`}
          disabled={!enabled}
          onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); onStart({ x, y }); }}
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
      <div className="section-heading"><span>MAX SPEED</span><strong>{value}<small>%</small></strong></div>
      <input type="range" min="0" max="100" step="1" value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} aria-label="Maximum speed percentage" />
      <div className="range-labels"><span>PRECISE</span><span>FULL POWER</span></div>
    </section>
  );
}

export function EmergencyStopButton({ onClick, stopped }) {
  return <button className="mobile-estop" onClick={onClick}>{stopped ? 'EMERGENCY STOP ACTIVE' : 'EMERGENCY STOP'}</button>;
}
