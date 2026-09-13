'use strict';

const source = require('dispatch-protocol/contracts/src');

module.exports = Object.freeze({
  CONTRACT_VERSION: source.CONTRACT_VERSION,
  success: source.success,
  failure: source.failure,
  isResult: source.isResult,
  event: source.event,
  pagination: source.pagination,
  identifier: source.identifier,
  collectionSelector: source.collectionSelector,
  collectionRequest: source.collectionRequest,
  collectionEnqueueOptions: source.collectionEnqueueOptions,
  collectionSchedule: source.collectionSchedule,
  syncEditPatch: source.syncEditPatch,
  syncEditOptions: source.syncEditOptions,
  syncStopOptions: source.syncStopOptions,
  syncRunOptions: source.syncRunOptions,
  workforceQuery: source.workforceQuery,
  workforceEmployeeCode: source.workforceEmployeeCode,
  AUTH_PROTOCOL_VERSION: source.AUTH_PROTOCOL_VERSION,
  AUTH_PROFILE_SESSION_STATES: source.AUTH_PROFILE_SESSION_STATES,
});
