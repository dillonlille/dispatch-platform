'use strict';
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { LEASE_MS, validateCapacityRequest, validateCapacityResponse } = require('../../../shared/agent/capacity');

function capacityDefaults({ cpus = os.availableParallelism(), memoryBytes = os.totalmem() } = {}) {
  // A conservative initial ceiling, not a throughput claim. Reserve headroom
  // for Core and the OS; operators can tune after running the capacity probe.
  return Math.max(1, Math.min(4, Math.floor(cpus / 2), Math.floor((memoryBytes - 2 * 1024 ** 3) / 1024 ** 3)));
}
class CollectionCapacity {
  constructor({ workers = capacityDefaults(), clock = () => performance.now(), recoveryMs = LEASE_MS } = {}) {
    if (!Number.isInteger(workers) || workers < 1 || workers > 64
        || !Number.isInteger(recoveryMs) || recoveryMs < 0 || recoveryMs > LEASE_MS) throw Error('invalid_collection_capacity');
    this.workers = workers;
    this.clock = clock;
    this.readyAt = clock() + recoveryMs;
    this.active = new Map();
    this.queue = new Map();
  }
  sweep() {
    const now = this.clock();
    for (const map of [this.active, this.queue]) for (const [key, item] of map) if (item.expiresAt <= now) map.delete(key);
  }
  request(runtimeKey, input) {
    const request = validateCapacityRequest(input);
    this.sweep();
    const now = this.clock();
    const respond = (status, workers = 0) => validateCapacityResponse({ type: 'capacity_response',
      requestId: request.requestId, status, workers, leaseMs: status === 'granted' ? LEASE_MS : 0 });
    const active = this.active.get(runtimeKey);
    if (request.operation === 'release') {
      if (active?.jobId === request.jobId) this.active.delete(runtimeKey);
      if (this.queue.get(runtimeKey)?.jobId === request.jobId) this.queue.delete(runtimeKey);
      return respond('released');
    }
    if (active?.jobId === request.jobId) {
      active.expiresAt = now + LEASE_MS;
      return respond('granted', active.workers);
    }
    if (request.operation === 'renew') return respond('lost');
    // One queued or active job per DSP prevents queue flooding and gives each
    // DSP a turn. Repeated polls retain FIFO position.
    if (active) return respond('waiting');
    const queued = this.queue.get(runtimeKey);
    if (queued && queued.jobId !== request.jobId) return respond('waiting');
    if (!queued) {
      if (this.queue.size >= 128) return respond('waiting');
      this.queue.set(runtimeKey, { jobId: request.jobId, expiresAt: now + LEASE_MS });
    } else queued.expiresAt = now + LEASE_MS;
    const available = this.workers - [...this.active.values()].reduce((sum, item) => sum + item.workers, 0);
    if (now < this.readyAt || available < 1 || this.queue.keys().next().value !== runtimeKey) return respond('waiting');
    // Reserve room for another DSP when the host budget permits parallel work.
    const granted = Math.min(request.workers, available, Math.ceil(this.workers / 2));
    this.queue.delete(runtimeKey);
    this.active.set(runtimeKey, { jobId: request.jobId, workers: granted, expiresAt: now + LEASE_MS });
    return respond('granted', granted);
  }
  disconnect(runtimeKey) {
    this.queue.delete(runtimeKey);
    // Keep active grants until expiry: the disconnected collector needs time
    // to notice renewal failure and terminate its browser work.
  }
  status() {
    this.sweep();
    return { workerLimit: this.workers, activeWorkers: [...this.active.values()].reduce((sum, item) => sum + item.workers, 0),
      activeDsps: this.active.size, waitingDsps: this.queue.size, recovering: this.clock() < this.readyAt };
  }
}
module.exports = { CollectionCapacity, capacityDefaults };
