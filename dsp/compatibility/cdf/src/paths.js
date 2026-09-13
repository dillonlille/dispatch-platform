'use strict';

const path = require('node:path');
const { PROJECT_ROOT: SOURCE_ROOT, assertExternalRuntimePaths, resolveLocalRuntimePaths } = require('dispatch-protocol/paths/runtime-paths');

const resolved = resolveLocalRuntimePaths();
const PROJECT_ROOT = resolved.projectRoot;
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const DATA_ROOT = process.env.DISPATCH_CDF_DATA_ROOT || resolved.cdf.dataRoot;
const DATABASE = path.join(DATA_ROOT, 'cdf.sqlite3');
const ARTIFACT_ROOT = path.join(DATA_ROOT, 'artifacts');
const STAGING_ROOT = process.env.DISPATCH_CDF_STAGING_ROOT || resolved.cdf.stagingRoot;
const AUTH_SOCKET = resolved.auth.socket;
assertExternalRuntimePaths(SOURCE_ROOT, [DATA_ROOT, DATABASE, ARTIFACT_ROOT, STAGING_ROOT]);

module.exports = { PROJECT_ROOT, PLUGIN_ROOT, DATA_ROOT, DATABASE, ARTIFACT_ROOT, STAGING_ROOT, AUTH_SOCKET };
