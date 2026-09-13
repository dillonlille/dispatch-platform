'use strict';
const api = require('../../core/api/directory-platform');
const { createDashboardServer } = require('./server');
module.exports = {
  startDirectoryDashboard: options => api.startDirectoryApi({ ...options, serverFactory: createDashboardServer }),
  mainDirectory: options => api.mainDirectory(options, { serverFactory: createDashboardServer, compatibility: true }),
};
