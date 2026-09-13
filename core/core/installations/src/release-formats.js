'use strict';
const contract = require('../release-formats.json');
function format(name) {
  if (!Object.hasOwn(contract.formats, name)) throw Error('invalid_release_format');
  return contract.formats[name];
}
function componentFiles(name) {
  const selected = format(name);
  return [...Object.values(selected.assets), contract.manifest,
    ...(selected.checksums ? [selected.checksums] : []),
    ...(selected.notesSidecar ? [contract.notes] : []), contract.changelog];
}
module.exports = { ...contract, format, componentFiles };
