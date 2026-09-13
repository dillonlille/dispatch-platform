'use strict';

const { QUEUE_MS, fail } = require('../../shared/browser-assistance/protocol');

// One FIFO position per DSP. Waiting browsers and active solvers are both bounded.
class AssistanceQueue {
  constructor({ concurrency = 1, maximum = 4, queueMs = QUEUE_MS } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8
        || !Number.isInteger(maximum) || maximum < concurrency || maximum > 32
        || !Number.isInteger(queueMs) || queueMs < 1 || queueMs > QUEUE_MS) fail();
    this.concurrency = concurrency; this.maximum = maximum; this.queueMs = queueMs;
    this.entries = new Map(); this.waiting = []; this.active = 0; this.closed = false;
  }
  run(key, work, { signal, onPhase = () => {} } = {}) {
    if (this.closed || signal?.aborted) return Promise.reject(new Error('assistance_cancelled'));
    if (this.entries.has(key) || this.entries.size >= this.maximum) return Promise.reject(new Error('assistance_busy'));
    const controller = new AbortController();
    const notify = phase => { try { onPhase(phase); } catch {} };
    const entry = { key, work, controller, onPhase: notify, started: false };
    const abort = () => {
      controller.abort();
      if (!entry.started) { this.waiting = this.waiting.filter(item => item !== entry); entry.reject(new Error('assistance_cancelled')); }
    };
    this.entries.set(key, entry);
    const promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
    entry.done = promise.finally(() => {
      clearTimeout(entry.timer); signal?.removeEventListener('abort', abort);
      this.entries.delete(key); if (entry.started) this.active--;
      this.drain();
    });
    entry.timer = setTimeout(abort, this.queueMs);
    signal?.addEventListener('abort', abort, { once: true });
    notify('queued'); this.waiting.push(entry); this.drain();
    return entry.done;
  }
  drain() {
    while (!this.closed && this.active < this.concurrency && this.waiting.length) {
      const entry = this.waiting.shift();
      if (entry.controller.signal.aborted) continue;
      entry.started = true; this.active++; clearTimeout(entry.timer);
      entry.onPhase('solving');
      Promise.resolve().then(() => entry.work(entry.controller.signal)).then(entry.resolve, entry.reject);
    }
  }
  async close() {
    this.closed = true;
    for (const entry of this.entries.values()) {
      entry.controller.abort(); if (!entry.started) entry.reject(new Error('assistance_cancelled'));
    }
    this.waiting = [];
    await Promise.allSettled([...this.entries.values()].map(entry => entry.done));
  }
}
module.exports = { AssistanceQueue };
