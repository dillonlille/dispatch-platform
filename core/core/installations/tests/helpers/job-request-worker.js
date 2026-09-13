'use strict';

const fs = require('node:fs');
const { createInstallationJobStore } = require('../../src/job-store');

const options = JSON.parse(process.argv[2]);
const store = createInstallationJobStore({ stateRoot: options.stateRoot });
try {
  const result = store.request(
    options.manifest,
    options.authority,
    options.operation,
    {
      scope: 'operator_fixture',
      permission: 'platform.installations.manage',
      operatorEnabled: true,
    },
    options.jobId,
    1_010,
  );
  fs.writeSync(1, JSON.stringify(result));
} finally {
  store.close();
}
