#pragma once
// Copy this file to secrets.h in the sketch folder. secrets.h is excluded from Git.
#define WiFi_SSID "Gopz"
#define WiFi_PASSWORD "12345678"
// Use the deployed Manus application origin (HTTPS), without /api/v1 or a path suffix.
#define API_BASE_URL "https://jointcare-3yr7pffp.manus.space"
// Paste the one-time token shown after authenticating and enrolling this device in JointCare.
#define DEVICE_TOKEN "DcZYJsrMe0CFnN-Frgf8f-4ox0JczBOeofrN1PIlKeIXOMgYPD_KlfmLQtdOXmKd"
// MUST match sensor_devices.device_identifier exactly (case-sensitive); the server rejects a mismatch with HTTP 403.
#define DEVICE_ID "ESP 32"
// Start a real session in JointCare and copy its ID before compiling/uploading this sketch.
#define SESSION_ID "1e855344-4e2b-4280-a042-42f30119c899"
// Paste the trusted certificate authority PEM for the deployed endpoint TLS chain.
#define API_ROOT_CA "-----BEGIN CERTIFICATE-----\n   curl -i -X POST https://HOST/api/v1/sensor/devices/ingest \
     -H "Content-Type: application/json" \
     -d '{"device_token":"DcZYJsrMe0CFnN-Frgf8f-4ox0JczBOeofrN1PIlKeIXOMgYPD_KlfmLQtdOXmKd"","session_id":"1e855344-4e2b-4280-a042-42f30119c899","readings":[{"measured_at":"2026-10-27T01:28:00Z","accel_x":0,"accel_y":0,"accel_z":9.8,"gyro_x":0,"gyro_y":0,"gyro_z":0}]}'/\n-----END CERTIFICATE-----\n"
// Confirm pins and electrical specifications for the exact selected ESP32 and sensor breakout.
#define I2C_SDA_PIN 21
#define I2C_SCL_PIN 22
// Conservative default; supported range is 1–25 samples/second; batches default to 20 readings.
#define SAMPLE_RATE_HZ 10
#define BATCH_SIZE 20
#define CALIBRATION_SAMPLES 100
#define FILTER_ALPHA 0.25f
