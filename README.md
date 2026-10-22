# Smart Car Control Dashboard

A React dashboard and Express service for an ESP32 inspection rover. The browser and ESP32 use one regular WebSocket endpoint at `/ws`; the server forwards validated JSON commands and relays ESP32 status. Camera streaming remains a separate, browser-to-camera connection.

## Run locally

Requirements: Node.js 18.18+ and npm.

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Open **http://localhost:5173**. The sample environment enables an explicitly labelled local simulation. For real hardware, set `SIMULATION_MODE=false` and set a unique `CONTROL_TOKEN` in `.env`, then restart. The dashboard's vehicle status stays offline until the ESP32 reports `connected: true`.

Production build and server:

```powershell
npm run build
npm start
```

The Express server listens on `process.env.PORT` (default `3000`) and serves the built client and WebSocket endpoint on the same origin.

## ESP32 WebSocket protocol

Connect the ESP32 to:

```text
wss://smart-car-control-dashboard.onrender.com/ws
```

Use `ws://<computer-on-the-same-network>:3000/ws` for local development. In simulation mode, hardware/controller WebSocket connections are rejected. The `/ws` connection is a regular WebSocket, not Socket.IO. Render terminates TLS, so public clients use WSS.

Dashboard commands forwarded to the ESP32 use these exact JSON shapes:

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

`speed` is an integer from 0 to 100. The dashboard sends a direction while a button/key is held, repeats it as a movement lease, and sends `stop` on release, focus loss, or connection loss. The server sends `stop` if movement commands stop arriving for 900 ms. It also stops on dashboard or controller disconnect. The dashboard's operator WebSocket uses `?role=dashboard&token=...`; the ESP32 connects to the plain `/ws` path.

The ESP32 should report state using:

```json
{"type":"status","connected":true,"speed":70,"obstacle":false,"vacuum":false}
```

The dashboard considers the rover connected only after this report. `obstacle: true` is shown as an obstacle warning within 20 cm; `false` is shown as clear; a missing/stale reading is shown as unavailable. Obstacle status never changes movement commands. Vacuum state is displayed only from the ESP32 report. The speed slider shows the selected speed; telemetry separately labels the ESP32-reported speed setting.

### Firmware responsibilities

This repository contains dashboard/server code only; there is no ESP32 firmware sketch to edit or verify. The firmware must apply the received speed to PWM on L298N `ENA` (GPIO 25) and `ENB` (GPIO 33), drive direction using `IN1` GPIO 26, `IN2` GPIO 27, `IN3` GPIO 14, and `IN4` GPIO 13, and control the vacuum relay on GPIO 23. The ultrasonic sensor uses `TRIG` GPIO 5 and `ECHO` GPIO 18. Firmware must send the status schema above and implement its own motor watchdog so the rover stops if its WebSocket/server link fails; the server-side dead-man cannot stop motors after the ESP32 itself has lost the server connection. Test motor direction, PWM mapping, relay polarity, sensor threshold, and watchdog behavior with wheels raised and the physical power cutoff accessible.

The ESP32 endpoint does not require a device token so it matches the specified `/ws` firmware URL and message contract. `CONTROL_TOKEN` continues to protect dashboard/operator connections. Restrict public access to the service where practical.

## Dashboard settings

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP/WebSocket port; Render supplies this automatically. |
| `SIMULATION_MODE` | `true` only for explicitly labelled local simulation; set `false` for the rover. |
| `CONTROL_TOKEN` | Required operator token. The local example token is not suitable for deployment. |
| `VITE_CAMERA_STREAM_URL` | Optional browser-accessible camera stream URL, read when the client is built. |

The camera default remains configured in [`client/src/config/camera.js`](client/src/config/camera.js) and uses the ESP32-CAM MJPEG endpoint `/stream` on port `81`. Set `VITE_CAMERA_STREAM_URL` in the build environment to override it without editing source. The browser connects directly to this URL: Render cannot route to a private camera IP. HTTPS dashboards may block an HTTP stream as mixed content; for remote camera viewing, configure a browser-accessible HTTPS stream/relay or use the dashboard on the camera's local network over HTTP. Do not place Wi-Fi passwords or private credentials in frontend variables or stream URLs.

## Deploy to Render

The existing [`render.yaml`](render.yaml) builds the client and starts the Node server. Deploy the repository through Render's existing Web Service, then set the `CONTROL_TOKEN` secret when prompted (or in the service's Environment settings) to a long, unique value. Keep `SIMULATION_MODE=false`. Render provides `PORT`; the server accepts HTTPS/WSS upgrades through Render's TLS proxy. Set `VITE_CAMERA_STREAM_URL` as a build environment variable only if you have a browser-reachable stream URL. Redeploy after changing build-time camera configuration.

No deployment is performed by this repository change. Verify Render's deploy log and `/health`, then verify the operator dashboard reports **ESP32 offline** until the board's `/ws` connection and status report are received.

## Safe test sequence

1. With drive power disconnected or wheels raised, build locally with `npm run build` and run `npm start`.
2. Set `SIMULATION_MODE=false` and a local `CONTROL_TOKEN`. Connect the dashboard and ESP32 to the same server; verify the UI remains offline until a status report with `connected:true` arrives.
3. Confirm STOP works before testing each direction at low selected speed. Confirm speed reports and firmware PWM on both enable pins.
4. Test `obstacle:true` and `obstacle:false` reports; verify the warning changes only and does not steer or stop the rover.
5. Test vacuum commands and verify the UI changes only after the ESP32 reports its relay state.
6. Disconnect the dashboard and then the ESP32 separately. Verify the server sends STOP when it can and the firmware watchdog stops the motors when the controller link is lost. Keep the physical cutoff within reach.

An emergency-stop button in the dashboard is a software stop and cannot stop an unreachable rover. It is not a replacement for an independent hardware cutoff.
