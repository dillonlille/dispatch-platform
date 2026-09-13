'use strict';

const path = require('node:path');
const { runJson } = require('../../../../runtime/adapters/local/process-helper');

const EVIDENCE_HELPER = path.resolve(__dirname, "../bin/dispatch-paycom-activation-evidence");
const HASH_RE = /^[a-f0-9]{64}$/;

function fail(code = 'first_publication_failed') {
  throw Object.assign(new Error(code), { code });
}
function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function validResponse(value) {
  if (!plain(value) || value.ok !== true || value.status !== 'ok'
      || Object.keys(value).sort().join(',') !== 'evidence,ok,status' || !plain(value.evidence)) return false;
  const evidence = value.evidence;
  return Object.keys(evidence).sort().join(',')
      === 'batchId,capturedAt,definitionDigest,preparationRunId,previewDigest,publications,requestDigest,runs,target'
    && HASH_RE.test(evidence.definitionDigest) && HASH_RE.test(evidence.requestDigest)
    && HASH_RE.test(evidence.previewDigest) && typeof evidence.batchId === 'string'
    && typeof evidence.preparationRunId === 'string'
    && typeof evidence.target === 'string' && typeof evidence.capturedAt === 'string'
    && Array.isArray(evidence.runs) && plain(evidence.publications);
}

function createLocalPaycomActivationEvidencePort(options) {
  if (!plain(options) || Object.keys(options).sort().join(',') !== 'environment'
      || !plain(options.environment)) fail('runtime_boundary_violation');
  const environment = Object.freeze({
    ...options.environment,
    DISPATCH_MANAGED_RUNTIME: '1',
  });
  function verify(input) {
    if (!plain(input) || Object.keys(input).sort().join(',') !== 'batchId,definitionDigest,preparationRunId'
        || typeof input.batchId !== 'string' || typeof input.preparationRunId !== 'string'
        || !HASH_RE.test(input.definitionDigest)) fail();
    try {
      return runJson(EVIDENCE_HELPER, [], {
        environment,
        interpreter: 'node',
        input: JSON.stringify(input),
        timeout: 30_000,
        validate: validResponse,
      }).value.evidence;
    } catch (error) {
      if (error?.code === 'unsafe_executable' || error?.code === 'helper_unavailable') {
        fail('runtime_boundary_violation');
      }
      fail();
    }
  }
  return Object.freeze({ verify });
}

module.exports = {
  EVIDENCE_HELPER,
  createLocalPaycomActivationEvidencePort,
  validResponse,
};
