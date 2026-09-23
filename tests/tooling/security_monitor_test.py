import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("monitor", Path(__file__).resolve().parents[2] / "tooling/host/security-monitor.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MonitorTests(unittest.TestCase):
    def test_thresholds_expire_and_output_never_contains_payloads(self):
        monitor = module.Monitor()
        event = {"event": "http.request", "fields": {
            "route": "/api/auth/login", "status": 401, "account": "opaque-account",
            "password": "do-not-log", "client": "invalid address", "body": "private",
        }}
        for at in range(9):
            self.assertEqual(monitor.observe(event, at), [])
        alert = monitor.observe(event, 9)
        self.assertEqual(alert, [{"rule": "authentication_failures", "windowSeconds": 300, "account": "opaque-account"}])
        self.assertEqual(monitor.observe(event, 10), [])
        self.assertEqual(monitor.observe(event, 400), [])

    def test_bulk_reads_and_sensitive_changes(self):
        monitor = module.Monitor()
        event = {"event": "http.request", "fields": {"route": "/api/dsp/employees", "status": 200, "bulk": True, "actorId": "usr_test"}}
        for at in range(4):
            self.assertEqual(monitor.observe(event, at), [])
        self.assertEqual(monitor.observe(event, 4)[0]["rule"], "bulk_reads")
        event["fields"].update(route="/api/dsp/members/{id}", method="POST", bulk=False)
        self.assertEqual(monitor.observe(event, 5)[0]["rule"], "access_changed")


if __name__ == "__main__":
    unittest.main()
