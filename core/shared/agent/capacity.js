'use strict';
// Only scheduling metadata crosses this boundary; identity comes from the
// authenticated agent connection, never from the request payload.
const LEASE_MS = 120_000;
const REQUEST_RE = /^[a-f0-9]{32}$/;
function fail() { throw Object.assign(Error('invalid_capacity_frame'), { code: 'invalid_capacity_frame' }); }
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join(',') !== keys.sort().join(',')) fail();
}
function validateCapacityRequest(value) {
  exact(value, ['type', 'requestId', 'operation', 'jobId', 'workers']);
  if (value.type !== 'capacity_request' || typeof value.requestId !== 'string' || typeof value.jobId !== 'string' || !REQUEST_RE.test(value.requestId) || !REQUEST_RE.test(value.jobId)
      || !['acquire', 'renew', 'release'].includes(value.operation)
      || !Number.isInteger(value.workers) || value.workers < 1 || value.workers > 6) fail();
  return Object.freeze({ ...value });
}
function validateCapacityResponse(value) {
  exact(value, ['type', 'requestId', 'status', 'workers', 'leaseMs']);
  if (value.type !== 'capacity_response' || typeof value.requestId !== 'string' || !REQUEST_RE.test(value.requestId)
      || !['granted', 'waiting', 'released', 'lost'].includes(value.status)
      || !Number.isInteger(value.workers) || value.workers < 0 || value.workers > 6
      || value.leaseMs !== (value.status === 'granted' ? LEASE_MS : 0)
      || (value.status === 'granted' ? value.workers < 1 : value.workers !== 0)) fail();
  return Object.freeze({ ...value });
}
module.exports = { LEASE_MS, validateCapacityRequest, validateCapacityResponse };
