'use strict';

function fail(code = 'runtime_boundary_violation') { throw Object.assign(new Error(code), { code }); }
function identifier(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{2,95}$/.test(value)) fail();
  return value;
}

function createInstallationLifecycleReconciler(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['store', 'authorityFactory', 'runtimeFactory', 'clock', 'concurrency', 'backupOnly'].includes(key))
      || !options.store || typeof options.store.statusLifecycleMismatches !== 'function'
      || typeof options.store.lifecycleExecutionCandidates !== 'function'
      || typeof options.store.lifecycleExhaustedCandidates !== 'function'
      || typeof options.store.lifecycleOutstandingCount !== 'function'
      || typeof options.authorityFactory !== 'function' || typeof options.runtimeFactory !== 'function') fail();
  const clock = options.clock || Date.now;

  async function runPending(workerIdValue, limitValue = 20) {
    const workerId = identifier(workerIdValue);
    if (!Number.isSafeInteger(limitValue) || limitValue < 1 || limitValue > 50) fail('invalid_input');
    let requested = 0;
    let completed = 0;
    let failed = 0;
    const exhausted = options.store.lifecycleExhaustedCandidates(clock(), limitValue);
    const mismatches = options.backupOnly ? [] : options.store.statusLifecycleMismatches(limitValue);
    for (const mismatch of mismatches) {
      const operation = mismatch.organization_status === 'suspended' ? 'suspend' : 'resume';
      const authority = options.authorityFactory(
        mismatch.organization_id, 'organization_status_lifecycle', false,
      );
      authority.request({
        operation,
        idempotencyKey: `organization-status:${operation}:${mismatch.installation_revision}`,
        expectedRevision: mismatch.installation_revision,
      });
      requested += 1;
    }

    const candidates = options.store.lifecycleExecutionCandidates(clock(), limitValue)
      .filter(candidate => !options.backupOnly || candidate.operation === 'backup');
    let next = 0;
    const concurrency = options.concurrency || 1;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) fail('invalid_input');
    const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
      while (next < candidates.length) {
        const index = next++;
        const candidate = candidates[index];
        const authority = options.authorityFactory(
          candidate.organization_id, candidate.authority_scope, false,
        );
        const runtime = options.runtimeFactory(candidate.organization_id, authority);
        const result = await runtime.run(candidate.id, `${workerId}_${index}`);
        if (result.status === 'succeeded') completed += 1;
        else failed += 1;
      }
    }));
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    const pending = options.store.lifecycleOutstandingCount() > 0;
    return Object.freeze({
      requested,
      processed: candidates.length,
      completed,
      failed,
      exhausted: exhausted.length,
      pending,
    });
  }

  return Object.freeze({ runPending });
}

module.exports = { createInstallationLifecycleReconciler };
