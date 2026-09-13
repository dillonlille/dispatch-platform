'use strict';

const assert = require('node:assert/strict');
const { createInstallationLayoutManager } = require('../../src');
const { createInstallationJobStore } = require('../../src/job-store');

const options = JSON.parse(process.argv[2]);
const store = createInstallationJobStore({ stateRoot: options.stateRoot });
const layout = createInstallationLayoutManager({ installationsRoot: options.installationsRoot });
const claim = store.claimNext('worker_interrupted', 1_020, 100);
assert.ok(claim);
assert.equal(store.claimNext('worker_competing', 1_021, 100), null);
const work = store.work(claim, 1_030);
const receipt = layout.materialize(
  work.manifest,
  work.authority,
  mutation => store.mutateClaim(claim, 1_040, mutation),
);
store.completeStage(
  claim,
  work.stage,
  receipt,
  1_040,
);
process.stdout.write(JSON.stringify(claim));
process.exit(86);
