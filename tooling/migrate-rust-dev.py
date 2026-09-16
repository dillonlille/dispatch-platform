#!/usr/bin/env python3
"""Explicit, recoverable Dev-only fresh-state cutover from the Node core to Rust."""
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import sqlite3
import subprocess
import tempfile
import urllib.request

spec = importlib.util.spec_from_file_location("update_dev", Path(__file__).with_name("update-dev.py"))
updates = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updates)


def read_environment(filename):
    result = {}
    for line in filename.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, value = line.split("=", 1)
        updates.require(key.replace("_", "").isalnum(), "Invalid environment key")
        # setup-dev writes JSON strings compatible with systemd EnvironmentFile.
        result[key] = json.loads(value) if value.startswith('"') else value
    return result


def remove_directory(path):
    updates.require(not path.is_symlink() and path.resolve() == path.absolute(), "Unsafe reset path")
    if path.exists():
        shutil.rmtree(path)


class FreshRustUpdater(updates.DevUpdater):
    def __init__(self, root):
        super().__init__(root)
        self.reset_receipt = self.runtime / "rust-reset-receipt.json"
        self.rollback = self.runtime / "rust-reset-rollback"
        self.fresh = self.runtime / "rust-fresh-state"
        self.unit = Path.home() / ".config/systemd/user/dispatch-dev.service"

    def timer(self, operation):
        updates.command("systemctl", "--user", operation, "dispatch-dev-update.timer")

    def reload_units(self):
        updates.command("systemctl", "--user", "daemon-reload")

    def write_unit(self, text):
        updates.require(self.unit.resolve() == self.unit.absolute() and self.unit.is_file(),
                        "Expected installed Dev service unit")
        fd, name = tempfile.mkstemp(prefix="dispatch-dev-rust-", dir=self.unit.parent)
        temporary = Path(name)
        try:
            with os.fdopen(fd, "w") as output:
                output.write(text)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.unit)
        finally:
            temporary.unlink(missing_ok=True)
        self.reload_units()

    def verify_fresh(self, environment, email, password):
        origin = environment["DISPATCH_ORIGIN"]
        endpoint = self.config["healthUrl"].removesuffix("/api/health")
        headers = {"Origin": origin, "Content-Type": "application/json"}

        def request(route, body=None):
            payload = json.dumps(body).encode() if body is not None else None
            req = urllib.request.Request(endpoint + route, data=payload, headers=headers)
            with urllib.request.urlopen(req, timeout=15) as response:
                return json.load(response), response.headers

        _, response_headers = request("/api/auth/login", {"email": email, "password": password})
        headers["Cookie"] = response_headers["Set-Cookie"].split(";", 1)[0]
        try:
            session, _ = request("/api/session")
            updates.require(session["user"]["email"] == email and len(session["dsps"]) == 1,
                            "Fresh owner and Dev DSP verification failed")
            dsp = session["dsps"][0]
            updates.require(dsp["permanent"] and dsp["environment"] == "preview", "Fresh Dev DSP required")
            headers["X-CSRF-Token"] = session["csrf"]
            view, _ = request("/api/session/dsp", {"dspId": dsp["id"]})
            headers["X-Dispatch-View"] = view["token"]
            employees, _ = request("/api/dsp/employees")
            connection, _ = request("/api/dsp/connections")
            jobs, _ = request("/api/dsp/jobs")
            updates.require(employees["total"] == 0 and not connection["enabled"] and jobs == [],
                            "Fresh Dev contains unexpected platform data")
        finally:
            if "X-CSRF-Token" in headers:
                request("/api/auth/logout", {})

    def recover_reset(self):
        if not self.reset_receipt.exists():
            return
        record = json.loads(self.reset_receipt.read_text())
        updates.require(record["format"] == 1 and record["root"] == str(self.root), "Invalid reset receipt")
        self.clean_checkout()
        updates.require(self.git("rev-parse", "HEAD") in (record["oldCommit"], record["commit"]),
                        "Checkout changed since fresh-state cutover")
        if record.get("phase") == "preparing":
            remove_directory(self.rollback)
            remove_directory(self.fresh)
            self.reset_receipt.unlink()
            return
        if record.get("complete"):
            # A crash during cleanup must not resurrect data already retired successfully.
            remove_directory(self.rollback)
            remove_directory(self.fresh)
            remove_directory(self.runtime / "previous")
            if record["timerActive"]:
                self.timer("start")
            self.reset_receipt.unlink()
            return
        self.timer("stop")
        self.service("stop")
        for area in ("data", "dsps"):
            old = self.rollback / area
            if old.exists():
                remove_directory(self.root / area)
                old.rename(self.root / area)
        if (self.rollback / "artifact").exists():
            remove_directory(self.live / ".build")
            (self.rollback / "artifact").rename(self.live / ".build")
        if (self.rollback / "initial-owner.json").exists():
            os.replace(self.rollback / "initial-owner.json", self.root / "config/initial-owner.json")
        self.git("reset", "--hard", record["oldCommit"])
        if (self.rollback / "service.unit").exists():
            self.write_unit((self.rollback / "service.unit").read_text())
        self.service("start")
        updates.require(self.healthy(record["oldDigest"]), "Previous Dev failed recovery health check")
        self.status("rolled_back", record["oldCommit"])
        remove_directory(self.rollback)
        remove_directory(self.fresh)
        if record["timerActive"]:
            self.timer("start")
        self.reset_receipt.unlink()

    def activate(self, candidate, commit):
        manifest = updates.verify_artifact(candidate, commit)
        self.clean_checkout()
        current = self.git("rev-parse", "HEAD")
        old = updates.verify_artifact(self.live / ".build", current)
        updates.require(old["format"] == 1 and old["schema"] == 2 and
                        manifest["format"] in (2, 3) and manifest["schema"] == 3,
                        "Fresh cutover requires the Node v2 state and Rust v3 artifact")
        self.git("merge-base", "--is-ancestor", current, commit)
        self.git("merge-base", "--is-ancestor", commit, "origin/dev")
        updates.require(not self.reset_receipt.exists() and not self.rollback.exists() and
                        not self.fresh.exists(), "Recover the previous fresh cutover first")
        for area in (self.root / "data", self.root / "dsps", self.root / "config"):
            updates.require(area.is_dir() and area.resolve() == area.absolute() and
                            area.stat().st_uid == os.getuid(), "Unsafe Dev state boundary")
        environment = read_environment(self.root / "config/platform.env")
        updates.require(environment.get("DISPATCH_STATE_ROOT") == str(self.root) and
                        environment.get("DISPATCH_ENVIRONMENT") == "preview" and
                        environment.get("DISPATCH_STANDALONE") == "1", "Independent Dev configuration required")
        owner = json.loads((self.root / "config/initial-owner.json").read_text())
        with sqlite3.connect(f"file:{self.platform / 'accounts.sqlite'}?mode=ro", uri=True) as db:
            identity = db.execute("SELECT email,first_name,last_name FROM users WHERE email=? AND platform_owner=1 AND status='active'", (owner["email"],)).fetchone()
        updates.require(identity, "Initial Dev owner identity unavailable")
        email, first, last = identity
        password = secrets.token_urlsafe(30)
        binary = candidate / "services/rust/dispatch-backend"
        binary.chmod(0o700)
        timer_active = subprocess.run(["systemctl", "--user", "is-active", "--quiet",
                                       "dispatch-dev-update.timer"], check=False).returncode == 0
        record = {"format": 1, "root": str(self.root), "commit": commit, "oldCommit": current,
                  "oldDigest": old["digest"], "timerActive": timer_active,
                  "complete": False, "phase": "preparing"}
        updates.write_json(self.reset_receipt, record)
        try:
            updates.private_directory(self.fresh)
            subprocess.run([str(binary), "bootstrap", email, first, last], input=password + "\n",
                           text=True, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           env={**os.environ, **environment, "DISPATCH_STATE_ROOT": str(self.fresh),
                                "DISPATCH_ARTIFACT_ROOT": str(candidate)}, cwd=candidate)
            updates.private_directory(self.rollback)
            shutil.copyfile(self.root / "config/initial-owner.json", self.rollback / "initial-owner.json")
            (self.rollback / "initial-owner.json").chmod(0o600)
            (self.rollback / "service.unit").write_text(self.unit.read_text())
            record["phase"] = "swapping"
            updates.write_json(self.reset_receipt, record)
            self.timer("stop")
            self.service("stop")
            self.clean_checkout()
            updates.require(self.git("rev-parse", "HEAD") == current, "Checkout changed during cutover")
            for area in ("data", "dsps"):
                (self.root / area).rename(self.rollback / area)
                (self.fresh / area).rename(self.root / area)
            (self.live / ".build").rename(self.rollback / "artifact")
            candidate.rename(self.live / ".build")
            self.git("merge", "--ff-only", commit)
            unit = self.git("show", f"{commit}:tooling/systemd/dispatch-dev.service") + "\n"
            updates.require("ExecStart=%h/dispatch-platform/dev/live/.build/services/rust/dispatch-backend serve" in unit,
                            "Direct Rust service unit required")
            self.write_unit(unit)
            self.service("start")
            updates.require(self.healthy(manifest["digest"]), "Rust Dev failed health check")
            self.verify_fresh(environment, email, password)
            updates.write_json(self.root / "config/initial-owner.json", {"email": email, "password": password, "url": environment["DISPATCH_ORIGIN"]})
            self.status("ready", commit)
            record["complete"] = True
            updates.write_json(self.reset_receipt, record)
            remove_directory(self.rollback)
            remove_directory(self.fresh)
            # Old code cannot serve the new credential format; retain only Rust rollback artifacts.
            remove_directory(self.runtime / "previous")
            if timer_active:
                self.timer("start")
            self.reset_receipt.unlink()
            print(f"Rust Dev ready at {commit}. Fresh owner login: {self.root / 'config/initial-owner.json'}")
        except BaseException:
            self.recover_reset()
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--reset-data", action="store_true", help="Discard existing Dev data after verified Rust startup")
    action.add_argument("--recover", action="store_true", help="Recover an interrupted fresh-state cutover")
    args = parser.parse_args()
    os.umask(0o077)
    updater = FreshRustUpdater(args.root)
    # Outside data/: this lock and recovery receipt survive replacement of platform state.
    with (updater.runtime / "rust-reset.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        updater.recover_reset()
        if args.reset_data:
            with (updater.platform / "dev-update.lock").open("a") as update_lock:
                fcntl.flock(update_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                updater.update()


if __name__ == "__main__":
    main()
