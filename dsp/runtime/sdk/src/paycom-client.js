'use strict';

const { success, failure } = require('dispatch-protocol/contracts/src');

const SAFE_CODES = new Set(['unsafe_storage', 'schema_invalid', 'publication_verification_failed', 'candidate_invalid', 'not_initialized']);
const KINDS = new Set(['pay_periods', 'roster', 'timecards', 'resource_links']);
const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;

function invalidComponent() { throw Object.assign(new Error('invalid_component_response'), { code: 'invalid_component_response' }); }
function auditView(value, expectedKind) {
  if (!value || typeof value !== 'object' || typeof value.verified !== 'boolean' || value.kind !== expectedKind
      || typeof value.code !== 'string' || !CODE_RE.test(value.code)
      || value.target !== null && (typeof value.target !== 'string' || value.target.length > 128)) invalidComponent();
  const result = { verified: value.verified, code: value.code, kind: value.kind, target: value.target };
  if (value.verified) {
    if (!Number.isInteger(value.rowCount) || value.rowCount < 0 || typeof value.collectedAt !== 'string' || Number.isNaN(Date.parse(value.collectedAt))) invalidComponent();
    result.rowCount = value.rowCount;
    result.collectedAt = value.collectedAt;
    if (expectedKind === 'pay_periods') result.projectionValid = value.projectionValid === true;
  }
  return result;
}
function unloaded(kind) { return { verified: false, code: 'not_loaded', kind, target: null }; }

class PaycomClient {
  #port;

  constructor({ port } = {}) {
    if (!port || typeof port.health !== 'function') throw new TypeError('paycom_port_required');
    this.#port = port;
  }

  async health() {
    try {
      const value = await this.#port.health();
      if (value === null) return success('not_initialized', {
        database: 'missing', storageStatus: 'missing', publicationStatus: 'not_initialized', ready: false,
        payPeriods: unloaded('pay_periods'), roster: unloaded('roster'), timecards: unloaded('timecards'),
        resourceLinks: unloaded('resource_links'),
      });
      const audits = {
        payPeriods: auditView(value.payPeriods, 'pay_periods'),
        roster: auditView(value.roster, 'roster'),
        timecards: auditView(value.timecards, 'timecards'),
        resourceLinks: auditView(value.resourceLinks, 'resource_links'),
      };
      const ready = Object.values(audits).every(item => item.verified);
      const publicationStatus = ready ? 'ready'
        : Object.values(audits).some(item => item.verified) ? 'degraded' : 'not_loaded';
      return success(ready ? 'ready' : 'degraded', {
        database: 'ready', storageStatus: 'ready', publicationStatus, ready, ...audits,
      });
    } catch (error) {
      if (['invalid_component_response', 'invalid_contract', 'unsafe_contract'].includes(error?.code)
          || ['invalid_component_response', 'invalid_contract', 'unsafe_contract'].includes(error?.message)) {
        return failure('invalid_component_response');
      }
      const code = SAFE_CODES.has(error?.code) ? error.code : SAFE_CODES.has(error?.message) ? error.message : 'paycom_unavailable';
      return failure(code, { recoverable: code === 'paycom_unavailable' || code === 'not_initialized' });
    }
  }
}

module.exports = { PaycomClient, SAFE_CODES, KINDS, auditView };
