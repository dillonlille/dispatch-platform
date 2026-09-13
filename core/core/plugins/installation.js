'use strict';

// Core accounts remains the durable desired/applied registry. This coordinator
// owns the ordering of package preparation and runtime acknowledgement. Its
// host port must fence the DSP lifecycle for the entire operation.
function createInstallationCoordinator({ catalog, host, needsMigration = () => false, resume = async () => {}, acknowledge = ({ runtimeKey, request, invoke }) => invoke(runtimeKey, 'plugins.manage', request) }) {
  if (typeof catalog?.resolve !== 'function' || typeof host?.apply !== 'function') throw new TypeError('plugin_installation_dependencies_required');
  return Object.freeze({
    needsMigration, resume, latest: (id, runtimeKey) => catalog.latest?.(id, runtimeKey) || null,
    async apply({ runtimeKey, request, invoke, authorize }) {
      const approved = catalog.resolve(request.pluginId, request.version, runtimeKey);
      return host.apply({ runtimeKey, request, approved, authorize,
        acknowledge: () => acknowledge({ runtimeKey, request, invoke }) });
    },
  });
}
module.exports = { createInstallationCoordinator };
