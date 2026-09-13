'use strict';
// The authenticated dashboard installs this immutable host before loading any
// reviewed plugin frontend. No Node storage/browser/credential API is exposed.
const host = globalThis.DispatchPluginHost;
if (!host?.ui) throw new Error('dashboard_host_required');
module.exports = host.ui;
