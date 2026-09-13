'use strict';

const crypto = require('node:crypto');
const { cronMatches, zonedParts } = require('dispatch-runtime-kit/collection-manager/src/cron');
const { coordinatedCollector } = require('./capacity-runner');
const { StandardCollectionService } = require('dispatch-runtime-kit/collection-manager/src/standard-collections');
const { SyncService } = require('dispatch-runtime-kit/collection-manager/src/syncs');

function materializeLocks(run) {
  const replacements = {
    '{source}': run.source_id,
    '{authProfile}': run.auth_profile || 'none',
    '{collector}': run.collector_id,
    '{method}': run.method_id,
  };
  const keys = [`source:${run.source_id}`];
  for (const template of JSON.parse(run.concurrency_keys_json)) {
    let key = template;
    for (const [needle, value] of Object.entries(replacements)) key = key.replaceAll(needle, value);
    keys.push(key);
  }
  return [...new Set(keys)].sort();
}

function activePollingWindow(schedule, timestamp) {
  const currentMinute = Math.floor(timestamp / 60_000) * 60_000;
  const minuteCount = Math.ceil(schedule.windowSeconds / 60);
  for (let offset = 0; offset < minuteCount; offset += 1) {
    const startedAt = currentMinute - offset * 60_000;
    if (!cronMatches(schedule.expression, schedule.timezone, new Date(startedAt))) continue;
    const deadline = startedAt + schedule.windowSeconds * 1000;
    if (timestamp >= deadline) return null;
    return { startedAt, deadline, key: zonedParts(new Date(startedAt), schedule.timezone).key };
  }
  return null;
}

class CollectionManager {
  constructor(store, {
    maxWorkers = 4, tickMs = 500, leaseMs = 60_000,
    collectionService = null, syncService = null,
  } = {}) {
    if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 32) throw new Error('invalid_workers');
    this.store = store;
    this.maxWorkers = maxWorkers;
    this.tickMs = tickMs;
    this.leaseMs = leaseMs;
    this.collectionService = collectionService || new StandardCollectionService(store);
    this.syncService = syncService || new SyncService(store);
    this.instanceId = crypto.randomUUID();
    this.epoch = null;
    this.active = new Map();
    this.timer = null;
    this.started = false;
    this.stopping = false;
    this.ticking = false;
    this.collectionScheduleWindows = new Map();
    this.collectionPollingStates = new Map();
    this.schedulerController = null;
    this.leaseTimer = null;
    this.leaseLossPromise = null;
  }

  fence() { return { instanceId: this.instanceId, epoch: this.epoch }; }

  schedule(timestamp = Date.now()) {
    for (const plan of this.store.schedulablePlans()) {
      try {
        if (plan.schedule.type === 'interval' && plan.nextDueAt !== null && plan.nextDueAt <= timestamp) {
          this.store.enqueuePlan(plan.id, {
            trigger: 'interval', timestamp,
            logicalKey: `${plan.id}:interval:${plan.nextDueAt}`,
          });
          this.store.setNextDue(plan.id, timestamp + plan.schedule.seconds * 1000);
        } else if (plan.schedule.type === 'cron' && cronMatches(plan.schedule.expression, plan.schedule.timezone, new Date(timestamp))) {
          const minute = zonedParts(new Date(timestamp), plan.schedule.timezone).key;
          this.store.enqueuePlan(plan.id, { trigger: 'cron', timestamp, logicalKey: `${plan.id}:cron:${minute}` });
        }
      } catch (error) {
        if (error?.code !== 'plan_disabled') throw error;
      }
    }
  }

  async scheduleCollections(timestamp = Date.now(), signal = this.schedulerController?.signal || null) {
    for (const schedule of this.store.schedulableCollectionSchedules()) {
      if (schedule.schedule.type === 'interval' && schedule.nextDueAt !== null && schedule.nextDueAt <= timestamp) {
        const due = schedule.nextDueAt;
        if (this.collectionScheduleWindows.get(schedule.id) === due) continue;
        this.collectionScheduleWindows.set(schedule.id, due);
        try { await this.collectionService.fireSchedule(schedule, timestamp, due, { signal }); }
        catch { /* A failed resolver must not block unrelated schedules or queued work. */ }
        finally { this.store.setCollectionScheduleNextDue(schedule.id, timestamp + schedule.schedule.seconds * 1000); }
      } else if (schedule.schedule.type === 'polling-window') {
        const checkedMinute = Math.floor(timestamp / 60_000);
        const prior = this.collectionPollingStates.get(schedule.id);
        if (prior?.done && timestamp < prior.deadline) continue;
        if (prior?.checkedMinute === checkedMinute && prior.window === null) continue;
        const window = prior?.window && timestamp < prior.window.deadline
          ? prior.window : activePollingWindow(schedule.schedule, timestamp);
        if (!window) {
          this.collectionPollingStates.set(schedule.id, { checkedMinute, window: null });
          continue;
        }
        if (prior?.window?.key === window.key && prior.nextTryAt > timestamp) continue;
        try {
          await this.collectionService.fireSchedule(schedule, window.startedAt, window.key, { signal });
          this.collectionPollingStates.set(schedule.id, {
            checkedMinute, window, deadline: window.deadline, done: true,
          });
        } catch {
          this.collectionPollingStates.set(schedule.id, {
            checkedMinute, window, deadline: window.deadline, done: false,
            nextTryAt: Math.min(window.deadline,
              timestamp + schedule.schedule.intervalSeconds * 1000),
          });
        }
      } else if (schedule.schedule.type === 'cron'
          && cronMatches(schedule.schedule.expression, schedule.schedule.timezone, new Date(timestamp))) {
        const minute = zonedParts(new Date(timestamp), schedule.schedule.timezone).key;
        if (this.collectionScheduleWindows.get(schedule.id) === minute) continue;
        this.collectionScheduleWindows.set(schedule.id, minute);
        try { await this.collectionService.fireSchedule(schedule, timestamp, minute, { signal }); }
        catch { /* A failed resolver is retried only in a later matching window. */ }
      }
    }
  }

  async start() {
    if (this.started) return;
    const timestamp = Date.now();
    this.epoch = this.store.claimManager(this.instanceId, process.pid, timestamp, this.leaseMs);
    this.store.recoverRunning(timestamp);
    this.schedulerController = new AbortController();
    this.started = true;
    this.leaseTimer = setInterval(() => {
      if (!this.started) return;
      try {
        this.store.renewManager(this.instanceId, process.pid, this.epoch, Date.now(), this.leaseMs);
      } catch (error) {
        if (error?.code === 'manager_lease_lost' && !this.leaseLossPromise) {
          this.leaseLossPromise = this._loseLease().catch(() => {});
        }
      }
    }, Math.max(5, Math.floor(this.leaseMs / 3)));
    this.leaseTimer.unref?.();
    await this.tick();
    if (this.started && !this.stopping) {
      this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.tickMs);
    }
  }

  _completeRun(id, outcome) {
    try {
      this.store.finishRun(id, outcome, Date.now(), this.fence());
    } catch (error) {
      if (!['manager_lease_lost', 'run_not_running'].includes(error?.code)) throw error;
    } finally {
      this.active.delete(id);
    }
  }

  async _loseLease() {
    clearInterval(this.timer);
    clearInterval(this.leaseTimer);
    this.stopping = true;
    this.schedulerController?.abort();
    for (const task of this.active.values()) task.cancel();
    await Promise.allSettled([...this.active.values()].map(task => task.promise));
    this.active.clear();
    this.started = false;
    this.stopping = false;
  }

  _queuePages(timestamp, callback) {
    let cursor = null;
    while (true) {
      const page = this.store.queued(timestamp, 100, cursor);
      if (page.length === 0) return false;
      for (const run of page) {
        cursor = run;
        if (callback(run) === true) return true;
      }
      if (page.length < 100) return false;
    }
  }

  async tick() {
    if (!this.started || this.stopping || this.ticking) return;
    this.ticking = true;
    try {
      const timestamp = Date.now();
      this.store.renewManager(this.instanceId, process.pid, this.epoch, timestamp, this.leaseMs);
      const execution = require('./execution-control');
      const control = execution.read(this.store.db);
      for (const id of this.store.cancelRequestedRuns()) this.active.get(id)?.cancel();
      if (control?.draining) { execution.acknowledge(this.store, control.generation); return; }
      const scheduleAt = control ? control.requestedAt : timestamp;
      if (!control || scheduleAt !== null && (control.completedAt === null || scheduleAt > control.completedAt)) {
        this.schedule(scheduleAt);
        await this.scheduleCollections(scheduleAt, this.schedulerController?.signal || null);
        this.syncService.schedule(scheduleAt);
        if (control) execution.complete(this.store, scheduleAt);
      }
      if (this.stopping || this.schedulerController?.signal.aborted) return;
      this.store.renewManager(this.instanceId, process.pid, this.epoch, Date.now(), this.leaseMs);
      // A drain may have arrived while an asynchronous target resolver ran.
      const afterScheduling = execution.read(this.store.db);
      if (afterScheduling?.draining) { execution.acknowledge(this.store, afterScheduling.generation); return; }
      for (const id of this.store.cancelRequestedRuns()) this.active.get(id)?.cancel();
      if (this.active.size >= this.maxWorkers) return;
      this._queuePages(timestamp, queued => {
        if (this.active.size >= this.maxWorkers) return true;
        if (queued.retry_deadline !== null && queued.retry_deadline <= timestamp) {
          this.store.expirePollingRun(queued.id, timestamp);
          return false;
        }
        const dependency = this.store.dependencyStatus(queued.plan_id, timestamp, queued.id);
        if (!dependency.ready) {
          if (dependency.terminal) {
            this.store.failDependency(queued.id, timestamp);
            return false;
          }
          this.store.setBlocked(queued.id, dependency.reason);
          return false;
        }
        const plan = this.store.loadPlan(queued.plan_id);
        const runForLocks = { ...queued, concurrency_keys_json: plan.concurrency_keys_json };
        let claimed = false;
        try { claimed = this.store.claimRun(queued.id, materializeLocks(runForLocks), timestamp, this.fence()); }
        catch (error) { if (error?.code !== 'lock_busy') throw error; }
        if (!claimed) return false;
        const execution = this.store.execution(queued.id);
        let task;
        try {
          task = coordinatedCollector(execution, state => this.store.setCapacityWait(queued.id, state, this.fence()));
        } catch (error) {
          const code = ['collector_unavailable', 'unsafe_collector'].includes(error?.code) ? error.code : 'collector_start_failed';
          this._completeRun(queued.id, { success: false, errorCode: code, exitCode: null });
          return false;
        }
        this.active.set(queued.id, task);
        task.promise.then(
          outcome => this._completeRun(queued.id, outcome),
          () => this._completeRun(queued.id, { success: false, errorCode: 'manager_internal_error', exitCode: null }),
        );
        return false;
      });
    } catch (error) {
      if (error?.code === 'manager_lease_lost') await this._loseLease();
      throw error;
    } finally {
      this.ticking = false;
    }
  }

  hasRunnableWork(timestamp = Date.now()) {
    let found = false;
    this._queuePages(timestamp, run => {
      if (this.store.dependencyStatus(run.plan_id, timestamp, run.id).ready) {
        found = true;
        return true;
      }
      return false;
    });
    return found;
  }

  async runUntilIdle({ timeoutMs = 30_000 } = {}) {
    if (!this.started) await this.start();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.tick();
      if (this.active.size === 0 && !this.hasRunnableWork()) {
        const pending = this.store.pendingSummary();
        return pending.total === 0 ? { idle: true, pending } : { idle: false, deferred: true, pending };
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return { idle: false, timedOut: true, activeRunIds: [...this.active.keys()], pending: this.store.pendingSummary() };
  }

  async stop() {
    if (!this.started) return { cancelledRunIds: [] };
    this.stopping = true;
    this.schedulerController?.abort();
    clearInterval(this.timer);
    const cancelled = new Set(this.active.keys());
    for (const task of this.active.values()) task.cancel();
    while (this.ticking) await new Promise(resolve => setTimeout(resolve, 10));
    for (const id of this.active.keys()) cancelled.add(id);
    for (const task of this.active.values()) task.cancel();
    await Promise.allSettled([...this.active.values()].map(task => task.promise));
    clearInterval(this.leaseTimer);
    this.store.releaseManager(this.instanceId, this.epoch);
    this.active.clear();
    this.started = false;
    this.stopping = false;
    return { cancelledRunIds: [...cancelled] };
  }
}

module.exports = { CollectionManager, materializeLocks, activePollingWindow };
