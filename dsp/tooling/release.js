'use strict';
try {
  console.log(JSON.stringify(require('dispatch-sdk/tooling/release-publication').main(require('node:path').resolve(__dirname, '..'), process.argv.slice(2))));
} catch (error) { console.error(error.message); process.exitCode = 1; }
