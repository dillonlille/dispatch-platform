'use strict';

// Dispatch orders hotfix builds explicitly; SemVer itself ignores build metadata.
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+hotfix\.([1-9]\d*))?$/;
function compareVersions(a, b) {
  const left = typeof a === 'string' && a.match(VERSION);
  const right = typeof b === 'string' && b.match(VERSION);
  if (!left || !right) return 0; // Legacy catalogs retain publication ordering.
  for (let index = 1; index <= 4; index++) {
    const x = BigInt(left[index] || '0'), y = BigInt(right[index] || '0');
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}
module.exports = { VERSION, compareVersions };
