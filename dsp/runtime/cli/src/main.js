'use strict';

const { contracts: { failure } } = require('../../sdk/src');
const { parse } = require('./parse');
const plain = require('./renderers/plain');
const json = require('./renderers/json');
const { LineInteraction } = require('./interactions/line');
const { collectSetupAuthInput } = require('./interactions/setup-auth');

async function main(argv = process.argv.slice(2), {
  client = null,
  write = chunk => process.stdout.write(chunk),
  writeError = chunk => process.stderr.write(chunk),
  signal = null,
  interaction = null,
} = {}) {
  process.umask(0o077);
  let command;
  try {
    command = parse(argv);
  } catch {
    writeError(`${plain.renderHelp()}\n`);
    write(`${json.render(failure('invalid_input'))}\n`);
    return 2;
  }
  if (command.command === 'help') {
    write(`${plain.renderHelp()}\n`);
    return 0;
  }

  let result;
  if (command.command === 'setup-auth') {
    try { result = await client.workflows.authSetup.prepare({ provider: command.provider, profile: command.profile }); }
    catch { result = failure('internal_error'); }
    if (!result.ok) {
      write(`${command.format === 'json' ? json.render(result) : plain.renderSetupResult(result)}\n`);
      return 1;
    }
    const preparation = result.data;
    const menu = interaction || new LineInteraction({ signal });
    let choices;
    try { choices = await collectSetupAuthInput(command, menu, preparation); }
    catch (error) {
      choices = { cancelled: error?.code === 'cancelled', failed: error?.code !== 'cancelled' };
    } finally {
      if (typeof menu.close === 'function') menu.close();
    }
    if (choices.cancelled || choices.failed) {
      result = failure(choices.cancelled ? 'cancelled' : 'internal_error', {
        recoverable: choices.cancelled,
        data: {
          workflow: 'setup_auth', profile: preparation.target.profile, provider: preparation.target.provider,
          nextActions: choices.cancelled ? ['retry_setup'] : [],
        },
      });
      write(`${command.format === 'json' ? json.render(result) : plain.renderSetupResult(result)}\n`);
      return result.ok ? 0 : 1;
    }
    const events = {
      emit(value) {
        if (command.format !== 'plain') return;
        const output = plain.renderSetupEvent(value, { provider: preparation.target.provider });
        if (output) write(`${output}\n`);
      },
    };
    try {
      result = await client.workflows.authSetup.run(choices.input, { events, signal });
    } catch { result = failure('internal_error'); }
    write(`${command.format === 'json' ? json.render(result) : plain.renderSetupResult(result)}\n`);
    return result.ok ? 0 : 1;
  }

  if (command.command.startsWith('collect-')) {
    const collections = client?.collections;
    try {
      const request = command.source ? { source: command.source, scope: command.scope, selector: command.selector, mode: command.mode } : null;
      if (command.command === 'collect-describe') result = await collections.describe(command.source);
      else if (command.command === 'collect-preview') result = await collections.preview(request);
      else if (command.command === 'collect-enqueue') result = await collections.enqueue(request, {
        ...(command.idempotencyKey ? { idempotencyKey: command.idempotencyKey } : {}),
        ...(command.expectedPreviewHash ? { expectedPreviewHash: command.expectedPreviewHash } : {}),
      });
      else if (command.command === 'collect-audit') result = await collections.audit(request, {
        ...(command.idempotencyKey ? { idempotencyKey: command.idempotencyKey } : {}),
        ...(command.expectedPreviewHash ? { expectedPreviewHash: command.expectedPreviewHash } : {}),
      });
      else if (command.command === 'collect-batches') result = await collections.batches();
      else if (command.command === 'collect-batch') result = await collections.batchStatus(command.batchId);
      else if (command.command === 'collect-cancel') result = await collections.cancelBatch(command.batchId);
      else if (command.command === 'collect-retry') result = await collections.retryBatch(command.batchId);
      else if (command.command === 'collect-schedules') result = await collections.schedules();
      else if (command.command === 'collect-schedule-create') result = await collections.createSchedule({
        id: command.scheduleId, request, schedule: command.schedule, enabled: true,
      });
      else if (command.command === 'collect-schedule-pause') result = await collections.pauseSchedule(command.scheduleId);
      else if (command.command === 'collect-schedule-resume') result = await collections.resumeSchedule(command.scheduleId);
      else if (command.command === 'collect-schedule-remove') result = await collections.removeSchedule(command.scheduleId);
      else if (command.command === 'collect-schedule-run') result = await collections.runScheduleNow(command.scheduleId);
      else result = failure('invalid_input');
    } catch { result = failure('internal_error'); }
    write(`${command.format === 'json' ? json.render(result) : plain.renderCollection(result)}\n`);
    return result.ok ? 0 : 1;
  }

  if (command.command.startsWith('sync-')) {
    const sync = client?.sync;
    try {
      if (command.command === 'sync-list') result = await sync.list();
      else if (command.command === 'sync-status') result = await sync.status(command.syncId);
      else if (command.command === 'sync-start') result = await sync.start(command.syncId);
      else if (command.command === 'sync-stop') result = await sync.stop(command.syncId, { drain: command.drain });
      else if (command.command === 'sync-restart') result = await sync.restart(command.syncId, { drain: command.drain });
      else if (command.command === 'sync-run') result = await sync.runNow(command.syncId);
      else if (command.command === 'sync-edit') result = await sync.edit(command.syncId, command.patch, {
        ...(command.expectedRevision === undefined ? {} : { expectedRevision: command.expectedRevision }),
        applyNow: command.applyNow,
      });
      else if (command.command === 'sync-history') result = await sync.history(command.syncId, {
        limit: command.limit, offset: command.offset,
      });
      else result = failure('invalid_input');
    } catch { result = failure('internal_error'); }
    write(`${command.format === 'json' ? json.render(result) : plain.renderSync(result)}\n`);
    return result.ok ? 0 : 1;
  }

  if (command.command.startsWith('workforce-')) {
    const workforce = client?.workforce;
    try {
      if (command.command === 'workforce-status') result = await workforce.snapshot();
      else if (command.command === 'workforce-employees') result = await workforce.employees(command.query);
      else if (command.command === 'workforce-employee') result = await workforce.employee(command.employeeCode);
      else if (command.command === 'workforce-timecards') result = await workforce.timecards(command.query);
      else if (command.command === 'workforce-punches') result = await workforce.punches(command.query);
      else if (command.command === 'workforce-links') result = await workforce.resourceLinks(command.query);
      else result = failure('invalid_input');
    } catch { result = failure('internal_error'); }
    write(`${command.format === 'json' ? json.render(result) : plain.renderWorkforce(result)}\n`);
    return result.ok ? 0 : 1;
  }

  try { result = await client.system.status(); }
  catch { result = failure('internal_error'); }
  write(`${command.format === 'json' ? json.render(result) : plain.renderStatus(result)}\n`);
  return result.ok && result.status !== 'failed' ? 0 : 1;
}

module.exports = { main };
