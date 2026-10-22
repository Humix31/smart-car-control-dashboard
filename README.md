# Smart Car Control Dashboard

The existing React/Vite dashboard communicates with the Express backend over Socket.IO. The backend supports native WebSocket JSON on both `/robot` (the repository's existing vector protocol) and `/ws` (the command/status protocol described below). These protocols are not interchangeable: Socket.IO is used only between the browser and server.

## Run locally

Requirements: Node.js 18.18+ and npm.

```powershell
npm install
npm run dev
```

Open **http://localhost:5173**. Vite proxies API and Socket.IO traffic to the backend at port 3000. This application now always runs in hardware mode; the vehicle is reported connected only while an ESP32 WebSocket is actually open. With no ESP32, controls remain disabled and sensor readings are `N/A`.

Build and serve the production app locally:

```powershell
npm run build
npm start
```

Open **http://localhost:3000**.

Run the backend communication tests:

```powershell
npm test
```

These tests use a mock native WebSocket robot and a real Socket.IO client. They verify protocol separation, command validation and relay, actual connection reporting, telemetry relay, emergency stop, and server dead-man stop. They do not test motor hardware, the ESP32 sketch, sensors, or camera.

## Communication protocol

The dashboard sends a Socket.IO `vehicle:command` event with this payload while a control is held:

```json
{"type":"move","x":0,"y":100,"speed":255}
```

`x` and `y` are integers in `-100..100`; `speed` is integer PWM in `0..255` (the UI converts the 0–100% slider to PWM). Joystick diagonals send both axes. The dashboard refreshes movement commands every 150 ms. Releasing the joystick/button, pressing Space/Stop, losing browser focus, or disconnecting the dashboard requests a stop.

The backend validates that payload and forwards the **same JSON object**, unchanged, as a native WebSocket text message to every connected robot at `/robot`. Stop and emergency-stop are forwarded as:

```json
{"type":"stop"}
```

The ESP32 must parse these messages and implement the axes/speed-to-motors mapping in its existing firmware. The working Arduino sketch is not present in this repository, so compatibility of its parser and motor behavior is **not yet confirmed**. No GPIO assignments or firmware implementation have been invented here.

The backend stops sending movement and sends the protocol-appropriate STOP when it has received no refreshed movement command for 500 ms. It also sends stop when the dashboard control socket or robot WebSocket closes. A server cannot deliver a stop over a broken network: a firmware-side motor watchdog and independent hardware emergency stop are still essential. A newly connected robot receives stop immediately; movement is never resumed automatically. Emergency stop remains latched until the connected vehicle is stopped and a user confirms reset.

### ESP32 connection and telemetry

Connect the existing ESP32 firmware's native WebSocket client to the Render service:

```text
wss://smart-car-control-dashboard.onrender.com/robot
```

For local development use:

```text
ws://<computer-on-the-same-network>:3000/robot
```

The backend requires no application control or robot token. Any reachable client can therefore send control commands or connect as a robot. **Do not use this public endpoint on an unrestricted network.** Restrict access with a private deployment/network/VPN or other network-layer controls before connecting a powered vehicle. TLS (`wss://`) encrypts traffic but does not authorize users.

### Command/status WebSocket at `/ws`

Use this path when the ESP32 firmware expects JSON commands rather than movement vectors:

```text
wss://smart-car-control-dashboard.onrender.com/ws
```

For local development, use `ws://<computer-on-the-same-network>:3000/ws`. After the standard WebSocket upgrade, the server requests status with `{"command":"status"}`. The controller is reported online only after it responds with a valid `type:"status"` message containing a boolean `connected` value; opening the socket alone does not show the rover as online.

Dashboard commands are plain JSON WebSocket text frames:

```json
{"command":"forward"}
{"command":"backward"}
{"command":"left"}
{"command":"right"}
{"command":"stop"}
{"command":"speed","speed":70}
{"command":"vacuum_on"}
{"command":"vacuum_off"}
{"command":"status"}
```

The dashboard scales speed by joystick displacement up to the selected 0–100% maximum. The backend translates each movement update into one atomic direction-and-speed JSON frame, for example `{"command":"forward","speed":40}`. The ESP32 must apply that speed to its ENA/ENB PWM outputs when processing the frame. The ESP32 should report current state as:

```json
{"type":"status","connected":true,"speed":70,"obstacle":false,"vacuum":false}
```

Only reported booleans update the obstacle and vacuum indicators. The obstacle state is warning-only and never changes movement commands. The repository does not contain the uploaded ESP32 sketch, so this documents the requested `/ws` wire contract; it cannot verify that the hardware firmware currently implements it.

On `/robot`, the backend accepts actual sensor data sent by the ESP32 as `telemetry` or `robot_status` JSON. Recognized optional fields are:

```json
{
  "type":"telemetry",
  "batteryPercentage":82,
  "batteryVoltage":7.4,
  "currentSpeed":35,
  "motorStatus":"forward",
  "wifiSignal":-57,
  "distanceCm":24.6,
  "obstacleDetected":false
}
```

Only numeric values and boolean obstacle states are used; omitted readings show `N/A`. This is the proposed dashboard/server contract, not a claim that the current firmware sends these names. Confirm or adapt the fields against the working Arduino sketch when available.

## Simulation mode and Render

Simulation behavior and fabricated sensor values have been removed. `SIMULATION_MODE` is no longer read: the service reports `mode: "hardware"` and determines `controllerConnected` solely from a live ESP32 WebSocket. The previous source used `process.env.SIMULATION_MODE !== 'false'`, which meant any value other than the exact lowercase string `"false"` selected simulation. The live service was also still returning simulation when checked, so its actual Render environment/deployment did not match the expected value (for example, a stale deployment, a different service, or a value with different capitalization/whitespace). The updated server no longer depends on that variable.

Keep the existing Render service. It should build using `npm install && npm run build`, start with `npm start`, and bind to Render's `PORT` environment variable. Render HTTPS terminates TLS; the browser connects to same-origin Socket.IO, and the ESP32 uses `wss://.../robot`. After pushing, deploy the latest commit to the existing service and verify:

- `GET /health` reports `{"ok":true,"mode":"hardware","controllerConnected":false}` before the ESP32 connects.
- The same endpoint reports `controllerConnected:true` only after an ESP32 sends a valid online status or telemetry message on `/robot` or `/ws`.
- The server log records `controller.connected` and `controller.disconnected`.
- `GET /api/status` contains actual received telemetry or `null`/`N/A`.

Remove `SIMULATION_MODE`, `CONTROL_TOKEN`, and `ROBOT_TOKEN` from the Render environment. There are no remaining application-token configuration requirements. `.env.example` contains only `PORT`, optional camera bridge configuration, and explicitly opt-in demo-video settings.

## ESP32-CAM stream

The existing camera UI and its WebRTC signaling interface are retained. No ESP32-CAM sketch, streaming URL, or camera bridge implementation is in this repository, so the actual supported ESP32-CAM endpoint and the bridge protocol **require confirmation from the firmware/sketch or a known working stream URL**. `CAMERA_STREAM_URL` alone does not make a camera stream or WebRTC peer available. The dashboard must remain in its disconnected placeholder state until it receives a real camera track/status; it does not synthesize live video. Do not guess `/stream`, `/mjpeg/1`, or another endpoint until the camera firmware is confirmed.

`VITE_DEMO_MODE=true` and `VITE_DEMO_VIDEO_URL` remain an explicit, optional demo-only path; leave them unset for vehicle operation.

## Safety

- The control and robot endpoints have no application authentication by request. Restrict network access before allowing a powered vehicle to connect.
- Test with wheels raised, a clear area, low speed, and the motor power cutoff accessible.
- Verify the 500 ms server timeout and firmware watchdog on the physical controller before driving.
- Software/network emergency stop cannot replace a hardware-level emergency stop.
- No physical ESP32, motor, ultrasonic sensor, or camera integration has been tested by this repository-only change.

## Environment and structure

- `PORT` — HTTP and WebSocket server port; Render supplies this automatically.
- `CAMERA_STREAM_URL` — optional camera bridge source configuration; its format must be confirmed against the camera integration.
- `VITE_DEMO_MODE` / `VITE_DEMO_VIDEO_URL` — optional explicitly labeled demo clip.
- `VITE_ICE_SERVERS` — optional JSON array for the retained WebRTC camera signaling interface.

```text
client/src/components/   Existing dashboard layout, controls, camera, telemetry, settings
client/src/App.jsx        Socket.IO lifecycle, normalized joystick commands, safety behavior
server.js                 Express, Socket.IO, native ESP32 WebSocket relay, validation, watchdog
test/                     Mock-WebSocket integration test for dashboard-to-robot relay
render.yaml               Existing Render service build/start configuration
```
