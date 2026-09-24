#!/usr/bin/env python3
"""Consume sanitized Dispatch request events; emit bounded, content-free security alerts."""
import argparse
from collections import defaultdict, deque
import json
import re
import subprocess
import sys
import time


class Monitor:
    def __init__(self):
        self.windows = defaultdict(deque)

    def observe(self, event, now):
        if event.get("event") != "http.request":
            return []
        f = event.get("fields", {})
        route, status = f.get("route", ""), f.get("status", 0)
        if not isinstance(route, str) or not isinstance(status, int):
            return []
        # Never forward a message, URL, body, raw client address or arbitrary field.
        safe = {key: value for key in ("requestId", "actorId", "dspId", "account", "client")
                if isinstance(value := f.get(key), str) and re.fullmatch(r"[A-Za-z0-9_-]{1,80}", value)}
        alerts = []
        rules = []
        if route == "/api/auth/login" and status in (401, 403, 429):
            rules.append(("authentication_failures", safe.get("account", safe.get("client")), 10, 300))
        if route == "/api/dsp/members/invite" and status < 300:
            rules.append(("invitation_burst", safe.get("actorId"), 20, 3600))
        if f.get("bulk") is True and status < 300:
            rules.append(("bulk_reads", safe.get("actorId"), 5, 60))
        if f.get("method") == "POST" and status < 300 and route in (
            "/api/dsp/members/{id}", "/api/dsp/roles/{id}",
        ):
            alerts.append({"rule": "access_changed", **safe})
        # Fixed cardinality and event count keep abuse of the monitor itself bounded.
        for key in list(self.windows):
            if not self.windows[key] or self.windows[key][-1] < now - 3600:
                del self.windows[key]
        for rule, subject, limit, window in rules:
            if not subject:
                continue
            key = (rule, subject)
            if key not in self.windows and len(self.windows) >= 10000:
                continue
            events = self.windows[key]
            while events and events[0] <= now - window:
                events.popleft()
            if len(events) < limit:
                events.append(now)
                if len(events) == limit:
                    alerts.append({"rule": rule, "windowSeconds": window, **safe})
        return alerts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--journal", action="store_true", help="follow the Production system unit")
    args = parser.parse_args()
    child = subprocess.Popen(["journalctl", "--follow", "--lines=0", "--output=cat", "--unit=dispatch-production.service"],
                             stdout=subprocess.PIPE) if args.journal else None
    source = child.stdout if child else sys.stdin.buffer
    monitor = Monitor()
    try:
        while line := source.readline(65537):
            if len(line) > 65536:
                while line and not line.endswith(b"\n"):
                    line = source.readline(65537)
                continue
            try:
                event = json.loads(line)
                if not isinstance(event, dict):
                    continue
                for fields in monitor.observe(event, time.monotonic()):
                    print(json.dumps({"event": "security.alert", "fields": fields}), flush=True)
            except (ValueError, TypeError, AttributeError):
                continue
    finally:
        if child:
            child.terminate()
            child.wait(timeout=5)


if __name__ == "__main__":
    main()
