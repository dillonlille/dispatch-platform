'use strict';
const { createDashboardShell } = require('../dashboard/server/shell');
const server = createDashboardShell({ apiOrigin: process.argv[2] });
server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port, pid: process.pid }));
process.once('SIGTERM', () => { server.close(() => process.exit(0)); server.closeAllConnections(); });
