"""
JointCare AI - ESP32 Bridge & Local Ingestion Server
Run this script to bridge an ESP32 (via USB Serial or Wi-Fi HTTP) directly to your project.
"""

import json
import math
import sys
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
import threading

try:
    import serial  # pip install pyserial
    import serial.tools.list_ports
    HAS_SERIAL = True
except ImportError:
    HAS_SERIAL = False

# In-memory buffer of recent readings for local analysis
READINGS_BUFFER = []
OVERUSE_STRAIN_SCORE = 0.0

def calculate_pitch_angle(ax: float, ay: float, az: float) -> float:
    """Compute relative pitch angle (degrees) from accelerometer components."""
    try:
        denom = math.sqrt(ay * ay + az * az)
        if denom == 0:
            return 0.0
        pitch = math.atan2(-ax, denom) * 57.2957795
        return round(pitch, 2)
    except Exception:
        return 0.0

def process_reading(reading: dict):
    global OVERUSE_STRAIN_SCORE
    ax = float(reading.get("ax", 0))
    ay = float(reading.get("ay", 0))
    az = float(reading.get("az", 0))
    gx = float(reading.get("gx", 0))
    gy = float(reading.get("gy", 0))
    gz = float(reading.get("gz", 0))
    
    angle = reading.get("angle")
    if angle is None:
        angle = calculate_pitch_angle(ax, ay, az)
    
    timestamp = reading.get("measured_at", datetime.now(timezone.utc).isoformat())
    
    # Simple strain heuristic: angular acceleration magnitude + deviation
    gyro_magnitude = math.sqrt(gx*gx + gy*gy + gz*gz)
    OVERUSE_STRAIN_SCORE = min(100.0, round(OVERUSE_STRAIN_SCORE * 0.95 + (gyro_magnitude * 15.0), 1))
    
    item = {
        "measured_at": timestamp,
        "accel_x": ax, "accel_y": ay, "accel_z": az,
        "gyro_x": gx, "gyro_y": gy, "gyro_z": gz,
        "relative_angle_degrees": angle,
        "strain_score": OVERUSE_STRAIN_SCORE
    }
    
    READINGS_BUFFER.append(item)
    if len(READINGS_BUFFER) > 200:
        READINGS_BUFFER.pop(0)

    # Console feedback
    rest_warn = "⚠️ [OVERUSE REST ALERT]" if OVERUSE_STRAIN_SCORE > 75 else "✅ [NORMAL LOAD]"
    print(f"[{timestamp[:19]}] Angle: {angle:6.1f}° | GyroMag: {gyro_magnitude:5.2f} | Strain: {OVERUSE_STRAIN_SCORE:4.1f}/100 {rest_warn}")

# HTTP Handler for ESP32 Wi-Fi Ingestion
class ESP32HTTPHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        
        try:
            payload = json.loads(body.decode("utf-8"))
            # Handles both single reading and batch readings array
            samples = payload if isinstance(payload, list) else payload.get("readings", [payload])
            for s in samples:
                process_reading(s)

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": "ok",
                "processed": len(samples),
                "current_strain": OVERUSE_STRAIN_SCORE
            }).encode("utf-8"))
        except Exception as e:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))

    def do_GET(self):
        # Allow frontend or browser to inspect live readings
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps({
            "live_strain": OVERUSE_STRAIN_SCORE,
            "buffer_count": len(READINGS_BUFFER),
            "recent_readings": READINGS_BUFFER[-10:]
        }).encode("utf-8"))

    def log_message(self, format, *args):
        pass  # Quiet HTTP request logs

def start_http_server(port=8080):
    server = HTTPServer(("0.0.0.0", port), ESP32HTTPHandler)
    print(f"🌐 [Wi-Fi Ingest Server] Listening on http://0.0.0.0:{port}/")
    print(f"   (Point ESP32 HTTPClient to http://<YOUR_COMPUTER_IP>:{port}/)")
    server.serve_forever()

def start_serial_listener(port="COM3", baud=115200):
    if not HAS_SERIAL:
        print("ℹ️ pyserial not installed. Install via: pip install pyserial for USB Serial reading.")
        return
    
    ports = [p.device for p in serial.tools.list_ports.comports()]
    print(f"🔌 Available Serial COM Ports: {ports}")
    if port not in ports and ports:
        port = ports[0]
        print(f"   Auto-selecting port: {port}")

    try:
        ser = serial.Serial(port, baud, timeout=1)
        print(f"🔌 [Serial Bridge] Connected to ESP32 on {port} @ {baud} baud.")
        while True:
            line = ser.readline().decode("utf-8", errors="ignore").strip()
            if line:
                try:
                    # Expected format: JSON {"ax":..,"ay":..,"az":..,"gx":..,"gy":..,"gz":..}
                    # Or CSV format: ax,ay,az,gx,gy,gz
                    if line.startswith("{") and line.endswith("}"):
                        data = json.loads(line)
                    else:
                        parts = [float(x.strip()) for x in line.split(",") if x.strip()]
                        if len(parts) >= 6:
                            data = {
                                "ax": parts[0], "ay": parts[1], "az": parts[2],
                                "gx": parts[3], "gy": parts[4], "gz": parts[5]
                            }
                        else:
                            continue
                    process_reading(data)
                except Exception:
                    pass
    except Exception as e:
        print(f"⚠️ Serial listener stopped: {e}")

if __name__ == "__main__":
    print("=" * 65)
    print("      JointCare AI - ESP32 Bridge & Local Ingestion Server      ")
    print("=" * 65)
    
    # 1. Start Wi-Fi HTTP Receiver in a background thread
    http_thread = threading.Thread(target=start_http_server, args=(8080,), daemon=True)
    http_thread.start()

    # 2. Start Serial Monitor on COM port
    chosen_port = sys.argv[1] if len(sys.argv) > 1 else "COM3"
    print(f"Starting USB Serial listener on {chosen_port} (pass port as arg if different)...")
    start_serial_listener(port=chosen_port)

    # Keep alive if serial listener returns
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping bridge server.")
