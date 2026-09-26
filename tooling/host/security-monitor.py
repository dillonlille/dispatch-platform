#!/usr/bin/env python3
"""Consume sanitized Dispatch request events; emit bounded, content-free security alerts."""
import argparse
from collections import defaultdict, deque
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request


class NoRedirects(urllib.request.HTTPRedirectHandler):
    """Never forward the alert bearer token to a redirected destination."""
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


def open_alert(request, timeout):
    return urllib.request.build_opener(NoRedirects).open(request, timeout=timeout)


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


class MailAlerts:
    """Deliver an allowlisted alert through the existing authenticated mail Worker."""
    def __init__(self, environment=None, open_url=open_alert):
        environment = os.environ if environment is None else environment
        self.url = environment.get("DISPATCH_SECURITY_ALERT_URL", "")
        self.token = environment.get("DISPATCH_SECURITY_ALERT_TOKEN", "")
        self.recipient = environment.get("DISPATCH_SECURITY_ALERT_TO", "")
        self.environment = environment.get("DISPATCH_ENVIRONMENT", "")
        self.origin = environment.get("DISPATCH_ORIGIN", "")
        endpoint = urllib.parse.urlsplit(self.url)
        origin = urllib.parse.urlsplit(self.origin)
        if not (
            endpoint.scheme == "https" and endpoint.hostname and endpoint.path == "/send"
            and not endpoint.username and not endpoint.password and not endpoint.query
            and not endpoint.fragment and len(self.token) >= 32
            and re.fullmatch(r"[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+", self.recipient)
            and self.environment in ("preview", "production")
            and origin.scheme == "https" and origin.netloc and origin.path in ("", "/")
            and not origin.query and not origin.fragment
        ):
            raise ValueError("invalid security alert configuration")
        self.open_url = open_url

    def deliver(self, fields):
        safe = {key: fields[key] for key in (
            "rule", "windowSeconds", "requestId", "actorId", "dspId", "account", "client"
        ) if key in fields}
        label = "Dev" if self.environment == "preview" else "Production"
        payload = json.dumps({
            "environment": self.environment,
            "origin": self.origin,
            "to": self.recipient,
            "subject": f"[Dispatch {label}] Security alert: {safe['rule']}",
            "text": "Dispatch detected a security event. Identifiers are opaque.\n\n"
                    + json.dumps(safe, sort_keys=True, separators=(",", ":")),
        }, separators=(",", ":")).encode()
        request = urllib.request.Request(self.url, data=payload, method="POST", headers={
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
            "User-Agent": "Dispatch-Security-Monitor/1.0",
        })
        with self.open_url(request, timeout=5) as response:
            if response.status != 200:
                raise OSError(f"alert endpoint returned {response.status}")
            response.read(1024)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--journal", action="store_true", help="follow the Production system unit")
    parser.add_argument("--mail-alerts", action="store_true",
                        help="send alerts through the configured authenticated mail Worker")
    args = parser.parse_args()
    child = subprocess.Popen(["journalctl", "--follow", "--lines=0", "--output=cat", "--unit=dispatch-production.service"],
                             stdout=subprocess.PIPE) if args.journal else None
    source = child.stdout if child else sys.stdin.buffer
    monitor = Monitor()
    alerts = MailAlerts() if args.mail_alerts else None
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
                    if alerts:
                        try:
                            alerts.deliver(fields)
                        except Exception as error:
                            # Never include the endpoint, token, address, payload, or response.
                            print(json.dumps({"event": "security.alert_delivery_failed", "fields": {
                                "rule": fields["rule"], "error": type(error).__name__
                            }}), file=sys.stderr, flush=True)
            except (ValueError, TypeError, AttributeError):
                continue
    finally:
        if child:
            child.terminate()
            child.wait(timeout=5)


if __name__ == "__main__":
    main()
