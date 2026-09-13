'use strict';

const net = require('node:net');
const path = require('node:path');
const { PrivateListener } = require('../../shared/transport/private-listener');
const { request } = require('../../shared/browser-assistance/protocol');
const { browserRelay } = require('./relay');
const { runHermes } = require('./runner');
const { atomic } = require('../../core/installations/src/release-delivery-files');
const { privateDirectory } = require('../controller/operations');

class DirectoryBrowserAssistance {
  constructor({ dspRoot, queue, configuration, permitted = () => true, runner = runHermes,
    runtimeRoot = path.join(dspRoot, 'run'), socketPath = path.join(dspRoot, '.control/browser-assist.sock') }) {
    this.dspRoot = dspRoot; this.queue = queue; this.configuration = configuration;
    this.permitted = permitted; this.runner = runner; this.connections = new Map();
    this.runtimeRoot = runtimeRoot; this.socketPath = socketPath;
  }
  async start() {
    this.server = net.createServer(socket => {
      if (!this.permitted() || this.connections.size) { socket.destroy(); return; }
      const controller = new AbortController();
      this.connections.set(socket, { controller, done: null });
      let buffer = '', handling = false;
      const send = value => { if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n'); };
      const timer = setTimeout(() => socket.destroy(), 5000);
      socket.on('error', () => controller.abort());
      socket.on('close', () => { clearTimeout(timer); controller.abort(); this.connections.delete(socket); });
      socket.on('data', bytes => {
        if (handling) { socket.destroy(); return; }
        buffer += bytes.toString('utf8');
        if (buffer.length > 2048) { socket.destroy(); return; }
        if (!buffer.includes('\n')) return;
        let input;
        try { if (!buffer.endsWith('\n') || buffer.slice(0, -1).includes('\n')) throw new Error(); input = request(JSON.parse(buffer)); }
        catch { socket.destroy(); return; }
        handling = true; clearTimeout(timer);
        const startedAt = new Date().toISOString(); let agentSummary = null;
        const record = phase => {
          const directory = path.join(this.dspRoot, 'state/plugins/paycom');
          privateDirectory(directory);
          atomic(path.join(directory, 'browser-assistance.json'), { version: 1, startedAt, phase, updatedAt: new Date().toISOString(),
            ...(agentSummary ? { agent: agentSummary } : {}) });
        };
        const operation = this.queue.run(this.dspRoot, async signal => {
          if (!this.permitted()) throw new Error('assistance_cancelled');
          const relay = await browserRelay(path.join(this.runtimeRoot, input.socketName), input.browserPath);
          try { agentSummary = await this.runner(this.configuration, relay.endpoint, { signal, runtimeKey: path.basename(this.dspRoot) }); }
          finally { await relay.close(); }
        }, { signal: controller.signal, onPhase: phase => { record(phase); send({ type: 'phase', phase }); } });
        this.connections.get(socket).done = operation;
        operation.then(() => { record('agent_finished'); send({ type: 'result', ok: true }); }, () => { record('failed'); send({ type: 'result', ok: false }); })
          .catch(() => socket.destroy())
          .finally(() => socket.end());
      });
    });
    this.listener = new PrivateListener(this.server, this.socketPath);
    await this.listener.start();
  }
  async close() {
    const active = [...this.connections.entries()];
    for (const [socket, value] of active) { value.controller.abort(); socket.destroy(); }
    await Promise.allSettled(active.map(([, value]) => value.done));
    await this.listener?.close();
  }
}
module.exports = { DirectoryBrowserAssistance };
