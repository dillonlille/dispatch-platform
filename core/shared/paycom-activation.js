'use strict';
const { collectionRequest } = require('./contracts/src');
const PAYCOM_PROFILE_ID = 'paycom-main';
const PAYCOM_SOURCE_ID = 'paycom-main';
const PAYCOM_SYNC_ID = 'paycom-main-workforce';
const PAYCOM_COLLECTION_SCOPE = 'full';
function managedPaycomFirstPublicationRequest() {
  return Object.freeze(collectionRequest({
    source: PAYCOM_SOURCE_ID,
    scope: PAYCOM_COLLECTION_SCOPE,
    selector: { kind: 'current' },
    mode: 'refresh',
  }));
}

module.exports = { PAYCOM_PROFILE_ID, PAYCOM_SOURCE_ID, PAYCOM_SYNC_ID, PAYCOM_COLLECTION_SCOPE, managedPaycomFirstPublicationRequest };
