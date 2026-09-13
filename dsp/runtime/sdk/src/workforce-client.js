'use strict';

// The validated workforce read contract is shared by isolated runtime clients
// and Core's published-data reader. Provider execution remains in the runtime.
module.exports = require('dispatch-protocol/contracts/src/workforce-client');
