import os
import sys
import tempfile
import time
import unittest

TEST_DATA_DIR = tempfile.mkdtemp(prefix="crash-security-tests-")
os.environ["DATA_DIR"] = TEST_DATA_DIR
os.environ["DB_PATH"] = os.path.join(TEST_DATA_DIR, "test.db")
os.environ["ADMIN_USERNAME"] = "admin"
os.environ["ADMIN_PASSWORD"] = "Test-Root-Password!123"
os.environ["API_REQUIRE_KEY"] = "true"
os.environ["COOKIE_SECURE"] = "false"

# The test suite intentionally uses the built server through HTTP. Start with:
#   npm run build
#   node dist/main.js
# Then run this module with BASE_URL set if needed.

import requests

BASE = os.environ.get("BASE_URL", "http://localhost:8080")


class SecurityIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.session = requests.Session()

    def csrf(self):
        return self.session.cookies.get("csrf_token", "")

    def login(self, username="admin", password="Test-Root-Password!123"):
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


if __name__ == "__main__":
    unittest.main()
