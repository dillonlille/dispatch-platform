'use strict';

const RUNTIME_BACKENDS = Object.freeze([
  'local_reference',
  'systemd_user',
  'oci_container_v1',
  'native_service_v1',
  'directory_service_v1',
]);

function runtimeBackend(value) {
  if (!RUNTIME_BACKENDS.includes(value)) {
    throw Object.assign(new Error('runtime_boundary_violation'), { code: 'runtime_boundary_violation' });
  }
  return value;
}

module.exports = { RUNTIME_BACKENDS, runtimeBackend };
