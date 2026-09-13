'use strict';

function renderApiUnits({ source, node, config, uid, gid, port, apiPort, publicOrigin = null }) {
  for (const value of [source, node, config]) if (typeof value !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(value)
    || value.split('/').includes('..')) throw new TypeError('directory_startup_invalid');
  for (const value of [uid, gid]) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('directory_startup_invalid');
  for (const value of [port, apiPort]) if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new TypeError('directory_startup_invalid');
  if (port === apiPort) throw new TypeError('directory_startup_invalid');
  if (publicOrigin !== null && !/^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/.test(publicOrigin)) throw new TypeError('directory_startup_invalid');
  const common = `Type=exec\nUser=${uid}\nGroup=${gid}\nUMask=0077\nWorkingDirectory=${source}\nEnvironment=PATH=/usr/bin:/bin\nRestart=on-failure\nRestartSec=5\nStandardOutput=journal\nStandardError=journal\n`;
  const tail = '\n[Install]\nWantedBy=multi-user.target\n';
  return {
    'dispatch-api.service': `[Unit]\nDescription=Dispatch API and DSP coordination\nAfter=network-online.target\nWants=network-online.target\nStartLimitIntervalSec=300\nStartLimitBurst=5\n\n[Service]\n${common}Environment=DISPATCH_PLATFORM_CONFIG=${config}\nExecStart=${node} --no-warnings ${source}/bin/dispatch-api --installation-backend directory_service_v1 --installation-operator --operator --port ${apiPort}\nTimeoutStopSec=240\nKillMode=mixed\n${tail}`,
    'dispatch-platform-local.service': `[Unit]\nDescription=Dispatch dashboard\nAfter=network-online.target dispatch-api.service\nWants=network-online.target dispatch-api.service\nStartLimitIntervalSec=300\nStartLimitBurst=5\n\n[Service]\n${common}ExecStart=${node} --no-warnings ${source}/bin/dispatch-dashboard --api-origin http://127.0.0.1:${apiPort} --port ${port}${publicOrigin ? ` --public-origin ${publicOrigin}` : ''}\nTimeoutStopSec=15\nKillMode=control-group\nNoNewPrivileges=true\n${tail}`,
  };
}
module.exports = { renderApiUnits };
