'use strict';

const { parseCron } = require('dispatch-runtime-kit/collection-manager/src/cron');
const cache = new Map();
async function nextCron(expression, timezone, after) {
  const key = `${expression}\n${timezone}`;
  const cached = cache.get(key);
  if (cached && after >= cached.after && after < cached.next) return cached.next;
  const cron = parseCron(expression);
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
  // UTC-minute iteration preserves both sides of DST transitions. Cache only
  // the next occurrence, with a bounded catalog; never allocate a timer per DSP.
  let next = Math.floor(after / 60000) * 60000 + 60000;
  for (let step = 0; step < 366 * 24 * 60 * 8; step++, next += 60000) {
    if (step % 1000 === 0) await new Promise(resolve => setImmediate(resolve));
    const p = Object.fromEntries(formatter.formatToParts(new Date(next)).map(part => [part.type, part.value]));
    if (!cron.month.has(Number(p.month)) || !cron.hour.has(Number(p.hour)) || !cron.minute.has(Number(p.minute))) continue;
    const day = cron.day.has(Number(p.day)), weekday = cron.weekday.has(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday));
    if (!(cron.dayWildcard && cron.weekdayWildcard || cron.dayWildcard && weekday || cron.weekdayWildcard && day
      || !cron.dayWildcard && !cron.weekdayWildcard && (day || weekday))) continue;
    if (cache.size >= 64) cache.delete(cache.keys().next().value);
    cache.set(key, { after, next }); return next;
  }
  throw new Error('schedule_next_occurrence_unavailable');
}

async function nextWake(store, timestamp = Date.now()) {
  const times = [];
  const add = value => { if (Number.isSafeInteger(value)) times.push(value); };
  const queued = store.db.prepare("SELECT min(run_after) due FROM runs WHERE status='queued' AND cancel_requested=0").get(); add(queued.due);
  const scheduling = require('./execution-control').read(store.db);
  const after = Math.min(timestamp, scheduling?.completedAt ?? timestamp);
  for (const plan of store.schedulablePlans()) {
    if (plan.schedule.type === 'interval') add(plan.nextDueAt);
    else if (plan.schedule.type === 'cron') add(await nextCron(plan.schedule.expression, plan.schedule.timezone, after));
  }
  for (const schedule of store.schedulableCollectionSchedules()) {
    if (schedule.schedule.type === 'interval') add(schedule.nextDueAt);
    else {
      if (schedule.schedule.type === 'polling-window') {
        const window = require('./manager').activePollingWindow(schedule.schedule, timestamp);
        if (window) add(Math.min(window.deadline, timestamp + schedule.schedule.intervalSeconds * 1000));
      }
      add(await nextCron(schedule.schedule.expression, schedule.schedule.timezone, after));
    }
  }
  // Match the manager's plugin/source/plan gates instead of waking disabled work.
  const sync = store.db.prepare(`SELECT min(d.next_due_at) due FROM sync_definitions d
    WHERE d.desired_state='running' AND NOT EXISTS(SELECT 1 FROM sync_runs s JOIN runs r ON r.id=s.run_id
      WHERE s.sync_id=d.id AND r.status IN ('queued','running'))`).get(); add(sync.due);
  return times.length ? Math.min(...times) : null;
}
module.exports = { nextWake, nextCron };
