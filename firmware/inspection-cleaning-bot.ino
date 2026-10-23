#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <math.h>

const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

const char* DASHBOARD_HOST = "smart-car-control-dashboard.onrender.com";
const uint16_t DASHBOARD_PORT = 443;
const char* DASHBOARD_PATH = "/ws";

#define IN1 26
#define IN2 27
#define IN3 14
#define IN4 13
#define ENA 25
#define ENB 33

// Side A is the left motor pair; side B is the right motor pair.
// Keep the supplied correction values and verify them with the wheels raised.
const bool INVERT_SIDE_A = false;
const bool INVERT_SIDE_B = true;

#define TRIG_PIN 5
#define ECHO_PIN 18
const float OBSTACLE_THRESHOLD_CM = 20.0f;

#define VACUUM_RELAY_PIN 23
const int RELAY_ON = LOW;
const int RELAY_OFF = HIGH;

const unsigned long SENSOR_INTERVAL_MS = 250;
const unsigned long HEARTBEAT_INTERVAL_MS = 5000;
const unsigned long COMMAND_TIMEOUT_MS = 1500;

WebSocketsClient webSocket;
unsigned long lastSensorRead = 0;
unsigned long lastHeartbeat = 0;
unsigned long lastCommand = 0;
bool dashboardConnected = false;
bool vacuumOn = false;
int currentSpeed = 70;
float currentX = 0.0f;
float currentY = 0.0f;
String currentDirection = "stop";

void stopMotors() {
  analogWrite(ENA, 0);
  analogWrite(ENB, 0);
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
  digitalWrite(IN3, LOW);
  digitalWrite(IN4, LOW);
  currentX = 0.0f;
  currentY = 0.0f;
  currentDirection = "stop";
}

void setVacuum(bool enabled) {
  vacuumOn = enabled;
  digitalWrite(VACUUM_RELAY_PIN, enabled ? RELAY_ON : RELAY_OFF);
  Serial.printf("Vacuum: %s\n", enabled ? "ON" : "OFF");
}

int speedToPwm(float motorValue) {
  const float pwm = fabsf(motorValue) * currentSpeed * 255.0f / 100.0f;
  return constrain(static_cast<int>(lroundf(pwm)), 0, 255);
}

void writeSideA(bool forward, int pwm) {
  if (INVERT_SIDE_A) forward = !forward;
  digitalWrite(IN1, forward ? HIGH : LOW);
  digitalWrite(IN2, forward ? LOW : HIGH);
  analogWrite(ENA, constrain(pwm, 0, 255));
}

void writeSideB(bool forward, int pwm) {
  if (INVERT_SIDE_B) forward = !forward;
  digitalWrite(IN3, forward ? HIGH : LOW);
  digitalWrite(IN4, forward ? LOW : HIGH);
  analogWrite(ENB, constrain(pwm, 0, 255));
}

void drive(float left, float right, const char* label) {
  if (currentSpeed == 0 || (left == 0.0f && right == 0.0f)) {
    stopMotors();
    return;
  }

  writeSideA(left > 0.0f, speedToPwm(left));
  writeSideB(right > 0.0f, speedToPwm(right));
  currentDirection = label;
}

void driveJoystick(float x, float y) {
  if (!isfinite(x) || !isfinite(y) || x < -1.0f || x > 1.0f || y < -1.0f || y > 1.0f) {
    Serial.println("Invalid normalized joystick axes; ignored");
    return;
  }

  currentX = x;
  currentY = y;
  float left = y + x;
  float right = y - x;
  const float peak = fmaxf(fabsf(left), fabsf(right));
  if (peak > 1.0f) {
    left /= peak;
    right /= peak;
  }

  if (fabsf(left) < 0.001f) left = 0.0f;
  if (fabsf(right) < 0.001f) right = 0.0f;
  if (left == 0.0f && right == 0.0f) {
    stopMotors();
    return;
  }

  const char* label = "joystick";
  if (y > 0.0f && x == 0.0f) label = "forward";
  else if (y < 0.0f && x == 0.0f) label = "backward";
  else if (x < 0.0f && y == 0.0f) label = "left";
  else if (x > 0.0f && y == 0.0f) label = "right";
  drive(left, right, label);
}

void driveCardinal(const char* command) {
  if (strcmp(command, "forward") == 0) {
    drive(1.0f, 1.0f, "forward");
  } else if (strcmp(command, "backward") == 0) {
    drive(-1.0f, -1.0f, "backward");
  } else if (strcmp(command, "left") == 0) {
    drive(-1.0f, 1.0f, "left");
  } else if (strcmp(command, "right") == 0) {
    drive(1.0f, -1.0f, "right");
  }
}

float readDistanceCM() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(3);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  const unsigned long duration = pulseIn(ECHO_PIN, HIGH, 30000);
  if (duration == 0) return -1.0f;
  return duration * 0.0343f / 2.0f;
}

void sendTelemetry(float distance) {
  if (!dashboardConnected) return;

  JsonDocument doc;
  doc["type"] = "telemetry";
  doc["currentSpeed"] = currentSpeed;
  doc["motorStatus"] = currentDirection;
  doc["vacuum"] = vacuumOn;
  if (distance >= 0.0f) {
    doc["distanceCm"] = distance;
    doc["obstacleDetected"] = distance <= OBSTACLE_THRESHOLD_CM;
  } else {
    doc["distanceCm"] = nullptr;
    doc["obstacleDetected"] = false;
  }

  String message;
  serializeJson(doc, message);
  if (!webSocket.sendTXT(message)) Serial.println("Telemetry send failed");
}

void sendStatus() {
  JsonDocument doc;
  doc["type"] = "status";
  doc["connected"] = true;
  doc["speed"] = currentSpeed;
  doc["obstacle"] = false;
  doc["vacuum"] = vacuumOn;
  String message;
  serializeJson(doc, message);
  webSocket.sendTXT(message);
}

bool readControlNumber(JsonVariantConst value, float& result) {
  if (!value.is<int>() && !value.is<float>()) return false;
  result = value.as<float>();
  return isfinite(result);
}

void handleCommand(const uint8_t* payload, size_t length) {
  JsonDocument doc;
  const DeserializationError error = deserializeJson(doc, payload, length);
  if (error || !doc.is<JsonObject>()) {
    Serial.println("Invalid JSON control; ignored");
    return;
  }

  const char* type = doc["type"] | "";
  const char* command = doc["command"] | "";
  if (strcmp(type, "stop") == 0 || strcmp(command, "stop") == 0) {
    stopMotors();
    lastCommand = millis();
    return;
  }

  const int requestedSpeed = doc["speed"] | currentSpeed;
  if (requestedSpeed < 0 || requestedSpeed > 100) {
    Serial.println("Invalid speed; command ignored");
    return;
  }

  if (strcmp(type, "control") == 0) {
    float x;
    float y;
    if (!readControlNumber(doc["x"], x) || !readControlNumber(doc["y"], y) ||
        x < -1.0f || x > 1.0f || y < -1.0f || y > 1.0f ||
        !doc["speed"].is<int>()) {
      Serial.println("Invalid normalized control; ignored");
      return;
    }
    currentSpeed = requestedSpeed;
    if (currentSpeed == 0 || (x == 0.0f && y == 0.0f)) {
      stopMotors();
    } else {
      driveJoystick(x, y);
    }
    lastCommand = millis();
    Serial.printf("Control x=%.3f y=%.3f speed=%d\n", x, y, currentSpeed);
    return;
  }

  if (strcmp(command, "speed") == 0) {
    currentSpeed = requestedSpeed;
    if (currentSpeed == 0) stopMotors();
    else if (currentX != 0.0f || currentY != 0.0f) driveJoystick(currentX, currentY);
    lastCommand = millis();
    return;
  }

  if (strcmp(type, "vacuum") == 0) {
    setVacuum(doc["enabled"] | false);
    return;
  }
  if (strcmp(command, "vacuum_on") == 0 || strcmp(command, "vacuum-on") == 0) {
    setVacuum(true);
    return;
  }
  if (strcmp(command, "vacuum_off") == 0 || strcmp(command, "vacuum-off") == 0) {
    setVacuum(false);
    return;
  }
  if (strcmp(command, "status") == 0 || strcmp(type, "status") == 0) {
    lastCommand = millis();
    sendStatus();
    return;
  }
  if (strcmp(type, "ping") == 0) {
    JsonDocument reply;
    reply["type"] = "pong";
    reply["online"] = true;
    String message;
    serializeJson(reply, message);
    webSocket.sendTXT(message);
    return;
  }

  if (strcmp(command, "forward") == 0 || strcmp(command, "backward") == 0 ||
      strcmp(command, "left") == 0 || strcmp(command, "right") == 0) {
    currentSpeed = requestedSpeed;
    if (currentSpeed == 0) stopMotors();
    else driveCardinal(command);
    lastCommand = millis();
    return;
  }

  Serial.println("Unknown command; ignored");
}

void webSocketEvent(WStype_t event, uint8_t* payload, size_t length) {
  switch (event) {
    case WStype_CONNECTED:
      dashboardConnected = true;
      lastCommand = millis();
      stopMotors();
      Serial.println("Dashboard WebSocket connected; movement remains stopped");
      break;
    case WStype_DISCONNECTED:
    case WStype_ERROR:
      dashboardConnected = false;
      stopMotors();
      Serial.println("Dashboard WebSocket unavailable; motors stopped");
      break;
    case WStype_TEXT:
      handleCommand(payload, length);
      break;
    default:
      break;
  }
}

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to Wi-Fi");
  const unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("Wi-Fi connected");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("Wi-Fi connection timed out");
  }
}

void setup() {
  Serial.begin(115200);
  delay(400);

  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  pinMode(IN3, OUTPUT);
  pinMode(IN4, OUTPUT);
  pinMode(ENA, OUTPUT);
  pinMode(ENB, OUTPUT);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(VACUUM_RELAY_PIN, OUTPUT);

  digitalWrite(TRIG_PIN, LOW);
  stopMotors();
  setVacuum(false);

  Serial.println("\nInspection and Cleaning Bot starting");
  connectWiFi();
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);
  webSocket.enableHeartbeat(15000, 3000, 2);
  webSocket.beginSSL(DASHBOARD_HOST, DASHBOARD_PORT, DASHBOARD_PATH);
}

void loop() {
  webSocket.loop();

  if (WiFi.status() != WL_CONNECTED) {
    dashboardConnected = false;
    stopMotors();
    setVacuum(false);
    WiFi.reconnect();
    delay(50);
    return;
  }

  if (dashboardConnected && currentDirection != "stop" &&
      millis() - lastCommand > COMMAND_TIMEOUT_MS) {
    stopMotors();
    Serial.println("Command timeout; motors stopped");
  }

  if (millis() - lastSensorRead >= SENSOR_INTERVAL_MS) {
    lastSensorRead = millis();
    const float distance = readDistanceCM();
    if (distance > 0.0f && distance <= OBSTACLE_THRESHOLD_CM) {
      Serial.printf("WARNING: obstacle %.1f cm\n", distance);
    }
    sendTelemetry(distance);
  }

  if (millis() - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeat = millis();
    Serial.printf("Wi-Fi=%s | Dashboard=%s | Direction=%s | Speed=%d\n",
      WiFi.status() == WL_CONNECTED ? "CONNECTED" : "DISCONNECTED",
      dashboardConnected ? "CONNECTED" : "DISCONNECTED",
      currentDirection.c_str(), currentSpeed);
  }
}
