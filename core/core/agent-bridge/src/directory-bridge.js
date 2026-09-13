'use strict';

const net = require('node:net');
const path = require('node:path');
const { ForwardingBridge } = require('./forwarding');
const { DSP_ID } = require('../../../shared/paths/platform-paths');
const { privateDirectory, socketIdentity, sameIdentity, MAX_UNIX_SOCKET_PATH_BYTES } = require('../../../shared/transport/unix-socket');

const { PrivateListener } = require('../../../shared/transport/private-listener');

function fail() { throw new Error('directory_bridge_invalid'); }
function configuration(options) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype
      || Object.keys(options).sort().join(',') !== 'dspRoot,runtimeKey,upstreamSocket') fail();
  const { runtimeKey, dspRoot, upstreamSocket } = options;
  if (typeof runtimeKey !== 'string' || !DSP_ID.test(runtimeKey) || typeof dspRoot !== 'string'
      || !path.isAbsolute(dspRoot) || path.resolve(dspRoot) !== dspRoot || path.basename(dspRoot) !== runtimeKey) fail();
  privateDirectory(dspRoot);
  const downstreamSocket = path.join(dspRoot, '.control/runtime-agent-hub.sock');
  for (const selected of [downstreamSocket, upstreamSocket]) {
    if (typeof selected !== 'string' || !path.isAbsolute(selected) || path.resolve(selected) !== selected
        || path.basename(selected) !== 'runtime-agent-hub.sock' || Buffer.byteLength(selected) > MAX_UNIX_SOCKET_PATH_BYTES) fail();
  }
  if (upstreamSocket === downstreamSocket || upstreamSocket.startsWith(dspRoot + '/')) fail();
  return Object.freeze({ runtimeKey, dspRoot, downstreamSocket, upstreamSocket });
}

// Each read-only mounted socket is bound to exactly one runtime identity. The
// shared host UID grants no ability to register as a sibling through this bridge.
// The Core hub independently validates the registration token and generation.
class DirectoryRuntimeAgentBridge extends ForwardingBridge {
  constructor(options) {
    super(configuration(options));
    this.server = null;
    this.rootIdentity = null;
    this.upstreamRootIdentity = null;
  }

  validateUpstream() {
    const current = privateDirectory(path.dirname(this.config.upstreamSocket));
    if (this.upstreamRootIdentity && !sameIdentity(this.upstreamRootIdentity, current)) fail();
    socketIdentity(this.config.upstreamSocket);
  }

  validateParent() {
    const current = privateDirectory(path.dirname(this.config.downstreamSocket));
    if (this.rootIdentity && !sameIdentity(this.rootIdentity, current)) fail();
  }

  async start() {
    if (this.server) fail();
    const file = this.config.downstreamSocket;
    this.rootIdentity = privateDirectory(path.dirname(file));
    this.upstreamRootIdentity = privateDirectory(path.dirname(this.config.upstreamSocket));
    this.validateUpstream();
    this.server = net.createServer(socket => this.accept(socket));
    this.server.maxConnections = 1;
    this.listener = new PrivateListener(this.server, file);
    try {
      await this.listener.start();
      this.server.on('error', () => { if (this.active) this.closeConnection(this.active); });
    } catch (error) { await this.close(); throw error; }
  }

  async close() {
    if (!this.server) return;
    if (this.active) this.closeConnection(this.active);
    this.server = null;
    await this.listener.close();
  }
}

module.exports = { DirectoryRuntimeAgentBridge };
