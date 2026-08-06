import os
import sys
import tempfile
import time
import unittest

TEST_DATA_DIR = tempfile.mkdtemp(prefix="crash-security-tests-")
os.environ["DATA_DIR"] = TEST_DATA_DIR
os.environ["DB_PATH"] = os.path.join(TEST_DATA_DIR, "test.db")
os.environ["API_REQUIRE_KEY"] = "true"
os.environ["COOKIE_SECURE"] = "false"

# The test suite intentionally uses the built server through HTTP. Start with:
#   npm run build
#   node dist/main.js
# Then run this module with BASE_URL set if needed.

import requests

BASE = os.environ.get("BASE_URL", "http://localhost:8080")
ADMIN_USER = "admin"
ADMIN_PASS = "Test-Root-Password!123"


class SecurityIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.session = requests.Session()

    def csrf(self):
        return self.session.cookies.get("csrf_token", "")

    def _setup_admin(self):
        """Create the initial admin account via web setup if no users exist."""
        r = self.session.get(f"{BASE}/api/v1/auth/setup-status", timeout=5)
        if r.json().get("needs_setup"):
            resp = self.session.post(f"{BASE}/api/v1/auth/setup", json={
                "username": ADMIN_USER,
                "password": ADMIN_PASS,
            }, timeout=5)
            self.assertEqual(resp.status_code, 200, resp.text)

    def login(self, username=ADMIN_USER, password=ADMIN_PASS):
        self._setup_admin()
        return self.session.post(f"{BASE}/web/login", json={"username": username, "password": password}, timeout=5)

    def test_unauthenticated_management_api_rejected(self):
        response = requests.get(f"{BASE}/api/v1/crash-groups", timeout=5)
        self.assertEqual(response.status_code, 401)

    def test_ingestion_requires_api_key(self):
        response = requests.post(f"{BASE}/api/v1/crash-report", json={"exception_type": "Test"}, timeout=5)
        self.assertEqual(response.status_code, 401)

    def test_admin_can_create_user_and_viewer_cannot(self):
        self.assertEqual(self.login().status_code, 200)
        headers = {"X-CSRF-Token": self.csrf()}
        created = self.session.post(f"{BASE}/api/v1/auth/users", headers=headers, json={
            "username": f"viewer{int(time.time())}",
            "password": "Viewer-Password!123",
            "role": "viewer",
        }, timeout=5)
        self.assertEqual(created.status_code, 201, created.text)

        viewer = requests.Session()
        self.assertEqual(viewer.post(f"{BASE}/web/login", json={
            "username": created.json()["user"]["username"], "password": "Viewer-Password!123"
        }, timeout=5).status_code, 200)
        denied = viewer.post(f"{BASE}/api/v1/auth/users", headers={"X-CSRF-Token": viewer.cookies.get("csrf_token", "")}, json={
            "username": "forbidden-user", "password": "Another-Password!123", "role": "viewer"
        }, timeout=5)
        self.assertEqual(denied.status_code, 403)

        clear_denied = viewer.post(
            f"{BASE}/api/v1/clear-crashes",
            headers={"X-CSRF-Token": viewer.cookies.get("csrf_token", "")},
            timeout=5,
        )
        self.assertEqual(clear_denied.status_code, 403)

    def test_mutation_requires_csrf(self):
        self.assertEqual(self.login().status_code, 200)
        response = self.session.post(f"{BASE}/api/v1/auth/users", json={
            "username": "no-csrf", "password": "Strong-Password!123", "role": "viewer"
        }, timeout=5)
        self.assertEqual(response.status_code, 403)

    def test_api_key_limits_are_enforced_per_key(self):
        self.assertEqual(self.login().status_code, 200)
        headers = {"X-CSRF-Token": self.csrf()}

        minute_key = self.session.post(f"{BASE}/api/v1/auth/api-keys", headers=headers, json={
            "name": f"minute-limit-{time.time_ns()}",
            "minute_limit": 1,
            "daily_limit": 0,
        }, timeout=5)
        self.assertEqual(minute_key.status_code, 201, minute_key.text)
        minute_headers = {"X-API-Key": minute_key.json()["key"]}
        first_minute = requests.post(f"{BASE}/api/v1/crash-report", headers=minute_headers, json={"exception_type": "MinuteLimit"}, timeout=5)
        second_minute = requests.post(f"{BASE}/api/v1/crash-report", headers=minute_headers, json={"exception_type": "MinuteLimit"}, timeout=5)
        self.assertEqual(first_minute.status_code, 201, first_minute.text)
        self.assertEqual(second_minute.status_code, 429, second_minute.text)

        daily_key = self.session.post(f"{BASE}/api/v1/auth/api-keys", headers=headers, json={
            "name": f"daily-limit-{time.time_ns()}",
            "minute_limit": 0,
            "daily_limit": 1,
        }, timeout=5)
        self.assertEqual(daily_key.status_code, 201, daily_key.text)
        daily_headers = {"X-API-Key": daily_key.json()["key"]}
        first_daily = requests.post(f"{BASE}/api/v1/crash-report", headers=daily_headers, json={"exception_type": "DailyLimit"}, timeout=5)
        second_daily = requests.post(f"{BASE}/api/v1/crash-report", headers=daily_headers, json={"exception_type": "DailyLimit"}, timeout=5)
        self.assertEqual(first_daily.status_code, 201, first_daily.text)
        self.assertEqual(second_daily.status_code, 429, second_daily.text)

        listed = self.session.get(f"{BASE}/api/v1/auth/api-keys", timeout=5)
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertTrue(any(key["minute_limit"] == 1 and key["daily_limit"] == 0 for key in listed.json()["items"]))
        self.assertTrue(any(key["minute_limit"] == 0 and key["daily_limit"] == 1 for key in listed.json()["items"]))


if __name__ == "__main__":
    unittest.main()
