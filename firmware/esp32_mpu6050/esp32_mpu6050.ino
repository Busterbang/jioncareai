/*
  JointCare AI · ESP32 + MPU6050 demonstration sensor client.
  Arduino-ESP32 core, Adafruit MPU6050, Adafruit Unified Sensor, ArduinoJson v6.
  Copy secrets.example.h to local secrets.h and keep the token/Wi-Fi credentials private.
  Start a real session in the authenticated dashboard first; paste its ID into SESSION_ID.
  Always validate the server TLS certificate. This is a movement logger, not a medical device.
*/
#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <math.h>
#include <time.h>
#include "secrets.h"

#ifndef DEVICE_ID
#define DEVICE_ID "ESP32_001"  // must equal sensor_devices.device_identifier of the enrolled row
#endif
#ifndef SEND_AUTH_HEADER
#define SEND_AUTH_HEADER 0  // 1 also sends "Authorization: Bearer <token>"; the body device_token is always sent
#endif
#ifndef I2C_SDA_PIN
#define I2C_SDA_PIN 21
#endif
#ifndef I2C_SCL_PIN
#define I2C_SCL_PIN 22
#endif
#ifndef SAMPLE_RATE_HZ
#define SAMPLE_RATE_HZ 10
#endif
#ifndef BATCH_SIZE
#define BATCH_SIZE 20
#endif
#ifndef CALIBRATION_SAMPLES
#define CALIBRATION_SAMPLES 100
#endif
#ifndef FILTER_ALPHA
#define FILTER_ALPHA 0.25f
#endif

static_assert(SAMPLE_RATE_HZ >= 1 && SAMPLE_RATE_HZ <= 25, "Sample rate must be 1-25 Hz");
static_assert(BATCH_SIZE >= 1 && BATCH_SIZE <= 100, "Batch size must be 1-100");
static_assert(FILTER_ALPHA > 0.0f && FILTER_ALPHA <= 1.0f, "FILTER_ALPHA must be in (0,1]");

Adafruit_MPU6050 mpu;
struct Reading { char measuredAt[25]; float ax, ay, az, gx, gy, gz, angle; };
Reading readings[BATCH_SIZE];
size_t readingCount = 0;
float accelBias[3] = {0}, gyroBias[3] = {0}, filtered[6] = {0};
float referencePitchDegrees = 0;
bool filterReady = false, sessionReady = false;
uint32_t nextSampleAt = 0, retryDelayMs = 2000;
const uint32_t maxRetryDelayMs = 60000;

String apiUrl(const char *path) {
  String base(API_BASE_URL);
  while (base.endsWith("/")) base.remove(base.length() - 1);
  return base + path;
}

bool validConfig() {
  const String base(API_BASE_URL), token(DEVICE_TOKEN), session(SESSION_ID);
  if (!WiFi_SSID[0] || !DEVICE_TOKEN[0] || token.length() < 32 || token.indexOf("REPLACE") >= 0 ||
      !SESSION_ID[0] || session.indexOf("PASTE") >= 0 || !API_ROOT_CA[0] || !base.startsWith("https://") ||
      base.indexOf("example.org") >= 0 || base.indexOf("example.invalid") >= 0) {
    Serial.println("Set local Wi-Fi, provisioned device token, active dashboard session ID, deployed HTTPS URL and trusted TLS CA in secrets.h");
    return false;
  }
  return true;
}

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.println("Network status: connecting to 2.4 GHz Wi-Fi");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WiFi_SSID, WiFi_PASSWORD);
  uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 15000) delay(250);
  Serial.println(WiFi.status() == WL_CONNECTED ? "Network status: online" : "Network status: offline; pending samples remain in RAM");
}

bool waitForUtcClock() {
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  for (int attempt = 0; attempt < 30; attempt++) {
    if (time(nullptr) > 1700000000) return true;
    delay(500);
  }
  Serial.println("UTC clock unavailable; will retry before transmitting readings");
  return false;
}

bool utcTimestamp(char *out, size_t capacity) {
  time_t now = time(nullptr);
  if (now <= 1700000000) return false;
  struct tm utc;
  gmtime_r(&now, &utc);
  return strftime(out, capacity, "%Y-%m-%dT%H:%M:%SZ", &utc) > 0;
}

bool postJson(const char *path, const String &body) {
  if (WiFi.status() != WL_CONNECTED) return false;
  WiFiClientSecure client;
  client.setCACert(API_ROOT_CA);
  HTTPClient http;
  if (!http.begin(client, apiUrl(path))) { Serial.println("HTTPS setup failed"); return false; }
  http.setTimeout(10000);
  http.addHeader("Content-Type", "application/json");
#if SEND_AUTH_HEADER
  http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
#endif
  int code = http.POST(body);
  Serial.printf("POST %s -> HTTP %d\n", path, code);
  if (code < 0) {
    // Negative codes are transport/TLS errors (-1 connect/handshake failed: check CA, clock, URL).
    Serial.printf("Transport error: %s\n", HTTPClient::errorToString(code).c_str());
  } else if (code >= 400) {
    String detail = http.getString();  // server diagnostics only; never contains the token
    if (detail.length() > 300) detail.remove(300);
    Serial.printf("Server said: %s\n", detail.c_str());
  }
  http.end();
  return code >= 200 && code < 300;
}

void calibrateAtRest() {
  Serial.printf("Hold still in the intended reference orientation for %u samples...\n", CALIBRATION_SAMPLES);
  double sums[6] = {0};
  uint16_t validCount = 0;
  for (uint16_t i = 0; i < CALIBRATION_SAMPLES; i++) {
    sensors_event_t a, g, t;
    if (mpu.getEvent(&a, &g, &t) && isfinite(a.acceleration.x)) {
      sums[0] += a.acceleration.x; sums[1] += a.acceleration.y; sums[2] += a.acceleration.z;
      sums[3] += g.gyro.x; sums[4] += g.gyro.y; sums[5] += g.gyro.z;
      validCount++;
    } else {
      Serial.println("Warning: MPU6050 read failed during calibration sample; retrying...");
    }
    delay(1000 / SAMPLE_RATE_HZ);
  }
  if (validCount == 0) validCount = 1;
  for (int i = 0; i < 3; i++) {
    accelBias[i] = sums[i] / validCount;
    gyroBias[i] = sums[i + 3] / validCount;
  }
  // Assumes Z-up calibration: remove the stationary gravity component on Z.
  accelBias[2] -= 9.80665f;
  const float meanX = sums[0] / validCount;
  const float meanY = sums[1] / validCount;
  const float meanZ = sums[2] / validCount;
  referencePitchDegrees = atan2f(-meanX, sqrtf(meanY * meanY + meanZ * meanZ)) * 57.2957795f;
  Serial.printf("Calibration complete (%u valid samples). Reference pitch: %.1f degrees (relative orientation only).\n", validCount, referencePitchDegrees);
}

void sampleSensor() {
  sensors_event_t a, g, t;
  if (!mpu.getEvent(&a, &g, &t)) {
    Serial.println("MPU6050 read failed; sample skipped");
    return;
  }
  if (!isfinite(a.acceleration.x) || !isfinite(a.acceleration.y) || !isfinite(a.acceleration.z)) {
    Serial.println("MPU6050 returned non-finite reading; sample skipped");
    return;
  }
  float value[6] = {a.acceleration.x - accelBias[0], a.acceleration.y - accelBias[1], a.acceleration.z - accelBias[2], g.gyro.x - gyroBias[0], g.gyro.y - gyroBias[1], g.gyro.z - gyroBias[2]};
  if (!filterReady) { memcpy(filtered, value, sizeof(value)); filterReady = true; }
  else for (int i = 0; i < 6; i++) filtered[i] += FILTER_ALPHA * (value[i] - filtered[i]);
  for (int i = 0; i < 6; i++) if (!isfinite(filtered[i])) { Serial.println("Non-finite sensor value; sample skipped"); filterReady = false; return; }
  const float pitch = atan2f(-filtered[0], sqrtf(filtered[1] * filtered[1] + filtered[2] * filtered[2])) * 57.2957795f;
  if (!isfinite(pitch)) { Serial.println("Non-finite angle; sample skipped"); return; }
  Reading &r = readings[readingCount];
  if (!utcTimestamp(r.measuredAt, sizeof(r.measuredAt))) { Serial.println("UTC time not synchronized; sample skipped"); return; }
  r.ax = filtered[0]; r.ay = filtered[1]; r.az = filtered[2];
  r.gx = filtered[3]; r.gy = filtered[4]; r.gz = filtered[5];
  r.angle = pitch - referencePitchDegrees;
  readingCount++;
}

bool flushReadings() {
  if (!readingCount || !sessionReady) return true;
  StaticJsonDocument<8192> document;
  document["device_token"] = DEVICE_TOKEN;
  document["device_identifier"] = DEVICE_ID;
  document["session_id"] = SESSION_ID;
  JsonArray batch = document.createNestedArray("readings");
  for (size_t i = 0; i < readingCount; i++) {
    const Reading &r = readings[i];
    JsonObject row = batch.createNestedObject();
    row["measured_at"] = r.measuredAt;
    row["accel_x"] = r.ax; row["accel_y"] = r.ay; row["accel_z"] = r.az;
    row["gyro_x"] = r.gx; row["gyro_y"] = r.gy; row["gyro_z"] = r.gz;
    row["relative_angle_degrees"] = r.angle;
  }
  String body;
  serializeJson(document, body);
  if (!postJson("/api/v1/sensor/devices/ingest", body)) return false;
  Serial.printf("Uploaded %u samples for device %s.\n", (unsigned)readingCount, DEVICE_ID);
  readingCount = 0;
  retryDelayMs = 2000;
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(300);
  if (!validConfig()) { while (true) delay(1000); }
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  Wire.setTimeOut(1000);

  bool mpuDetected = false;
  if (mpu.begin(0x68, &Wire)) {
    Serial.println("MPU6050 initialized successfully at default I2C address 0x68");
    mpuDetected = true;
  } else if (mpu.begin(0x69, &Wire)) {
    Serial.println("MPU6050 initialized successfully at alternate I2C address 0x69 (AD0 pulled HIGH)");
    mpuDetected = true;
  }
  
  if (!mpuDetected) {
    Serial.println("MPU6050 not found at I2C 0x68 or 0x69; verify wiring (SDA=21, SCL=22, 3.3V, GND)");
    while (true) delay(1000);
  }
  mpu.setAccelerometerRange(MPU6050_RANGE_2_G);
  mpu.setGyroRange(MPU6050_RANGE_250_DEG);
  mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
  calibrateAtRest();
  connectWifi();
  if (WiFi.status() == WL_CONNECTED) waitForUtcClock();
  sessionReady = WiFi.status() == WL_CONNECTED && time(nullptr) > 1700000000;
  Serial.printf("Device identifier: %s\n", DEVICE_ID);
  Serial.printf("Active dashboard session: %s\n", SESSION_ID);
  Serial.printf("Session transmission: %s\n", sessionReady ? "ready" : "waiting for network/UTC time");
  Serial.println("Sampling starts only for the manually provisioned active dashboard session.");
  nextSampleAt = millis();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWifi();
    if (WiFi.status() == WL_CONNECTED && time(nullptr) <= 1700000000) waitForUtcClock();
    sessionReady = WiFi.status() == WL_CONNECTED && time(nullptr) > 1700000000;
  }
  if ((int32_t)(millis() - nextSampleAt) >= 0) {
    nextSampleAt += 1000 / SAMPLE_RATE_HZ;
    if (readingCount < BATCH_SIZE && sessionReady) sampleSensor();
  }
  if (readingCount >= BATCH_SIZE && sessionReady && !flushReadings()) {
    Serial.printf("Upload failed; retaining %u samples in RAM. Retry in %lu ms. Check session status, token, network and server.\n", (unsigned)readingCount, (unsigned long)retryDelayMs);
    delay(retryDelayMs);
    retryDelayMs = min(retryDelayMs * 2, maxRetryDelayMs);
  }
  if (Serial.available() && Serial.read() == 's') {
    if (readingCount) flushReadings();
    sessionReady = false;
    Serial.println("Local transmission stopped. Also press Stop session in the authenticated dashboard to close the database session.");
  }
  delay(2);
}
