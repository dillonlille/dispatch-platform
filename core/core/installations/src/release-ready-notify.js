'use strict';
const {atomic} = require('./release-delivery-files');
function install(localRoot) {
  if (!/^\/[A-Za-z0-9_./-]+$/.test(localRoot) || require('node:path').resolve(localRoot) !== localRoot) throw Error('invalid_local_root');
  atomic('/etc/systemd/system/dispatch-release-watch.path', `[Unit]\nDescription=Discover an explicitly published Dispatch release immediately\n\n[Path]\nPathChanged=${localRoot}/run/release-ready\nUnit=dispatch-release-watch.service\n\n[Install]\nWantedBy=multi-user.target\n`, 0o644);
}
module.exports = {install};
