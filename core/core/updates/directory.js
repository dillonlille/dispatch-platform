'use strict';
const { LocalReleases } = require('./local-releases');
const { UpdateCommands } = require('./commands');
const { createUpdatesService } = require('./service');
const { loadConfiguration, rootFor } = require('./configuration');
const { dspHooks } = require('../../host/releases/dsp');
const { serve } = require('./transport');
const { exact } = require('../../sdk/src/protocol');
async function directoryUpdates({ paths, store, manager, execution }) {
  const configuration = loadConfiguration(paths);
  if (!configuration) return { service: createUpdatesService({ enabled: false }), close: async () => {} };
  const directory = rootFor(paths), releases = new LocalReleases({ directory, devDspId: configuration.devDspId,
    hooks: dspHooks({ paths, store, manager, execution }) });
  const commands = new UpdateCommands(directory);
  store.permanentDevId = configuration.devDspId;
  store.releaseBlocked = organizationId => {
    const key = store.installationControl(organizationId)?.runtimeKey;
    return key && require('../../host/releases/guard').updating(paths, key);
  };
  const authorize = actorId => {
    const actor = store.userById(actorId);
    if (actor?.status !== 'active' || actor.platform_role !== 'owner') throw new Error('release_actor_forbidden');
  };
  const socket = await serve({ paths, execute: async (action, input) => {
    if (action === 'authorize') { exact(input, ['actor']); authorize(input.actor); return true; }
    if (action === 'update_dev') { exact(input, ['actor', 'digest']); authorize(input.actor); await releases.updateDev(input.digest); }
    else if (action === 'rollout') {
      exact(input, ['actor', 'digest', 'targets']); authorize(input.actor);
      const targets = store.db.prepare("SELECT runtime_key FROM installations WHERE backend='directory_service_v1' AND status<>'decommissioned' ORDER BY runtime_key").all().map(row => row.runtime_key);
      // A changed fleet requires a new owner action; never silently expand it.
      if (JSON.stringify(targets) !== JSON.stringify(input.targets)) throw new Error('release_fleet_changed');
      await releases.beginRollout(input.digest, targets, input.actor);
    } else if (action === 'step') { exact(input, ['actor']); authorize(input.actor); await releases.step(); }
    else if (action === 'resume') { exact(input, ['actor']); authorize(input.actor); await releases.resume(); }
    else if (action === 'pause') { exact(input, ['actor']); authorize(input.actor); await releases.pause(); }
    else if (action === 'recover') { exact(input, ['actor']); authorize(input.actor);
      if (releases.state().operation?.product === 'core') throw new Error('release_product_invalid');
      await releases.recover();
    } else throw new Error('release_command_invalid');
    return { completed: true };
  } });
  return { service: createUpdatesService({ releases, commands, store, devDspId: configuration.devDspId }),
    close: () => socket.close() };
}
module.exports = { directoryUpdates };
