'use strict';

const LABELS = Object.freeze({ auth: 'Auth Broker', collections: 'Collection Manager', paycom: 'Paycom data' });
const SYMBOLS = Object.freeze({ ready: '✓', stopped: '○', not_initialized: '○', degraded: '!', failed: '×' });
const STEP_LABELS = Object.freeze({
  preflight: 'Checking Auth Broker and vault state',
  initialize_vault: 'Initializing encrypted Auth Broker vault',
  capture_profile: 'Opening protected credential entry',
  remove_profile: 'Deleting encrypted authentication profile and attempt state',
  verify_profile: 'Verifying stored profile metadata',
  stop_broker: 'Stopping the verified Dispatch-managed Auth Broker',
  start_broker: 'Starting and verifying the Auth Broker',
});
const PROVIDER_LABELS = Object.freeze({ paycom: 'Paycom', 'amazon-logistics': 'Amazon Logistics' });

function renderHelp() {
  return [
    'Dispatch',
    '',
    'Usage:',
    '  dispatch status [--plain|--json]',
    '  dispatch setup auth [--provider paycom|amazon-logistics] [--profile <id>] [--replace] [--test-auth] [--no-menu] [--plain|--json]',
    '  dispatch setup auth --provider <provider> --profile <id> --remove [--confirm --no-menu|--plain|--json]',
    '  dispatch collect describe <source> [--json]',
    '  dispatch collect preview <source> <scope> <selector> [--mode ensure|refresh|verify] [--json]',
    '  dispatch collect enqueue <source> <scope> <selector> [--mode ensure|refresh|verify] [--idempotency <key>] [--preview-hash <sha256>] [--json]',
    '  dispatch collect target <source> <scope> <target-key> [--mode ensure|refresh] [--idempotency <key>] [--json]',
    '  dispatch collect backfill <source> <scope> <first-target> <last-target> [--mode ensure|refresh] [--idempotency <key>] [--json]',
    '  dispatch collect audit <source> <scope> <selector> [--idempotency <key>] [--json]',
    '  dispatch collect batches|batch <id>|cancel <id>|retry <id> [--json]',
    '  dispatch collect schedules [--json]',
    '  dispatch collect schedule create <id> <source> <scope> <selector> (--interval <seconds>|--cron <expression> --timezone <iana>) [--json]',
    '  dispatch collect schedule pause|resume|remove|run <id> [--json]',
    '  dispatch sync list [--json]',
    '  dispatch sync status|start|stop|restart|run <id> [--json]',
    '  dispatch sync stop|restart <id> [--drain] [--json]',
    '  dispatch sync edit <id> [--interval <seconds>] [--jitter <seconds>] [--set <key=value>] [--replace-settings] [--revision <n>] [--apply-now] [--json]',
    '  dispatch sync history <id> [--limit <1-100>] [--offset <n>] [--json]',
    '  dispatch workforce status [--json]',
    '  dispatch workforce employees|timecards|links [--lifecycle active|inactive|unknown] [--limit <n>] [--offset <n>] [--json]',
    '  dispatch workforce punches --date YYYY-MM-DD [--kind in_day|out_lunch|in_lunch|out_day|unclassified] [--from-time HH:MM] [--through-time HH:MM] [--lifecycle active|inactive|unknown] [--limit <n>] [--offset <n>] [--json]',
    '  dispatch workforce employee <employee-code> [--json]',
    '  dispatch help',
    '',
    'Interactive terminals receive a guided non-secret setup menu.',
    'Use --plain or --no-menu to bypass menus; --json remains machine-readable.',
    'Credential values are accepted only by the Auth Broker protected terminal helper.',
    'Selectors: --current, --latest-complete, --today, --yesterday, --date YYYY-MM-DD,',
    '           --from YYYY-MM-DD --through YYYY-MM-DD, --last-days N, --target <key>.',
  ].join('\n');
}

function renderStatus(result) {
  if (!result?.ok) return `× Dispatch status unavailable (${result?.status || 'internal_error'})`;
  const lines = [
    '◆ DISPATCH',
    '',
    `  System status       ${result.status.toUpperCase()}`,
    '',
  ];
  for (const [id, value] of Object.entries(result.data.components)) {
    lines.push(`  ${SYMBOLS[value.status] || '•'} ${LABELS[id] || id}`.padEnd(25) + value.status);
  }
  const collections = result.data.components.collections.data;
  if (collections?.counts) {
    lines.push('', `  Registry            ${collections.counts.collectors} collector · ${collections.counts.sources} source · ${collections.counts.plans} plans`);
    lines.push(`  Runs                ${collections.counts.queued} queued · ${collections.counts.running} running · ${collections.counts.failed} failed`);
    if (collections.syncAlerts?.total) {
      lines.push(`  Sync alerts         ${collections.syncAlerts.total} active · ${collections.syncAlerts.critical} critical`);
      lines.push(...collections.syncAlerts.items.map(alert => `    ${alert.severity.padEnd(8)} ${alert.syncId}: ${alert.code}`));
      if (collections.syncAlerts.hasMore) lines.push('    … additional sync alerts omitted');
    }
  }
  const paycom = result.data.components.paycom.data;
  if (paycom) {
    lines.push('', `  Pay periods         ${paycom.payPeriods?.verified ? 'verified' : paycom.payPeriods?.code || 'unknown'}`);
    lines.push(`  Roster              ${paycom.roster?.verified ? 'verified' : paycom.roster?.code || 'unknown'}`);
    lines.push(`  Timecards           ${paycom.timecards?.verified ? 'verified' : paycom.timecards?.code || 'unknown'}`);
    lines.push(`  Resource links      ${paycom.resourceLinks?.verified ? 'verified' : paycom.resourceLinks?.code || 'unknown'}`);
  }
  return lines.join('\n');
}

function renderSetupEvent(value, { provider = null } = {}) {
  if (value.type === 'workflow_started') return '◆ DISPATCH / AUTH SETUP';
  if (value.type === 'step_started') {
    const label = value.data.step === 'test_authentication'
      ? `Testing ${PROVIDER_LABELS[provider] || 'provider'} authentication inside the Auth Broker`
      : STEP_LABELS[value.data.step] || value.data.step;
    return `\n  › ${label}`;
  }
  if (value.type === 'check_completed') return `  ✓ ${value.data.check.replaceAll('_', ' ')}: ${value.data.status}`;
  if (value.type === 'credential_capture_started') return '  ◇ Enter values in the protected terminal prompt; Dispatch will not receive them.';
  if (value.type === 'credential_capture_completed') return '  ✓ Encrypted profile stored';
  return null;
}

function renderSetupResult(result) {
  if (!result.ok) {
    const action = result.data?.nextActions?.[0];
    return [`\n× Authentication setup stopped: ${result.status}`, ...(action ? [`  Next action: ${action.replaceAll('_', ' ')}`] : [])].join('\n');
  }
  if (result.data.configured === false) {
    return [
      '',
      '✓ Authentication profile deleted',
      `  Profile             ${result.data.profile}`,
      `  Provider            ${result.data.provider}`,
      `  Vault               ${result.data.vault}`,
      `  Auth Broker         ${result.data.broker}`,
    ].join('\n');
  }
  return [
    '',
    '✓ Authentication setup complete',
    `  Profile             ${result.data.profile}`,
    `  Provider            ${result.data.provider}`,
    `  Vault               ${result.data.vault}`,
    `  Auth Broker         ${result.data.broker}`,
    `  Authentication test ${result.data.authenticationTest}`,
  ].join('\n');
}

function renderCollection(result) {
  if (!result?.ok) return `× Collection operation failed (${result?.status || 'internal_error'})`;
  const data = result.data;
  if (result.status === 'previewed') {
    return [
      '◆ DISPATCH / COLLECTION PREVIEW',
      `  Source              ${data.source}`,
      `  Scope               ${data.request.scope}`,
      `  Target type         ${data.targetType}`,
      `  Targets             ${data.targetCount}`,
      `  Tasks               ${data.taskCount}`,
      `  Preview hash        ${data.hash}`,
      '',
      ...data.targets.map(target => `  • ${target.key}  ${target.start} through ${target.end}`),
    ].join('\n');
  }
  if (data?.id && data?.runCount !== undefined) {
    return [
      '◆ DISPATCH / COLLECTION BATCH',
      `  Batch               ${data.id}`,
      `  Status              ${data.status}`,
      `  Source              ${data.source}`,
      `  Scope               ${data.scope}`,
      `  Runs                ${data.runCount}`,
      `  Preview hash        ${data.previewHash}`,
    ].join('\n');
  }
  return `◆ DISPATCH / COLLECTIONS\n${JSON.stringify(data, null, 2)}`;
}

function renderSync(result) {
  if (!result?.ok) return `× Sync operation failed (${result?.status || 'internal_error'})`;
  const data = result.data;
  if (Array.isArray(data?.items) && data.items.every(item => item?.desiredState)) {
    return [
      '◆ DISPATCH / SYNCS',
      ...(data.items.length ? data.items.map(item => `  ${item.id.padEnd(32)} ${item.desiredState.padEnd(8)} ${item.activity}`) : ['  No syncs registered']),
    ].join('\n');
  }
  if (Array.isArray(data?.items) && data.items.every(item => item?.run)) {
    return [
      '◆ DISPATCH / SYNC HISTORY',
      ...(data.items.length ? data.items.map(item => {
        const context = item.businessContext ? `  ${item.businessContext.date} ${item.businessContext.timezone}` : '';
        const changes = item.delta
          ? `  timecards Δ${item.delta.timecards.changedCount}  punches +${item.delta.punches.addedCount}/~${item.delta.punches.editedCount}/-${item.delta.punches.removedCount}`
          : '';
        const attempts = `  attempts ${item.run.attempts.length}/${item.run.attempt}`;
        return `  ${item.run.id}  ${item.run.status}  revision ${item.configRevision}${context}${changes}${attempts}`;
      }) : ['  No sync runs']),
    ].join('\n');
  }
  const sync = data?.sync || data;
  if (sync?.desiredState) {
    return [
      '◆ DISPATCH / SYNC',
      `  Sync                ${sync.id}`,
      `  Desired state       ${sync.desiredState}`,
      `  Activity            ${sync.activity}`,
      `  Source              ${sync.source}`,
      `  Method              ${sync.method}`,
      `  Interval            ${sync.intervalSeconds}s`,
      `  Jitter              ${sync.jitterSeconds}s`,
      `  Revision            ${sync.revision}`,
      `  Generation          ${sync.generation}`,
      `  Next due            ${sync.nextDueAt === null ? 'not scheduled' : sync.nextDueAt}`,
      `  Last success        ${sync.lastSucceededAt === null ? 'never' : sync.lastSucceededAt}`,
      `  Business date       ${sync.businessContext?.date || 'not available'}`,
      `  Business timezone   ${sync.businessContext?.timezone || 'not available'}`,
      `  Active alerts       ${sync.alerts.length}`,
      ...sync.alerts.map(alert => `    ${alert.severity.padEnd(8)} ${alert.code}${alert.error ? ` (${alert.error})` : ''}`),
      `  Last error          ${sync.lastError || 'none'}`,
      ...(data?.run ? [`  Queued run          ${data.run.id}`] : []),
    ].join('\n');
  }
  return `◆ DISPATCH / SYNC\n${JSON.stringify(data, null, 2)}`;
}

function renderWorkforce(result) {
  if (!result?.ok) return `× Workforce read failed (${result?.status || 'internal_error'})`;
  const data = result.data;
  if (data?.counts && data?.lifecycleCounts) {
    return [
      '◆ DISPATCH / WORKFORCE',
      `  Target              ${data.target}`,
      `  Employees           ${data.counts.employees}`,
      `  Timecards           ${data.counts.timecards}`,
      `  Resource links      ${data.counts.resourceLinks}`,
      `  Lifecycle           ${data.lifecycleCounts.active} active · ${data.lifecycleCounts.inactive} inactive · ${data.lifecycleCounts.unknown} unknown`,
      `  Consistent          ${data.consistent ? 'yes' : 'no'}`,
      `  Roster collected    ${data.collectedAt.roster}`,
      `  Timecards collected ${data.collectedAt.timecards}`,
    ].join('\n');
  }
  if (data?.employee) {
    const employee = data.employee;
    return [
      '◆ DISPATCH / WORKFORCE EMPLOYEE',
      `  Employee            ${employee.employeeCode} · ${employee.employeeName}`,
      `  Lifecycle           ${employee.lifecycleStatus}`,
      `  Department          ${employee.department.code} · ${employee.department.name}`,
      `  Position            ${employee.positionTitle}`,
      `  Pay class           ${employee.payClass}`,
      `  Current timecard    ${data.timecard ? `${data.timecard.periodTotalHours} hours · ${data.timecard.missingDays} missing days` : 'not published'}`,
    ].join('\n');
  }
  if (Array.isArray(data?.items)) {
    const timecards = data.kind === 'timecards';
    const punches = data.kind === 'punches';
    const links = data.kind === 'resource_links';
    return [
      `◆ DISPATCH / WORKFORCE ${timecards ? 'TIMECARDS' : punches ? 'PUNCHES' : links ? 'RESOURCE LINKS' : 'EMPLOYEES'}`,
      `  Target              ${data.target}`,
      ...(punches ? [
        `  Business date       ${data.businessDate}`,
        `  Business timezone   ${data.businessTimezone}`,
        `  Timecards collected ${data.collectedAt}`,
      ] : []),
      `  Results             ${data.items.length} of ${data.total} · offset ${data.offset}`,
      '',
      ...(data.items.length ? data.items.map(item => timecards
        ? `  ${item.employeeCode}  ${item.employeeName}  ${item.lifecycleStatus}  ${item.periodTotalHours}h`
        : punches ? `  ${item.time}  ${item.kind}  ${item.employeeName}  ${item.lifecycleStatus}${item.timeBasis === 'displayed' ? '  displayed-time basis' : ''}`
          : links ? `  ${item.employeeCode}  ${item.employeeName}  ${item.lifecycleStatus}  ${item.canonicalUrl}`
            : `  ${item.employeeCode}  ${item.employeeName}  ${item.lifecycleStatus}  ${item.positionTitle}`) : ['  No matching records']),
    ].join('\n');
  }
  return '◆ DISPATCH / WORKFORCE';
}

module.exports = {
  renderHelp, renderStatus, renderSetupEvent, renderSetupResult, renderCollection, renderSync, renderWorkforce,
  LABELS, SYMBOLS, STEP_LABELS, PROVIDER_LABELS,
};
