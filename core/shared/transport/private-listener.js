'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { privateDirectory, socketIdentity, sameIdentity, probeUnixSocket, MAX_UNIX_SOCKET_PATH_BYTES } = require('./unix-socket');

function fail() { throw new Error('private_listener_boundary'); }

// Publish a different path from the one passed to libuv: libuv unlinks its bind
// path on close without checking whether another listener has replaced it.
class PrivateListener {
  constructor(server, file) {
    if (!path.isAbsolute(file) || path.resolve(file) !== file || Buffer.byteLength(file) > 4096) fail();
    this.server = server; this.file = file; this.parent = null; this.identity = null; this.published = false;
  }

  validateParent() {
    const current = privateDirectory(path.dirname(this.file));
    if (this.parent && !sameIdentity(this.parent, current)) fail();
    return current;
  }

  async start() {
    this.parent = this.validateParent();
    let existing;
    try { existing = fs.lstatSync(this.file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) {
      const before = socketIdentity(this.file);
      if (await probeUnixSocket(this.file)) fail();
      this.validateParent();
      if (!sameIdentity(before, socketIdentity(this.file))) fail();
      fs.unlinkSync(this.file);
    }
    const bound = path.join(path.dirname(this.file), `.b-${crypto.randomBytes(8).toString('hex')}`);
    // DSP directories can exceed sockaddr_un's path limit. Bind through an
    // open directory descriptor while publishing/checking the canonical path.
    const parentFd = fs.openSync(path.dirname(this.file), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    this.parentFd = parentFd;
    const bindPath = Buffer.byteLength(bound) > MAX_UNIX_SOCKET_PATH_BYTES
      ? `/proc/self/fd/${parentFd}/${path.basename(bound)}` : bound;
    try {
      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(bindPath, () => { this.server.off('error', reject); resolve(); });
      });
      this.identity = socketIdentity(bound, { requireMode: false });
      this.validateParent();
      fs.chmodSync(bound, 0o600);
      fs.linkSync(bound, this.file);
      this.published = true;
      fs.unlinkSync(bound);
      if (!sameIdentity(this.identity, socketIdentity(this.file))) fail();
    } catch (error) { await this.close(); throw error; }
  }

  async close() {
    // Callers must destroy their accepted connections before closing.
    await new Promise(resolve => { try { this.server.close(resolve); } catch { resolve(); } });
    if (this.parentFd !== undefined) { fs.closeSync(this.parentFd); this.parentFd = undefined; }
    this.validateParent();
    if (this.published && this.identity) {
      let remaining;
      try { remaining = fs.lstatSync(this.file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (remaining) {
        if (!sameIdentity(this.identity, socketIdentity(this.file, { requireMode: false }))) fail();
        fs.unlinkSync(this.file);
      }
    }
    this.identity = null; this.published = false;
  }
}

module.exports = { PrivateListener };
