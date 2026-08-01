"""
API test script for Crash Report Server.
Requires: pip install requests

Usage:
  1. Start the server:    npx tsx src/main.ts
  2. Run this script:     python test_api.py
"""

import requests
import json
import sys
import os
import io

# Force UTF-8 on Windows
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

BASE = os.environ.get("BASE_URL", "http://localhost:8080")
API = f"{BASE}/api/v1"
WEB = f"{BASE}/web"
CREDS = {
    "username": os.environ.get("ADMIN_USERNAME", "admin"),
    "password": os.environ.get("ADMIN_PASSWORD", ""),
}
API_KEY = os.environ.get("API_KEY", "")
INGEST_HEADERS = {"X-API-Key": API_KEY} if API_KEY else {}

if not CREDS["password"]:
    raise SystemExit("Set ADMIN_PASSWORD to the admin password before running tests")
if not API_KEY:
    raise SystemExit("Set API_KEY to an admin-created ingestion API key before running tests")

ok = 0
fail = 0

def check(name: str, condition: bool, detail: str = ""):
    global ok, fail
    if condition:
        ok += 1
        print(f"  ✓ {name}")
    else:
        fail += 1
        print(f"  ✗ {name}  -- {detail}")

def section(title: str):
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}")

# ──────────────────────────────────────────────────
# 1. Health
# ──────────────────────────────────────────────────
section("1. Health Check")
r = requests.get(f"{BASE}/health", timeout=5)
check("GET /health → 200", r.status_code == 200)
check("status=ok", r.json().get("status") == "ok")
check("uptime is float", isinstance(r.json().get("uptime"), (int, float)))

# ──────────────────────────────────────────────────
# 2. Public crash-report ingestion
# ──────────────────────────────────────────────────
section("2. Public Crash Report Ingestion")

# 2a. JSON minimal
r = requests.post(f"{API}/crash-report", headers=INGEST_HEADERS, json={
    "exception_type": "TestException",
    "exception_message": "A test crash",
    "stack_trace": "at line 1\nat line 2",
    "runtime": "node",
    "platform": "Linux",
    "app_version": "1.0.0",
}, timeout=5)
check("POST /crash-report (minimal) → 201", r.status_code == 201)
data = r.json()
check("has id", "id" in data)
check("has group_id", "group_id" in data)
rid = data.get("id")
gid = data.get("group_id")

# 2b. JSON full fields
r = requests.post(f"{API}/crash-report", headers=INGEST_HEADERS, json={
    "exception_type": "NullReferenceException",
    "exception_message": "Object reference not set",
    "stack_trace": "at PlayerController.Update() in /Assets/Scripts/Player.cs:42",
    "log_text": "Loading level...\nCrash!\n",
    "runtime": "unity",
    "runtime_version": "2022.3.10f1",
    "framework": "unity",
    "environment": "production",
    "server_name": "game-server-01",
    "release": "v2.0.0-alpha",
    "error_severity": "fatal",
    "platform": "Android",
    "os_version": "Android 14",
    "device_model": "Samsung S24",
    "gpu_name": "Adreno 750",
    "cpu_name": "Snapdragon 8 Gen 3",
    "memory_mb": 8192,
    "app_version": "2.0.0",
    "bundle_id": "com.example.game",
    "custom_data": {"score": 1234, "level": 5},
}, timeout=5)
check("POST /crash-report (full) → 201", r.status_code == 201)

# 2c. Unity endpoint (requires Unity User-Agent or x-client-type header)
r = requests.post(f"{API}/unity/crash-report", json={
    "exception_type": "UnityException",
    "stack_trace": "(0xDEAD) at MyScript.Update()",
    "unity_version": "6000.0.23f1",
    "platform": "iOS",
}, headers={**INGEST_HEADERS, "x-client-type": "unity"}, timeout=5)
check("POST /unity/crash-report → 201", r.status_code == 201)
data = r.json()
check("runtime field = unity", data.get("runtime") == "unity")

# 2c2. Unity endpoint blocked for non-Unity clients
r = requests.post(f"{API}/unity/crash-report", json={
    "exception_type": "Blocked",
}, headers=INGEST_HEADERS, timeout=5)
check("POST /unity/crash-report (no unity header) → 403", r.status_code == 403)

# 2d. Missing required field
r = requests.post(f"{API}/crash-report", headers=INGEST_HEADERS, json={}, timeout=5)
check("POST /crash-report (empty) → 400", r.status_code == 400)

# 2e. Multipart form upload
r = requests.post(f"{API}/crash-report", headers=INGEST_HEADERS, files={
    "attachments": ("test.txt", b"Fake crash dump content\nbacktrace line 1\nbacktrace line 2\n", "text/plain"),
}, data={
    "exception_type": "SIGSEGV",
    "runtime": "go",
}, timeout=5)
check("POST /crash-report (multipart) → 201", r.status_code == 201)

# 2f. Player-authored feedback (public endpoint)
r = requests.post(f"{API}/player-feedback", headers=INGEST_HEADERS, json={
    "title": "Cannot equip the new sword",
    "description": "The Equip button does nothing after I buy the sword from the shop.",
    "category": "bug",
    "severity": "high",
    "player_id": "player-123",
    "player_name": "Test Player",
    "app_version": "2.0.0",
    "platform": "Android",
    "device_model": "Test Device",
    "scene_name": "Shop",
}, timeout=5)
check("POST /player-feedback → 201", r.status_code == 201)
feedback_data = r.json()
check("player feedback has id", "id" in feedback_data)
feedback_id = feedback_data.get("id")

r = requests.post(f"{API}/player-feedback", headers=INGEST_HEADERS, json={"title": "Missing description"}, timeout=5)
check("POST /player-feedback (missing description) → 400", r.status_code == 400)

# ──────────────────────────────────────────────────
# 3. Protected routes — no auth (should fail)
# ──────────────────────────────────────────────────
section("3. Protected Routes — Unauthenticated")

r = requests.get(f"{API}/crash-groups", timeout=5)
check("GET /crash-groups (no auth) → 401", r.status_code == 401)

r = requests.get(f"{API}/stats/dashboard", timeout=5)
check("GET /stats/dashboard (no auth) → 401", r.status_code == 401)

r = requests.get(f"{API}/platforms", timeout=5)
check("GET /platforms (no auth) → 401", r.status_code == 401)

r = requests.get(f"{API}/versions", timeout=5)
check("GET /versions (no auth) → 401", r.status_code == 401)

r = requests.get(f"{API}/download/report/1", timeout=5)
check("GET /download/report/:id (no auth) → 401", r.status_code == 401)

r = requests.get(f"{WEB}/", allow_redirects=False, timeout=5)
check("GET /web/ (no auth) → 302 redirect", r.status_code == 302)
check("redirect to /web/login", "/web/login" in r.headers.get("Location", ""))

# ──────────────────────────────────────────────────
# 4. Login / Logout
# ──────────────────────────────────────────────────
section("4. Login & Session")

s = requests.Session()

# 4a. Wrong password
r = s.post(f"{WEB}/login", json={"username": "admin", "password": "wrong"}, timeout=5)
check("POST /web/login (wrong pwd) → 401", r.status_code == 401)
check("error message", r.json().get("success") is False)

# 4b. Wrong username
r = s.post(f"{WEB}/login", json={"username": "nobody", "password": "x"}, timeout=5)
check("POST /web/login (wrong user) → 401", r.status_code == 401)

# 4c. Correct login
r = s.post(f"{WEB}/login", json=CREDS, timeout=5)
check("POST /web/login (correct) → 200", r.status_code == 200)
check("success=true", r.json().get("success") is True)
check("auth_token cookie set", "auth_token" in s.cookies.get_dict())
s.headers.update({"X-CSRF-Token": s.cookies.get("csrf_token", "")})

# 4d. Login page redirects when already logged in
r = s.get(f"{WEB}/login", allow_redirects=False, timeout=5)
check("GET /web/login (logged in) → 302", r.status_code == 302)

# 4e. Logout
r = s.post(f"{WEB}/logout", timeout=5)
check("POST /web/logout → 200", r.status_code == 200)
check("success=true", r.json().get("success") is True)

# 4f. After logout — protected route fails
r = s.get(f"{API}/crash-groups", timeout=5)
check("GET /crash-groups (after logout) → 401", r.status_code == 401)

# ──────────────────────────────────────────────────
# 5. Protected routes — with auth
# ──────────────────────────────────────────────────
section("5. Protected Routes — Authenticated")

s2 = requests.Session()
s2.post(f"{WEB}/login", json=CREDS, timeout=5)
s2.headers.update({"X-CSRF-Token": s2.cookies.get("csrf_token", "")})

# 5a. Crash groups list
r = s2.get(f"{API}/crash-groups", timeout=5)
check("GET /crash-groups → 200", r.status_code == 200)
data = r.json()
check("has items array", "items" in data)
check("has total", "total" in data and data["total"] > 0)
check("has page/page_size", "page" in data and "page_size" in data)

# 5b. Crash groups with filters
r = s2.get(f"{API}/crash-groups?status=open&page_size=5&runtime=unity&sort_by=total_count", timeout=5)
check("GET /crash-groups (filtered) → 200", r.status_code == 200)

# 5c. Crash group detail
r = s2.get(f"{API}/crash-groups/{gid}", timeout=5)
check(f"GET /crash-groups/{gid} → 200", r.status_code == 200)
data = r.json()
check("has recent_reports", "recent_reports" in data)
check("has exception_type", "exception_type" in data)

# 5d. Crash group detail — invalid id
r = s2.get(f"{API}/crash-groups/99999", timeout=5)
check("GET /crash-groups/99999 → 404", r.status_code == 404)

# 5e. Update group status
r = s2.put(f"{API}/crash-groups/{gid}/status", json={
    "status": "resolved",
    "resolved_version": "1.0.1"
}, timeout=5)
check(f"PUT /crash-groups/{gid}/status → 200", r.status_code == 200)
check("success=true (status update)", r.json().get("success") is True)

# Verify status changed
r = s2.get(f"{API}/crash-groups/{gid}", timeout=5)
check("status = resolved", r.json().get("status") == "resolved")

# Reset status
s2.put(f"{API}/crash-groups/{gid}/status", json={"status": "open"}, timeout=5)

# 5f. Invalid status value
r = s2.put(f"{API}/crash-groups/1/status", json={"status": "invalid"}, timeout=5)
check("PUT /crash-groups/1/status (invalid) → 400", r.status_code == 400)

# 5g. Crash reports list
r = s2.get(f"{API}/crash-reports", timeout=5)
check("GET /crash-reports → 200", r.status_code == 200)

# 5h. Crash report detail
r = s2.get(f"{API}/crash-reports/{rid}", timeout=5)
check(f"GET /crash-reports/{rid} → 200", r.status_code == 200)
data = r.json()
check("has attachments array", "attachments" in data)
check("has stack_trace", "stack_trace" in data)

# 5i. Dashboard stats
r = s2.get(f"{API}/stats/dashboard", timeout=5)
check("GET /stats/dashboard → 200", r.status_code == 200)
data = r.json()
check("has total_crashes", "total_crashes" in data)

# 5j. Platforms list
r = s2.get(f"{API}/platforms", timeout=5)
check("GET /platforms → 200", r.status_code == 200)
check("is array", isinstance(r.json(), list))

# 5k. Versions list
r = s2.get(f"{API}/versions", timeout=5)
check("GET /versions → 200", r.status_code == 200)
check("is array", isinstance(r.json(), list))

# 5l. Player feedback management
r = s2.get(f"{API}/player-feedback", timeout=5)
check("GET /player-feedback → 200", r.status_code == 200)
check("player feedback list contains item", any(item["id"] == feedback_id for item in r.json().get("items", [])))

r = s2.get(f"{API}/player-feedback/{feedback_id}", timeout=5)
check(f"GET /player-feedback/{feedback_id} → 200", r.status_code == 200)
check("player feedback has description", r.json().get("description") == "The Equip button does nothing after I buy the sword from the shop.")

r = s2.put(f"{API}/player-feedback/{feedback_id}/status", json={"status": "in_progress"}, timeout=5)
check(f"PUT /player-feedback/{feedback_id}/status → 200", r.status_code == 200)

r = s2.get(f"{API}/player-feedback/{feedback_id}", timeout=5)
check("player feedback status updated", r.json().get("status") == "in_progress")


# ──────────────────────────────────────────────────
# 6. Downloads (authenticated)
# ──────────────────────────────────────────────────
section("6. Downloads")

# 6a. Download report JSON
r = s2.get(f"{API}/download/report/{rid}", timeout=5)
check(f"GET /download/report/{rid} → 200", r.status_code == 200)
check("content-type is json", "json" in r.headers.get("Content-Type", ""))
check("content-disposition set", "attachment" in r.headers.get("Content-Disposition", ""))

# 6b. Download group JSON
r = s2.get(f"{API}/download/group/{gid}", timeout=5)
check(f"GET /download/group/{gid} → 200", r.status_code == 200)

# 6c. Download dump info JSON
r = s2.get(f"{API}/download/dump/{rid}", timeout=5)
check(f"GET /download/dump/{rid} → 200", r.status_code == 200)

# 6d. Download non-existent report
r = s2.get(f"{API}/download/report/99999", timeout=5)
check("GET /download/report/99999 → 404", r.status_code == 404)

# 6e. Download attachment (non-existent)
r = s2.get(f"{API}/download/attachment/99999", timeout=5)
check("GET /download/attachment/99999 → 404", r.status_code == 404)

# 6f. Export crash group
r = s2.get(f"{API}/export/group/{gid}", timeout=10)
check(f"GET /export/group/{gid} → 200", r.status_code == 200)
check("content-type is gzip", "gzip" in r.headers.get("Content-Type", ""))

# 6g. Import crash package (dry-run)
r = s2.post(f"{API}/import?confirm=false", files={
    "package": ("test.crashpkg", r.content, "application/gzip"),
}, timeout=10)
check("POST /import (dry-run) → 200", r.status_code == 200)
check("dry_run is true", r.json().get("dry_run") is True)

# 6h. Import crash package (dry-run, no confirm param)
r = s2.post(f"{API}/import", files={
    "package": ("test.crashpkg", b"invalid_gzip_data", "application/gzip"),
}, timeout=10)
check("POST /import (bad package) → 400", r.status_code == 400)

# ──────────────────────────────────────────────────
# 7. Symbols (authenticated)
# ──────────────────────────────────────────────────
section("7. Symbols")

# 7a. List symbols
r = s2.get(f"{API}/symbols", timeout=5)
check("GET /symbols → 200", r.status_code == 200)

# 7b. Upload symbol (fake file)
r = s2.post(f"{API}/symbols", files={
    "file": ("libil2cpp.sym", b"FAKE_SYMBOL_DATA\0xff\0x00\nmodule: libil2cpp.so\n0x1000 function1\n0x2000 function2\n", "application/octet-stream"),
}, data={
    "platform": "Android",
    "build_guid": "deadbeef1234",
}, timeout=5)
check("POST /symbols → 201", r.status_code == 201)
data = r.json()
sym_id = data.get("id")
check("has id", sym_id is not None)

# 7c. Download symbol file
r = s2.get(f"{API}/symbols/{sym_id}/download", timeout=10)
check(f"GET /symbols/{sym_id}/download → 200", r.status_code == 200)
check("file content contains FAKE_SYMBOL_DATA", b"FAKE_SYMBOL_DATA" in r.content)
check("content-disposition set", "attachment" in r.headers.get("Content-Disposition", ""))

# 7d. Download non-existent symbol
r = s2.get(f"{API}/symbols/99999/download", timeout=5)
check("GET /symbols/99999/download → 404", r.status_code == 404)

# 7e. Delete non-existent symbol
r = s2.delete(f"{API}/symbols/99999", timeout=5)
check("DELETE /symbols/99999 → 404", r.status_code == 404)

# 7f. Delete the symbol we uploaded
r = s2.delete(f"{API}/symbols/{sym_id}", timeout=5)
check(f"DELETE /symbols/{sym_id} → 200", r.status_code == 200)

# Verify deletion
r = s2.get(f"{API}/symbols/{sym_id}/download", timeout=5)
check(f"GET /symbols/{sym_id}/download (after delete) → 404", r.status_code == 404)

# ──────────────────────────────────────────────────
# 8. Web HTML pages (authenticated)
# ──────────────────────────────────────────────────
section("8. Web Page Responses")

# 8a. Dashboard
r = s2.get(f"{WEB}/", timeout=5)
check("GET /web/ → 200 (html)", r.status_code == 200 and "html" in r.headers.get("Content-Type", ""))

# 8b. Crash list
r = s2.get(f"{WEB}/crashes", timeout=5)
check("GET /web/crashes → 200 (html)", r.status_code == 200 and "html" in r.headers.get("Content-Type", ""))

# 8c. Crash detail
r = s2.get(f"{WEB}/crashes/{gid}", timeout=5)
check(f"GET /web/crashes/{gid} → 200 (html)", r.status_code == 200 and "html" in r.headers.get("Content-Type", ""))

# 8d. Player feedback page
r = s2.get(f"{WEB}/feedback", timeout=5)
check("GET /web/feedback → 200 (html)", r.status_code == 200 and "html" in r.headers.get("Content-Type", ""))

# 8e. Symbols page
r = s2.get(f"{WEB}/symbols", timeout=5)
check("GET /web/symbols → 200 (html)", r.status_code == 200 and "html" in r.headers.get("Content-Type", ""))

# 8f. API docs
r = s2.get(f"{WEB}/api-doc", timeout=5)
check("GET /web/api-doc → 200 (html)", r.status_code == 200 and "html" in r.headers.get("Content-Type", ""))

# 8f. Login page (standalone — full window, no sidebar)
r = requests.get(f"{WEB}/login", timeout=5)
check("GET /web/login → 200 (html)", r.status_code == 200 and "html" in r.headers.get("Content-Type", ""))
html = r.text
check("login page is full-window standalone", html.count("min-h-screen") >= 1 and "<html" in html)

# ──────────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────────
total = ok + fail
print(f"\n{'='*60}")
print(f"  RESULTS:  {ok}/{total} passed", end="")
if fail > 0:
    print(f"  —  {fail} FAILED")
else:
    print("  ✓ all passed!")
print(f"{'='*60}")
sys.exit(0 if fail == 0 else 1)
