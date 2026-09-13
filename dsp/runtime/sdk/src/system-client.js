'use strict';

const { getSystemStatus } = require('../../application/system/get-status');

class SystemClient {
  constructor({ auth, collections, paycom }) {
    this.auth = auth;
    this.collections = collections;
    this.paycom = paycom;
    this.includePaycom = () => true;
  }

  status() {
    return getSystemStatus({ auth: this.auth, collections: this.collections, paycom: this.includePaycom() ? this.paycom : null });
  }
}

module.exports = { SystemClient };
