import { Maximize2, Radio, RefreshCw, VideoOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ESP32_CAM_STREAM_URL } from '../config/camera.js';

const retryDelay = (attempt) => Math.min(750 * (2 ** Math.min(attempt, 4)), 12000);

export function LiveCamera({ onStatusChange }) {
  const viewportRef = useRef(null);
  const retryTimerRef = useRef(null);
  const connectionTimerRef = useRef(null);
  const retryAttemptRef = useRef(0);
  const hasConnectedRef = useRef(false);
  const [status, setStatus] = useState('connecting');
  const [connectionHint, setConnectionHint] = useState('');
  const [cameraActionError, setCameraActionError] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const [timestamp, setTimestamp] = useState('--:--:--');

  useEffect(() => {
    const tick = () => setTimestamp(new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date()));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    onStatusChange?.(status);
  }, [status, onStatusChange]);

  useEffect(() => {
    connectionTimerRef.current = window.setTimeout(() => {
      if (!hasConnectedRef.current) {
        setStatus('unavailable');
        setConnectionHint(getConnectionHint());
      } else {
        setStatus('reconnecting');
      }

      if (!retryTimerRef.current) {
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null;
          retryAttemptRef.current += 1;
          setStatus('reconnecting');
          setRetryKey((key) => key + 1);
        }, retryDelay(retryAttemptRef.current));
      }
    }, 5000);

    return () => {
      window.clearTimeout(connectionTimerRef.current);
      if (retryTimerRef.current) window.clearTimeout(retryTimerRef.current);
    };
  }, [retryKey]);

  function handleStreamError() {
    window.clearTimeout(connectionTimerRef.current);
    setStatus(hasConnectedRef.current ? 'reconnecting' : 'unavailable');
    setConnectionHint(getConnectionHint());
    if (retryTimerRef.current) return;
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      retryAttemptRef.current += 1;
      setStatus('reconnecting');
      setRetryKey((key) => key + 1);
    }, retryDelay(retryAttemptRef.current));
  }

  function handleStreamLoad() {
    window.clearTimeout(connectionTimerRef.current);
    if (retryTimerRef.current) window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    retryAttemptRef.current = 0;
    hasConnectedRef.current = true;
    setConnectionHint('');
    setStatus('connected');
  }

  function retryNow() {
    window.clearTimeout(connectionTimerRef.current);
    if (retryTimerRef.current) window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    retryAttemptRef.current = 0;
    setConnectionHint('');
    setStatus(hasConnectedRef.current ? 'reconnecting' : 'connecting');
    setRetryKey((key) => key + 1);
  }

  async function fullscreen() {
    try {
      setCameraActionError('');
      if (!document.fullscreenElement) await viewportRef.current?.requestFullscreen();
      else await document.exitFullscreen();
    } catch (error) {
      console.error('Camera fullscreen request failed:', error);
      setCameraActionError('Fullscreen is unavailable in this browser or context.');
    }
  }

  const connected = status === 'connected';
  const statusLabel = {
    connecting: 'CONNECTING TO CAMERA',
    connected: 'CAMERA CONNECTED',
    unavailable: 'CAMERA UNAVAILABLE',
    reconnecting: 'RECONNECTING TO CAMERA',
  }[status];

  return (
    <section className="panel camera-panel" id="camera">
      <div className="panel-heading camera-heading">
        <div><div className="eyebrow">LIVE CAMERA</div><h2>Vehicle view</h2></div>
        <div className="camera-actions">
          <span className={`camera-status ${connected ? 'camera-online' : ''} camera-${status}`} role="status"><span />{statusLabel}</span>
          <button className="icon-button" onClick={retryNow} aria-label="Retry camera stream"><RefreshCw size={15} /></button>
          <button className="icon-button" onClick={fullscreen} aria-label="Fullscreen camera"><Maximize2 size={15} /></button>
        </div>
      </div>
      <div className="camera-viewport" ref={viewportRef}>
        <img
          key={retryKey}
          className="camera-image"
          src={ESP32_CAM_STREAM_URL}
          alt={connected ? 'Live video from the ESP32-CAM' : 'ESP32-CAM stream is not currently available'}
          onLoad={handleStreamLoad}
          onError={handleStreamError}
          fetchPriority="high"
          decoding="async"
          referrerPolicy="no-referrer"
        />
        {!connected && (
          <div className="camera-placeholder">
            <div className="camera-placeholder-icon"><VideoOff size={23} /></div>
            <strong>{statusLabel}</strong>
            <span>{connectionHint || (status === 'connecting' || status === 'reconnecting'
              ? 'Waiting for the ESP32-CAM MJPEG stream.'
              : 'Check that this device can reach the camera on the same network and that the camera is powered on.')}</span>
            {status === 'unavailable' && <button onClick={retryNow}><RefreshCw size={14} /> RETRY CAMERA</button>}
          </div>
        )}
        {connected && <div className="recording-indicator"><Radio size={12} /> LIVE</div>}
        {cameraActionError && <div className="camera-error" role="alert"><span>{cameraActionError}</span><button onClick={() => setCameraActionError('')} aria-label="Dismiss camera error">×</button></div>}
        <span className="camera-time">{timestamp}</span>
        <span className="camera-label">CAM-01 <i /> ESP32-CAM</span>
      </div>
      <div className="camera-footer">
        <span><i className={connected ? 'signal-good' : ''} />{connected ? 'MJPEG · VIDEO AVAILABLE' : `MJPEG · ${statusLabel}`}</span>
        <span>{ESP32_CAM_STREAM_URL}</span>
      </div>
    </section>
  );
}

function getConnectionHint() {
  if (window.location.protocol === 'https:' && ESP32_CAM_STREAM_URL.startsWith('http://')) {
    return 'The secure dashboard cannot display this HTTP stream. Use the dashboard over local HTTP on the camera network or configure a secure HTTPS video relay.';
  }
  return 'No video response received. Check that this device can reach the camera on its network and that the camera is powered on.';
}
