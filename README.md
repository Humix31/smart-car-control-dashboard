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

The dashboard sends a Socket.IO `vehicle:command` event with normalized axes while a control is held:

```json
{"type":"control","x":0.0,"y":1.0,"speed":70}
```

`x` and `y` are finite numbers in `-1..1`; positive X is right, positive Y is forward, and `speed` is an integer percentage in `0..100`. The dashboard refreshes movement commands every 150 ms. Releasing the joystick/button, pressing Space/Stop, losing browser focus, or disconnecting the dashboard requests a stop. Independent held inputs are combined; releasing one input does not stop another input that remains held.

The backend validates the normalized payload. For backward compatibility, `/robot` receives the legacy vector frame (`x`/`y` scaled to `-100..100`, `speed` converted to PWM `0..255`). The `/ws` endpoint receives normalized `type:"control"` frames and `type:"stop"` frames. Its stop frame is:

```json
{"type":"stop"}
```

The `/ws` endpoint receives the normalized control frame unchanged and uses the same stop frame above. The firmware in [`firmware/inspection-cleaning-bot.ino`](./firmware/inspection-cleaning-bot.ino) parses this contract and uses the existing GPIO 26/27/14/13 direction pins and GPIO 25/33 PWM enables. Its differential-drive mixer is `leftMotor = y + x` and `rightMotor = y - x`, with both outputs divided by the same scale factor when either exceeds `1` or is below `-1`, then multiplied by the speed percentage. Side A controls the left pair and side B the right pair. The two independent `INVERT_SIDE_*` settings are retained from the supplied sketch; verify them with the wheels raised before driving.

The backend stops sending movement and sends the protocol-appropriate STOP when it has received no refreshed movement command for 500 ms. It also sends stop when the dashboard control socket or robot WebSocket closes. A server cannot deliver a stop over a broken network: a firmware-side motor watchdog and independent hardware emergency stop are still essential. A newly connected robot receives stop immediately; movement is never resumed automatically. Emergency stop remains latched until the connected vehicle is stopped and a user confirms reset.

### ESP32 connection and telemetry

The legacy vector firmware protocol uses the native WebSocket `/robot` endpoint:

```text
wss://smart-car-control-dashboard.onrender.com/robot
```

For local development use:

```text
ws://<computer-on-the-same-network>:3000/robot
```

The backend requires no application control or robot token. Any reachable client can therefore send control commands or connect as a robot. **Do not use this public endpoint on an unrestricted network.** Restrict access with a private deployment/network/VPN or other network-layer controls before connecting a powered vehicle. TLS (`wss://`) encrypts traffic but does not authorize users.

### Command/status WebSocket at `/ws`

Use this path for firmware implementing the normalized control-frame contract:

```text
wss://smart-car-control-dashboard.onrender.com/ws
```

For local development, use `ws://<computer-on-the-same-network>:3000/ws`. After the standard WebSocket upgrade, the server requests status with `{"command":"status"}`. The controller is reported online only after it responds with a valid `type:"status"` message containing a boolean `connected` value; opening the socket alone does not show the rover as online.

Dashboard controls are plain JSON WebSocket text frames:

```json
{"type":"control","x":0.0,"y":1.0,"speed":70}
{"type":"control","x":0.6,"y":0.8,"speed":45}
{"type":"stop"}
{"command":"vacuum_on"}
{"command":"vacuum_off"}
{"command":"status"}
```

Joystick X is negative for left and positive for right; joystick Y is positive for forward and negative for backward. Speed is the selected 0–100% maximum scaled by joystick displacement; the ESP32 converts it to PWM `0..255`. For differential drive, calculate left=`y+x`, right=`y-x`, normalize both by the same factor when necessary, and apply the sign to direction pins and magnitude times speed to PWM. The existing firmware's motor-side polarity correction and 500 ms motor watchdog must be verified on the actual sketch. Stop is processed independently from vacuum and ultrasonic warning state. The ESP32 should continue to report current state as:

```json
{"type":"status","connected":true,"speed":70,"obstacle":false,"vacuum":false}
```

Only reported booleans update the obstacle and vacuum indicators. The obstacle state is warning-only and never changes movement commands. The included sketch sends the recognized `distanceCm`, `obstacleDetected`, `currentSpeed`, and `motorStatus` telemetry fields. The sketch source can be reviewed here, but the ESP32 and motor hardware have not been compiled against or physically tested in this workspace.

### Uploading the ESP32 sketch

1. Install Arduino IDE, the Espressif ESP32 board package, ArduinoJson 7, and the WebSockets library by Markus Sattler.
2. Open `firmware/inspection-cleaning-bot.ino` and select **ESP32 Dev Module**.
3. Replace `YOUR_WIFI_SSID` and `YOUR_WIFI_PASSWORD` on your local copy only; do not commit real credentials.
4. With motor power disconnected, verify the L298N wiring against the existing pins: IN1=26, IN2=27, IN3=14, IN4=13, ENA=25, ENB=33; TRIG=5, ECHO=18; vacuum relay=23.
5. Upload and open Serial Monitor at 115200 baud. First test with the wheels raised, low speed, and the hardware cutoff accessible. Verify forward motion on each side; change only the corresponding `INVERT_SIDE_A` or `INVERT_SIDE_B` value if that side runs backward.
6. Confirm that disconnecting the dashboard stops both channels and that movement does not resume after reconnect. Ultrasonic readings should only change the warning display; vacuum commands remain separate.

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
- ESP32 Wi-Fi credentials are local firmware settings and must not be committed.

```text
client/src/components/   Existing dashboard layout, controls, camera, telemetry, settings
client/src/App.jsx        Socket.IO lifecycle, normalized joystick commands, safety behavior
server.js                 Express, Socket.IO, native ESP32 WebSocket relay, validation, watchdog
firmware/                 ESP32 L298N control, normalized mixer, sensor, relay, watchdog
test/                     Mock-WebSocket integration test for dashboard-to-robot relay
render.yaml               Existing Render service build/start configuration
```
