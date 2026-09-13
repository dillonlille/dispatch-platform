'use strict';

const path = require('node:path');
const { PROJECT_ROOT: SOURCE_ROOT, assertExternalRuntimePaths, resolveLocalRuntimePaths } = require('dispatch-protocol/paths/runtime-paths');

const resolved = resolveLocalRuntimePaths();
const PROJECT_ROOT = resolved.projectRoot;
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const DATA_ROOT = process.env.DISPATCH_PAYCOM_DATA_ROOT || resolved.paycom.dataRoot;
const DATABASE = path.join(DATA_ROOT, 'paycom.sqlite3');
const STAGING_ROOT = process.env.DISPATCH_PAYCOM_STAGING_ROOT || resolved.paycom.stagingRoot;
const AUTH_SOCKET = process.env.DISPATCH_AUTH_SOCKET || resolved.paycom.authSocket;
assertExternalRuntimePaths(SOURCE_ROOT, [DATA_ROOT, DATABASE, STAGING_ROOT, AUTH_SOCKET]);

module.exports = { PROJECT_ROOT, PLUGIN_ROOT, DATA_ROOT, DATABASE, STAGING_ROOT, AUTH_SOCKET };
