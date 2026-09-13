'use strict';
const fs = require('node:fs'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { createOciFixtureDeploymentPlan, renderOciSystemUnit, renderOciBridgeSystemUnit, hostAccountName } = require('../../src/oci-deployment');
async function main() {
  assert.equal(os.hostname(), 'dispatch-recovery-test'); assert.equal(process.geteuid(), 0);
  const release = JSON.parse(fs.readFileSync('/root/package/descriptor.json'));
  for (let i = 0; i < 2; i++) {
    const id = `org_recovery_${i}`, key = `runtime_recovery_${i}`, uid = 20501 + i;
    const manifest = { manifestVersion: 1, revision: 1, organization: { id, stationCode: 'DXX1', timezone: 'UTC' }, runtime: { key, templateId: 'isolated_dsp_v1', releaseId: release.releaseId } };
    const plan = createOciFixtureDeploymentPlan(manifest, { revision: 1, organization: manifest.organization, runtime: manifest.runtime }, release,
      { name: hostAccountName(key), uid, gid: uid, subuidStart: 300000 + i * 65536, subgidStart: 300000 + i * 65536, subidCount: 65536 },
      { version: 1, backend: 'native_service_v1', channel: 'fixture', organizationId: id, runtimeKey: key, manifestRevision: 1, releaseId: release.releaseId });
    if (process.argv[2] === 'prepare') {
      fs.writeFileSync(plan.host.unitPath, renderOciSystemUnit(plan));
      fs.writeFileSync(plan.host.bridgeUnitPath, renderOciBridgeSystemUnit(plan, { bridgeExecutable: `/opt/dispatch-runtime/releases/${release.releaseId}/bridge-artifact/core/agent-bridge/src/service-cli.js`,
        centralSocket: '/home/dispatchfixture/local/run/runtime-agent-hub.sock', centralUid: 1001, controllerUid: 0 }));
    } else {
      const state = execFileSync('/usr/bin/systemctl', ['show', plan.identity.unitName, '--property=UnitFileState', '--value'], { encoding: 'utf8' }).trim();
      assert.equal(state, i ? 'disabled' : 'enabled');
      const active = execFileSync('/usr/bin/systemctl', ['show', plan.identity.unitName, '--property=ActiveState', '--value'], { encoding: 'utf8' }).trim();
      assert.equal(active, i ? 'inactive' : 'active');
    }
  }
  if (process.argv[2] === 'prepare') { execFileSync('/usr/bin/systemctl', ['daemon-reload']); return; }
  const script = `require('/work/core/agents/src/control').runtimeAgentControlInvoke('/home/dispatchfixture/local/run/runtime-agent-control.sock','runtime_recovery_0','health',{}).then(r=>{if(!r.ok)process.exitCode=1}).catch(()=>process.exitCode=1)`;
  execFileSync('/usr/sbin/runuser', ['--user', 'dispatchfixture', '--', '/usr/bin/node', '--no-warnings', '-e', script]);
  console.log(JSON.stringify({ status: 'reboot_verified', activeDspHealthy: true, suspendedDspDisabled: true }));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
