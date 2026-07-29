"""
Example: How to send crash reports to the Crash Report Server from Python.

Requirements:
    pip install requests

Server default URL: http://localhost:8080/api/v1
"""

import requests
import traceback
import sys
import json
import os
from datetime import datetime, timezone


API_BASE = "http://localhost:8080/api/v1"
API_KEY = os.environ.get("API_KEY", "")
API_HEADERS = {"X-API-Key": API_KEY} if API_KEY else {}


# ============================================================
# Example 1: Minimal crash report
# ============================================================
def example_minimal():
    print("--- Example 1: Minimal crash report ---")
    resp = requests.post(f"{API_BASE}/crash-report", headers=API_HEADERS, json={
        "exception_type": "ValueError",
        "exception_message": "Invalid value encountered",
        "runtime": "python",
    })
    print(f"  Status: {resp.status_code}")
    print(f"  Response: {resp.json()}")


# ============================================================
# Example 2: Full crash report with stack trace
# ============================================================
def example_full():
    print("\n--- Example 2: Full crash report ---")
    resp = requests.post(f"{API_BASE}/crash-report", headers=API_HEADERS, json={
        "exception_type": "RuntimeError",
        "exception_message": "Database connection timeout after 30s",
        "stack_trace": (
            "Traceback (most recent call last):\n"
            '  File "/app/db.py", line 42, in connect\n'
            "    conn = pool.get(timeout=30)\n"
            '  File "/app/pool.py", line 15, in get\n'
            "    raise RuntimeError('Connection timeout')\n"
            "RuntimeError: Database connection timeout after 30s"
        ),
        "log_text": "[INFO] Starting connection pool...\n[ERROR] Pool exhausted\n",
        "runtime": "python",
        "runtime_version": "3.11.5",
        "framework": "fastapi",
        "environment": "production",
        "server_name": "api-worker-03",
        "release": "v2.1.0",
        "error_severity": "error",
        "platform": "Linux",
        "os_version": "Ubuntu 22.04",
        "app_version": "2.1.0",
        "bundle_id": "com.example.api",
        "custom_data": {"request_id": "abc-123", "endpoint": "/api/users"},
    })
    print(f"  Status: {resp.status_code}")
    print(f"  Response: {json.dumps(resp.json(), indent=2)}")


# ============================================================
# Example 3: Catch an actual exception and report it
# ============================================================
def example_catch_exception():
    print("\n--- Example 3: Catch real exception and report ---")
    try:
        # Simulate a crash
        data = {"users": [{"id": 1}]}
        _ = data["orders"][0]["price"]  # KeyError!
    except Exception as exc:
        exc_type = type(exc).__name__
        exc_msg = str(exc)
        stack = traceback.format_exc()

        resp = requests.post(f"{API_BASE}/crash-report", headers=API_HEADERS, json={
            "exception_type": exc_type,
            "exception_message": exc_msg,
            "stack_trace": stack,
            "runtime": "python",
            "runtime_version": sys.version.split()[0],
            "environment": "development",
            "release": "dev-001",
        })
        print(f"  Caught: {exc_type}: {exc_msg}")
        print(f"  Status: {resp.status_code}")
        print(f"  Response: {resp.json()}")


# ============================================================
# Example 4: Report with file attachment (dump, log file, etc.)
# ============================================================
def example_with_attachment():
    print("\n--- Example 4: Report with file attachment ---")

    # Create a fake crash dump in memory
    fake_dump = (
        b"Signal: SIGSEGV\n"
        b"Fault address: 0x0000000000000000\n"
        b"Backtrace:\n"
        b"  #0 libc.so+0x12345\n"
        b"  #1 libunity.so+0x67890\n"
    )

    resp = requests.post(f"{API_BASE}/crash-report", headers=API_HEADERS,
        data={
            "exception_type": "SIGSEGV",
            "exception_message": "Segmentation fault",
            "runtime": "unity",
            "runtime_version": "2022.3.10f1",
            "platform": "Android",
            "device_model": "Pixel 8",
            "os_version": "Android 14",
        },
        files={
            "attachments": ("crash.txt", fake_dump, "text/plain"),
        },
    )
    print(f"  Status: {resp.status_code}")
    print(f"  Response: {resp.json()}")


# ============================================================
# Example 5: Unity endpoint (use runtime="unity" in generic API instead)
# ============================================================
def example_unity():
    print("\n--- Example 5: Unity crash (via generic endpoint) ---")
    resp = requests.post(f"{API_BASE}/crash-report", headers=API_HEADERS, json={
        "exception_type": "NullReferenceException",
        "exception_message": "Object reference not set to an instance of an object",
        "stack_trace": "at PlayerController.Update () [0x00000] in /Assets/Scripts/Player.cs:42",
        "runtime": "unity",            # <-- set runtime="unity" here
        "runtime_version": "2022.3.10f1",
        "unity_version": "2022.3.10f1",
        "platform": "iOS",
        "device_model": "iPhone 15",
        "os_version": "iOS 17.4",
        "scene_name": "Level_03",
        "app_version": "1.2.0",
        "bundle_id": "com.studio.mygame",
    })
    print(f"  Status: {resp.status_code}")
    print(f"  Response: {resp.json()}")
    print("  (Use generic /crash-report with runtime='unity' — Python clients can't use /unity/ endpoint)")


# ============================================================
# Example 6: Integration — auto-report unhandled exceptions
# ============================================================
class CrashReporter:
    """Wrap your app's main() in this to auto-report unhandled crashes."""

    def __init__(self, base_url: str = API_BASE, api_key: str = API_KEY, **tags):
        self.base_url = base_url
        self.headers = {"X-API-Key": api_key} if api_key else {}
        self.tags = tags  # extra fields to attach: server_name, environment, etc.

    def report(self, exc_type, exc_value, exc_tb):
        payload = {
            "exception_type": exc_type.__name__,
            "exception_message": str(exc_value),
            "stack_trace": "".join(traceback.format_tb(exc_tb)),
            "runtime": "python",
            "runtime_version": sys.version.split()[0],
            "client_timestamp": datetime.now(timezone.utc).isoformat(),
            **self.tags,
        }
        try:
            resp = requests.post(f"{self.base_url}/crash-report", headers=self.headers, json=payload, timeout=5)
            print(f"[CrashReporter] Reported: {resp.status_code} -> {resp.json()}")
        except Exception as e:
            print(f"[CrashReporter] Failed to report: {e}", file=sys.stderr)

    def install(self):
        """Install as sys.excepthook so all unhandled crashes get reported."""
        def hook(exc_type, exc_value, exc_tb):
            self.report(exc_type, exc_value, exc_tb)
            sys.__excepthook__(exc_type, exc_value, exc_tb)  # still print traceback
        sys.excepthook = hook


def example_auto_report():
    print("\n--- Example 6: Auto-report unhandled exceptions ---")
    reporter = CrashReporter(
        server_name="my-python-app",
        environment="production",
        release="v1.0.0",
    )
    reporter.install()

    # Now any unhandled exception will be sent to the server.
    # Uncomment the next line to test (it will crash the script):
    # raise RuntimeError("Something went wrong!")
    print("  CrashReporter installed (not crashing now).")


# ============================================================
# Run all examples
# ============================================================
if __name__ == "__main__":
    # Quick health check first
    try:
        health = requests.get("http://localhost:8080/health", timeout=3)
        if health.status_code != 200:
            print("Server is not running. Start it with: npx tsx src/main.ts")
            sys.exit(1)
    except requests.ConnectionError:
        print("Cannot connect to server. Start it with: npx tsx src/main.ts")
        sys.exit(1)

    example_minimal()
    example_full()
    example_catch_exception()
    example_with_attachment()
    example_unity()
    example_auto_report()

    print(f"\n{'='*50}")
    print("All examples completed. Check http://localhost:8080/web/")
    print(f"{'='*50}")
