'use strict';
// The package builder selects this module for the legacy default-path import.
// Its directories are mounted by the worker host and come only from the SDK.
const path = require('node:path');
const { createWorkerClient } = require('dispatch-sdk/node');
const storage = createWorkerClient().storage;
module.exports = {
  DATA_ROOT: storage.directory('database'),
  DATABASE: path.join(storage.directory('database'), 'paycom.sqlite3'),
  STAGING_ROOT: storage.directory('staging'),
  AUTH_SOCKET: null,
};
