import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CircleStop } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import './VehicleControls.css';

const controls = [
  { direction: 'forward', label: 'Forward', key: 'W', icon: ArrowUp, className: 'up', x: 0, y: 1 },
  { direction: 'left', label: 'Turn left', key: 'A', icon: ArrowLeft, className: 'left', x: -1, y: 0 },
  { direction: 'reverse', label: 'Reverse', key: 'S', icon: ArrowDown, className: 'down', x: 0, y: -1 },
  { direction: 'right', label: 'Turn right', key: 'D', icon: ArrowRight, className: 'right', x: 1, y: 0 },
];

export function DirectionalControls({ enabled, activeDirection, onStart, onMove, onStop }) {
  const joystickRef = useRef(null);
  const knobRef = useRef(null);
  const joystickPointerRef = useRef(null);
  const joystickStartedRef = useRef(false);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  useEffect(() => {
    if (!enabled && joystickPointerRef.current) releaseJoystick();
  }, [enabled]);

  function updateJoystick(event) {
    const bounds = joystickRef.current?.getBoundingClientRect();
    const knobBounds = knobRef.current?.getBoundingClientRect();
    const pointer = joystickPointerRef.current;
    if (!bounds || !knobBounds || !pointer) return;

    const centerX = bounds.left + bounds.width / 2;
    const centerY = bounds.top + bounds.height / 2;
    const border = Number.parseFloat(window.getComputedStyle(joystickRef.current).borderWidth) || 0;
    const radius = Math.max(0, Math.min(bounds.width, bounds.height) / 2
      - Math.max(knobBounds.width, knobBounds.height) / 2 - border);
    if (radius === 0) return;

    let knobX = event.clientX - centerX - pointer.offsetX;
    let knobY = event.clientY - centerY - pointer.offsetY;
    const distance = Math.hypot(knobX, knobY);
    if (distance > radius) {
      const scale = radius / distance;
      knobX *= scale;
      knobY *= scale;
    }

    setKnob({ x: knobX, y: knobY });
    const vector = { x: knobX / radius, y: -knobY / radius };
    if (Math.hypot(vector.x, vector.y) < 0.04) {
      if (joystickStartedRef.current) onStop(pointer.source);
      joystickStartedRef.current = false;
      return;
    }
    if (joystickStartedRef.current) onMove(vector, pointer.source);
    else {
      joystickStartedRef.current = true;
      onStart(vector, pointer.source);
    }
  }

  function releaseJoystick(event) {
    const pointer = joystickPointerRef.current;
    if (!pointer || (event?.pointerId !== undefined && pointer.pointerId !== event.pointerId)) return;
    joystickPointerRef.current = null;
    if (joystickStartedRef.current) onStop(pointer.source);
    joystickStartedRef.current = false;
    setKnob({ x: 0, y: 0 });
    const target = event?.currentTarget || joystickRef.current;
    if (target?.hasPointerCapture(pointer.pointerId)) {
      target.releasePointerCapture(pointer.pointerId);
    }
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
            if (!enabled || joystickPointerRef.current) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            const bounds = event.currentTarget.getBoundingClientRect();
            joystickPointerRef.current = {
              pointerId: event.pointerId,
              source: `joystick:${event.pointerId}`,
              offsetX: event.clientX - (bounds.left + bounds.width / 2),
              offsetY: event.clientY - (bounds.top + bounds.height / 2),
            };
          }}
          onPointerMove={(event) => {
            if (enabled && joystickPointerRef.current?.pointerId === event.pointerId) updateJoystick(event);
          }}
          onPointerUp={releaseJoystick}
          onPointerCancel={releaseJoystick}
          onLostPointerCapture={releaseJoystick}
          onPointerLeave={(event) => {
            if (joystickPointerRef.current?.pointerId === event.pointerId) releaseJoystick(event);
          }}
        >
          <span className="joystick-axis joystick-axis-x" />
          <span className="joystick-axis joystick-axis-y" />
          <span ref={knobRef} className="joystick-nub" style={{ transform: `translate(calc(-50% + ${knob.x}px), calc(-50% + ${knob.y}px))` }} />
        </div>
        <span className="joystick-instruction">DRAG TO STEER · RELEASE TO STOP</span>
      </div>
      {controls.map(({ direction, label, key, icon: Icon, className, x, y }) => (
        <button
          key={direction}
          type="button"
          className={`direction-button ${className} ${activeDirection === direction ? 'active' : ''}`}
          aria-label={`${label}, ${key}`}
          disabled={!enabled}
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            onStart({ x, y }, `button:${event.pointerId}`);
          }}
          onPointerUp={(event) => onStop(`button:${event.pointerId}`)}
          onPointerCancel={(event) => onStop(`button:${event.pointerId}`)}
          onLostPointerCapture={(event) => onStop(`button:${event.pointerId}`)}
          onPointerLeave={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
              onStop(`button:${event.pointerId}`);
            }
          }}
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
