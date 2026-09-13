'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { configuration, CONFIG, TOKEN, STATE } = require('./release-delivery-config');
const { privateJson } = require('./release-delivery-files');
const { identity } = require('./release-delivery-contract');
const usage = 'dispatch-install check|setup|prepare|update|status [--config FILE] [--core FILE] [--version VERSION --commit SHA]';
function parse(argv) {
  const [action, ...args] = argv;
  if (!['check', 'setup', 'prepare', 'update', 'status'].includes(action)) throw Error(usage);
  const input = { action };
  for (let i = 0; i < args.length; i += 2) {
    const key = { '--config': 'config', '--core': 'core', '--version': 'version', '--commit': 'sourceCommit' }[args[i]];
    if (!key || input[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw Error(usage);
    input[key] = args[i + 1];
  }
  for (const key of ['config', 'core']) if (input[key] && (!path.isAbsolute(input[key]) || path.resolve(input[key]) !== input[key])) throw Error(usage);
  if (input.version || input.sourceCommit || ['prepare', 'update'].includes(action)) identity(input.version, input.sourceCommit);
  if (action === 'setup' && (!input.config || !input.core)) throw Error(usage);
  if (input.core && action !== 'setup' || input.config && !['setup', 'check'].includes(action)) throw Error(usage);
  return input;
}
function preflight(config, { exists = fs.existsSync, stat = fs.lstatSync, run = spawnSync, platform = process.platform, arch = process.arch } = {}) {
  const missing = [];
  if (platform !== 'linux' || arch !== 'x64') missing.push('linux_amd64_required');
  for (const file of ['/usr/bin/node', '/usr/bin/python3', '/usr/bin/systemctl', '/usr/bin/setpriv', '/usr/bin/flock', '/usr/sbin/visudo']) if (!exists(file)) missing.push(`missing:${file}`);
  const user = run('/usr/bin/getent', ['passwd', String(config.uid)], { encoding: 'utf8', timeout: 5000 });
  if (user.status !== 0 || Number(user.stdout.split(':')[3]) !== config.gid) missing.push('configured_service_account_required');
  for (const directory of [config.localRoot, config.unitRoot]) {
    if (!exists(directory)) missing.push(`missing:${directory}`);
    else { const value = stat(directory); if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== config.uid || value.mode & 0o022) missing.push(`unsafe:${directory}`); }
  }
  for (const filename of ['oci-releases.json', 'platform-releases.json', 'provisioning.env']) if (!exists(path.join(config.localRoot, 'config', filename))) missing.push(`missing:config/${filename}`);
  
  if (!exists(TOKEN)) missing.push('release_delivery_setup_required');
  return { ok: missing.length === 0, status: missing.length ? 'prerequisites_missing' : 'ready', missing };
}
function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 45 * 60_000, maxBuffer: 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw Error('installation_command_failed');
  return result.stdout;
}
function asService(config, args) {
  return command('/usr/bin/setpriv', [`--reuid=${config.uid}`, `--regid=${config.gid}`, '--clear-groups', process.execPath, '--no-warnings',
    path.resolve(__dirname, "../../../bin/dispatch-access-admin"), ...args], { env: { PATH: '/usr/bin:/bin', DISPATCH_LOCAL_ROOT: config.localRoot } });
}
function status(config, input) {
  const progress = privateJson(path.join(STATE, 'preparation-progress.json'), 0, true);
  const result = { preparation: !input.version || progress?.version === input.version ? progress : null };
  if (input.version) result.rollout = JSON.parse(asService(config, ['rollout-status', '--local-root', config.localRoot, '--version', input.version, '--commit', input.sourceCommit]));
  return result;
}
async function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') { process.stdout.write(usage + '\n'); return; }
  const input = parse(argv);
  if (process.geteuid() !== 0) throw Error('installation_requires_root');
  const config = configuration(privateJson(input.config || CONFIG, 0));
  if (input.action === 'check') {
    const result = preflight(config); process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = result.ok ? 0 : 1; return;
  }
  if (input.action === 'setup') {
    command(process.execPath, [path.resolve(__dirname, "../bin/dispatch-release-delivery-install"), input.config, input.core], { stdio: 'inherit' }); return;
  }
  if (input.action === 'status') { process.stdout.write(JSON.stringify(status(config, input)) + '\n'); return; }
  const check = preflight(config);
  if (input.action === 'update' && !fs.existsSync('/etc/dispatch/oci-host.json')) { check.ok = false; check.status = 'prerequisites_missing'; check.missing.push('host_control_configuration_required'); }
  if (!check.ok) { process.stdout.write(JSON.stringify(check) + '\n'); process.exitCode = 1; return; }
  const prepared = JSON.parse(command(process.execPath, [path.resolve(__dirname, "../bin/dispatch-release-watch"), '--version', input.version, '--commit', input.sourceCommit]));
  if (!['release_ready', 'idle'].includes(prepared.status)) { process.stdout.write(JSON.stringify(prepared) + '\n'); process.exitCode = 1; return; }
  if (input.action === 'update') {
    process.stdout.write(asService(config, ['rollout-start', '--local-root', config.localRoot, '--version', input.version, '--commit', input.sourceCommit]));
  } else process.stdout.write(JSON.stringify(prepared) + '\n');
}
module.exports = { main, parse, preflight, status };
