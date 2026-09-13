"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const assert = require("node:assert/strict");
const ROOT = "/work",
  LOCAL = "/home/dispatchlab/local",
  UID = 1001,
  RELEASE = "dispatch_current_1";
const run = (file, args, options = {}) =>
  execFileSync(file, args, { stdio: "inherit", timeout: 900000, ...options });
const write = (file, value, mode = 0o600, uid = 0) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  require("../../src/release-delivery-files").atomic(file, value, mode);
  fs.chmodSync(file, mode);
  fs.chownSync(file, uid, uid);
};
const hash = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
async function main() {
  assert.equal(os.hostname(), "dispatch-dsp-lab");
  assert.equal(process.geteuid(), 0);
  assert.equal(fs.existsSync("/etc/dispatch"), false);
  if (!process.argv.includes("--skip-packages")) {
    run("/usr/bin/apt-get", ["update"]);
    run("/usr/bin/apt-get", [
      "install",
      "-y",
      "--no-install-recommends",
      "restic",
      "patchelf",
      "sudo",
      "dbus-user-session",
      "apparmor-utils",
      "libnss3",
      "libatk-bridge2.0-0t64",
      "libx11-xcb1",
      "libxcomposite1",
      "libxdamage1",
      "libxrandr2",
      "libgbm1",
      "libasound2t64",
      "libcups2t64",
      "libgtk-3-0t64",
      "fonts-liberation",
    ]);
  }
  run("/usr/sbin/groupadd", ["--gid", String(UID), "dispatchlab"]);
  run("/usr/sbin/useradd", [
    "--uid",
    String(UID),
    "--gid",
    String(UID),
    "--create-home",
    "dispatchlab",
  ]);
  run("/usr/sbin/useradd", [
    "--system",
    "--user-group",
    "--no-create-home",
    "--shell",
    "/usr/sbin/nologin",
    "dispatchhelper",
  ]);
  const helperUid = Number(
    execFileSync("/usr/bin/id", ["-u", "dispatchhelper"]).toString().trim(),
  );
  const helperGid = Number(
    execFileSync("/usr/bin/id", ["-g", "dispatchhelper"]).toString().trim(),
  );
  for (const child of [
    "data",
    "state/provisioner",
    "config",
    "secrets/oci-runtime-agents",
    "run",
    "installations",
    "backups",
    "logs",
  ])
    fs.mkdirSync(path.join(LOCAL, child), { recursive: true, mode: 0o700 });
  const units = "/home/dispatchlab/.config/systemd/user";
  fs.mkdirSync(units, { recursive: true, mode: 0o700 });
  for (const [directory, mode] of [
    ["/etc/dispatch", 0o755],
    ["/var/lib/dispatch/tenants", 0o755],
    ["/run/dispatch-runtime-agents", 0o711],
    ["/var/lib/dispatch-host/state", 0o700],
    ["/var/lib/dispatch-host/authority", 0o700],
    ["/var/lib/dispatch-backup", 0o700],
    ["/var/lib/dispatch-backup-receipts", 0o755],
    ["/srv/dispatch-lab-remote", 0o700],
  ]) {
    fs.mkdirSync(directory, { recursive: true, mode });
    fs.chmodSync(directory, mode);
  }
  const runtime = `/opt/dispatch-runtime/releases/${RELEASE}`,
    core = `/opt/dispatch-platform/releases/${RELEASE}/core-artifact`,
    control = `/opt/dispatch-control/releases/${RELEASE}`;
  for (const directory of [runtime, core, control])
    fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
  const original = JSON.parse(fs.readFileSync("/root/descriptor.json"));
  require("../../src/native-runtime-artifact").unpackNativeRuntime(
    "/root/runtime.tar.gz",
    runtime + "/runtime-artifact",
    original,
  );
  // Only this disposable package contains the fixed synthetic data/collector fixture.
  const artifact = runtime + "/runtime-artifact";
  const add = (relative, source, executable = false) =>
    write(
      artifact + "/" + relative,
      fs
        .readFileSync(source, "utf8")
        .replaceAll(
          "/usr/local/bin/node",
          "/opt/dispatch/dependencies/node/bin/node",
        ),
      executable ? 0o555 : 0o444,
    );
  add(
    "fixture-seed.js",
    "/work/plugins/paycom/backend/tests/oci-lifecycle-seed.js",
  );
  add(
    "fixture-collector",
    "/work/runtime/collection-manager/tests/fixture-collector.js",
    true,
  );
  add(
    "plugins/paycom/backend/tests/helpers.js",
    "/work/plugins/paycom/backend/tests/helpers.js",
  );
  const inventory = [];
  const walk = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const f = path.join(directory, name),
        stat = fs.statSync(f);
      if (stat.isDirectory()) walk(f);
      else if (path.relative(artifact, f) !== "runtime-release-manifest.json")
        inventory.push({
          path: path.relative(artifact, f),
          mode: (stat.mode & 0o777).toString(8),
          size: stat.size,
          sha256: hash(f),
        });
    }
    fs.chmodSync(directory, 0o555);
  };
  walk(artifact);
  write(
    artifact + "/runtime-release-manifest.json",
    {
      schemaVersion: 1,
      backend: "native_service_v1",
      sourceCommit: original.sourceCommit,
      platform: "linux/amd64",
      files: inventory,
    },
    0o444,
  );
  run("/usr/bin/python3", [
    "-I",
    "/work/core/installations/src/native-runtime-archive.py",
    "pack",
    artifact,
    "/root/lab-runtime.tar.gz",
  ]);
  require("../../src/create-bridge-artifact").main([
    runtime + "/bridge-artifact",
  ]);
  require("../../src/create-host-helper-artifact").main([
    control + "/host-helper-artifact",
  ]);
  require("../../src/release-delivery-install").seal(control);
  fs.symlinkSync(control, "/opt/dispatch-control/current");
  require("../../src/release-delivery-install").installBrowserSandboxProfile();
  const release = {
    ...original,
    releaseId: RELEASE,
    channel: "production",
    artifactSha256: hash("/root/lab-runtime.tar.gz"),
    embeddedManifestSha256: hash(artifact + "/runtime-release-manifest.json"),
  };
  // Host verification reads the exact immutable package prepared above.
  fs.copyFileSync("/root/lab-runtime.tar.gz", runtime + "/runtime.tar.gz");
  fs.chmodSync(runtime + "/runtime.tar.gz", 0o444);
  require("../../src/release-delivery-install").seal(runtime);
  fs.cpSync(ROOT, core + "/code", { recursive: true });
  const immutable = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, entry.name);
      if (entry.isDirectory()) immutable(f);
      else fs.chmodSync(f, fs.statSync(f).mode & 0o111 ? 0o555 : 0o444);
    }
    fs.chmodSync(d, 0o555);
  };
  immutable(core + "/code");
  require("../../src/core-artifact-layout").finishCoreArtifact(core, {
    releaseId: RELEASE,
    version: "lab",
    sourceCommit: original.sourceCommit,
    localRoot: LOCAL,
    unitRoot: units,
    publicOrigin: "https://dispatch.example.test",
    port: 4310,
  });
  const helper =
      control +
      "/host-helper-artifact/core/installations/bin/dispatch-oci-host-helper",
    issuer =
      control +
      "/host-helper-artifact/core/installations/bin/dispatch-oci-host-issuer";
  write("/etc/dispatch/oci-host.json", {
    stateRoot: "/var/lib/dispatch-host/state",
    authorityRoot: "/var/lib/dispatch-host/authority",
    unitRoot: "/etc/systemd/system",
    releaseRoot: "/opt/dispatch-runtime/releases",
    centralSocket: LOCAL + "/run/runtime-agent-hub.sock",
    centralUid: UID,
    controllerUid: 0,
    authorityUid: UID,
    helperCallerUid: helperUid,
    helperCallerGid: helperGid,
    controlReleaseId: RELEASE,
    helperManifestSha256: hash(control + "/host-helper-artifact/manifest.json"),
  });
  for (const [name, executable] of [
    ["dispatchlab", issuer],
    ["dispatchhelper", helper],
  ])
    write(
      "/etc/sudoers.d/dispatch-lab-" + name,
      `Defaults:${name} env_reset,!setenv,secure_path="/usr/bin:/bin"\nDefaults:${name} env_delete += "NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH"\n${name} ALL=(root) NOPASSWD: NOSETENV: ${executable} ""\n`,
      0o440,
    );
  write(
    LOCAL + "/config/oci-releases.json",
    { schemaVersion: 1, releases: { [RELEASE]: release } },
    0o600,
    UID,
  );
  const env = {
    DISPATCH_LOCAL_ROOT: LOCAL,
    DISPATCH_ACCESS_CONTROL_DATABASE_ROOT: LOCAL + "/data/access-control",
    DISPATCH_PROVISIONER_STATE_ROOT: LOCAL + "/state/provisioner",
    DISPATCH_INSTALLATIONS_ROOT: LOCAL + "/installations",
    DISPATCH_SYSTEMD_UNIT_ROOT: units,
    DISPATCH_RUNTIME_AGENT_HUB_SOCKET: LOCAL + "/run/runtime-agent-hub.sock",
    DISPATCH_RUNTIME_AGENT_CONTROL_SOCKET:
      LOCAL + "/run/runtime-agent-control.sock",
    DISPATCH_OCI_RELEASE_CATALOG_FILE: LOCAL + "/config/oci-releases.json",
    DISPATCH_OCI_RUNTIME_AGENT_CREDENTIAL_ROOT:
      LOCAL + "/secrets/oci-runtime-agents",
  };
  write(
    LOCAL + "/config/provisioning.env",
    Object.entries(env)
      .map(([k, v]) => k + "=" + v)
      .join("\n") + "\n",
    0o600,
    UID,
  );
  write("/root/lab-config.json", {
    localRoot: LOCAL,
    coreUid: UID,
    release,
    environment: env,
  });
  write(
    "/etc/dispatch/offsite-backup-password",
    crypto.randomBytes(32).toString("hex"),
  );
  write(
    "/etc/dispatch/offsite-backup-policy.json",
    { schemaVersion: 1, required: true },
    0o644,
  );
  run("/usr/bin/chown", ["-R", `${UID}:${UID}`, "/home/dispatchlab"]);
  run("/usr/sbin/runuser", [
    "--user",
    "dispatchlab",
    "--",
    "/usr/bin/env",
    ...Object.entries(env).map(([k, v]) => k + "=" + v),
    "/usr/bin/node",
    "--no-warnings",
    ROOT + "/core/installations/tests/native-lab/bootstrap.js",
  ]);
  const code = core + "/code";
  write(
    units + "/dispatch-dashboard.service",
    `[Unit]\nDescription=Dispatch acceptance dashboard\n[Service]\nEnvironmentFile=${LOCAL}/config/provisioning.env\nExecStart=/usr/bin/node --no-warnings ${code}/core/installations/tests/native-lab/dashboard.js\nRestart=always\nRestartSec=3\nUMask=0077\n[Install]\nWantedBy=default.target\n`,
    0o600,
    UID,
  );
  write(
    units + "/dispatch-installation-reconcile.service",
    `[Service]\nType=oneshot\nEnvironmentFile=${LOCAL}/config/provisioning.env\nExecStart=/usr/bin/node --no-warnings ${code}/core/installations/bin/dispatch-installation-reconcile\nTimeoutStartSec=30min\nUMask=0077\n`,
    0o600,
    UID,
  );
  write(
    "/etc/systemd/system/dispatch-offsite-backup.service",
    `[Service]\nExecStart=/usr/bin/node --no-warnings ${code}/core/installations/tests/native-lab/offsite.js\nRestart=always\nRestartSec=3\nUMask=0077\n[Install]\nWantedBy=multi-user.target\n`,
    0o644,
  );
  run("/usr/bin/loginctl", ["enable-linger", "dispatchlab"]);
  run("/usr/bin/systemctl", ["start", `user@${UID}.service`]);
  run("/usr/bin/systemctl", ["daemon-reload"]);
  run("/usr/bin/systemctl", [
    "enable",
    "--now",
    "dispatch-offsite-backup.service",
  ]);
  run("/usr/sbin/runuser", [
    "--user",
    "dispatchlab",
    "--",
    "/usr/bin/env",
    `XDG_RUNTIME_DIR=/run/user/${UID}`,
    "/usr/bin/systemctl",
    "--user",
    "daemon-reload",
  ]);
  run("/usr/sbin/runuser", [
    "--user",
    "dispatchlab",
    "--",
    "/usr/bin/env",
    `XDG_RUNTIME_DIR=/run/user/${UID}`,
    "/usr/bin/systemctl",
    "--user",
    "enable",
    "--now",
    "dispatch-dashboard.service",
  ]);
  run("/usr/bin/sync", []);
  console.log("native_lab_ready");
}
main().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
