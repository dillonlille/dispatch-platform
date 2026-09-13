'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { HOST_BRIDGE_ROOT, opaqueRuntimeSuffix, runtimeKey: checkedRuntimeKey } = require('../../runtime-host-identity');
const { ForwardingBridge } = require('./forwarding');
const MAX_UNIX_SOCKET_PATH_BYTES = 107;

function fail(code = 'runtime_agent_bridge_unavailable') {
  throw Object.assign(new Error(code), { code });
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactOptions(value) {
  const names = ['runtimeKey', 'downstreamSocket', 'upstreamSocket', 'tenantUid', 'tenantGid', 'controllerUid', 'controllerGid', 'centralUid'];
  if (!plain(value) || Object.keys(value).sort().join(',') !== names.sort().join(',')) fail();
}

function safeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2 ** 31 - 1) fail();
  return value;
}

function identity(target, { type, uid, gid = null, mode }) {
  let info;
  try { info = fs.lstatSync(target); } catch { fail(); }
  const correctType = type === 'directory' ? info.isDirectory() : info.isSocket();
  if (!correctType || info.isSymbolicLink() || info.uid !== uid || gid !== null && info.gid !== gid
      || (info.mode & 0o7777) !== mode || fs.realpathSync(target) !== target) fail();
  return Object.freeze({ dev: info.dev, ino: info.ino });
}

function socketInode(target) {
  let info;
  try { info = fs.lstatSync(target); } catch { fail(); }
  if (!info.isSocket() || info.isSymbolicLink() || info.nlink !== 1 || fs.realpathSync(target) !== target) fail();
  return Object.freeze({ dev: info.dev, ino: info.ino });
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function lexists(target) {
  try { fs.lstatSync(target); return true; } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function probeUnixSocket(socketPath) {
  return new Promise(resolve => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), 300);
    socket.on('connect', () => finish(true));
    socket.on('error', () => finish(false));
  });
}

function socketPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value
      || path.basename(value) !== 'runtime-agent-hub.sock'
      || Buffer.byteLength(value, 'utf8') > MAX_UNIX_SOCKET_PATH_BYTES) fail();
  return value;
}

function configuration(options) {
  exactOptions(options);
  let runtimeKey;
  try { runtimeKey = checkedRuntimeKey(options.runtimeKey); } catch { fail(); }
  const controllerUid = safeInteger(options.controllerUid);
  const controllerGid = safeInteger(options.controllerGid);
  if (controllerUid !== process.geteuid() || controllerGid !== process.getegid()) fail();
  const tenantUid = safeInteger(options.tenantUid);
  const tenantGid = safeInteger(options.tenantGid);
  const centralUid = safeInteger(options.centralUid);
  if (tenantUid < 100 || tenantGid < 100 || centralUid < 100
      || tenantUid === centralUid || tenantUid === controllerUid || centralUid === controllerUid) fail();
  const downstreamSocket = socketPath(options.downstreamSocket);
  const expectedParent = path.join(HOST_BRIDGE_ROOT, opaqueRuntimeSuffix(runtimeKey));
  if (path.dirname(downstreamSocket) !== expectedParent) fail();
  const upstreamSocket = socketPath(options.upstreamSocket);
  if (upstreamSocket === downstreamSocket || path.dirname(upstreamSocket) === expectedParent) fail();
  return Object.freeze({
    runtimeKey, downstreamSocket, upstreamSocket, tenantUid, tenantGid, controllerUid, controllerGid, centralUid,
  });
}

class RuntimeAgentBridge extends ForwardingBridge {
  constructor(options) {
    super(configuration(options));
    this.server = null;
    this.bridgeRootIdentity = null;
    this.parentIdentity = null;
    this.socketFileIdentity = null;
  }

  validateUpstream() {
    const parent = path.dirname(this.config.upstreamSocket);
    identity(parent, { type: 'directory', uid: this.config.centralUid, mode: 0o700 });
    identity(this.config.upstreamSocket, { type: 'socket', uid: this.config.centralUid, mode: 0o600 });
  }

  validateParents() {
    const parent = path.dirname(this.config.downstreamSocket);
    if (!sameIdentity(this.bridgeRootIdentity, identity(HOST_BRIDGE_ROOT, {
      type: 'directory', uid: this.config.controllerUid, gid: this.config.controllerGid, mode: 0o711,
    })) || !sameIdentity(this.parentIdentity, identity(parent, {
      type: 'directory', uid: this.config.controllerUid, gid: this.config.controllerGid, mode: 0o711,
    }))) fail();
  }

  async closeServer() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise(resolve => {
      try { server.close(() => resolve()); } catch { resolve(); }
    });
  }

  async rollbackStart() {
    await this.closeServer();
    if (this.socketFileIdentity) {
      this.validateParents();
      if (!sameIdentity(this.socketFileIdentity, socketInode(this.config.downstreamSocket))) fail();
      fs.unlinkSync(this.config.downstreamSocket);
    }
    this.bridgeRootIdentity = null;
    this.parentIdentity = null;
    this.socketFileIdentity = null;
  }

  async start() {
    if (this.server) fail();
    const parent = path.dirname(this.config.downstreamSocket);
    this.bridgeRootIdentity = identity(HOST_BRIDGE_ROOT, {
      type: 'directory', uid: this.config.controllerUid, gid: this.config.controllerGid, mode: 0o711,
    });
    this.parentIdentity = identity(parent, {
      type: 'directory', uid: this.config.controllerUid, gid: this.config.controllerGid, mode: 0o711,
    });
    if (lexists(this.config.downstreamSocket)) {
      const before = identity(this.config.downstreamSocket, {
        type: 'socket', uid: this.config.tenantUid, gid: this.config.tenantGid, mode: 0o600,
      });
      if (await probeUnixSocket(this.config.downstreamSocket)) fail();
      const after = identity(this.config.downstreamSocket, {
        type: 'socket', uid: this.config.tenantUid, gid: this.config.tenantGid, mode: 0o600,
      });
      if (!sameIdentity(before, after) || !sameIdentity(this.bridgeRootIdentity, identity(HOST_BRIDGE_ROOT, {
        type: 'directory', uid: this.config.controllerUid, gid: this.config.controllerGid, mode: 0o711,
      })) || !sameIdentity(this.parentIdentity, identity(parent, {
        type: 'directory', uid: this.config.controllerUid, gid: this.config.controllerGid, mode: 0o711,
      }))) fail();
      fs.unlinkSync(this.config.downstreamSocket);
    }
    this.server = net.createServer(socket => this.accept(socket));
    this.server.maxConnections = 1;
    try {
      await new Promise((resolve, reject) => {
        const failed = error => { this.server.off('listening', ready); reject(error); };
        const ready = () => { this.server.off('error', failed); resolve(); };
        this.server.once('error', failed);
        this.server.once('listening', ready);
        this.server.listen(this.config.downstreamSocket);
      });
      this.socketFileIdentity = socketInode(this.config.downstreamSocket);
      this.validateParents();
      fs.chownSync(this.config.downstreamSocket, this.config.tenantUid, this.config.tenantGid);
      fs.chmodSync(this.config.downstreamSocket, 0o600);
      const hardened = identity(this.config.downstreamSocket, {
        type: 'socket', uid: this.config.tenantUid, gid: this.config.tenantGid, mode: 0o600,
      });
      if (!sameIdentity(this.socketFileIdentity, hardened)) fail();
      this.socketFileIdentity = hardened;
    } catch (error) {
      try { await this.rollbackStart(); } catch (cleanupError) { throw cleanupError; }
      throw error;
    }
  }

  async close() {
    if (!this.server) return;
    if (this.active) this.closeConnection(this.active);
    await this.closeServer();
    this.validateParents();
    if (!sameIdentity(this.socketFileIdentity, identity(this.config.downstreamSocket, {
      type: 'socket', uid: this.config.tenantUid, gid: this.config.tenantGid, mode: 0o600,
    }))) fail();
    fs.unlinkSync(this.config.downstreamSocket);
    this.bridgeRootIdentity = null;
    this.parentIdentity = null;
    this.socketFileIdentity = null;
  }
}

module.exports = { configuration, RuntimeAgentBridge };
